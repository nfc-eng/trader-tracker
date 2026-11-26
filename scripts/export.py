#!/usr/bin/env python3
"""Export sanitized public data for the trader-tracker site.

Reads (box, private):  /workspace/trader/trades.jsonl, log.md, config.json
Writes (public):       site/data/trades.json, site/data/equity.json

Never publishes: account numbers, order/instrument/ref UUIDs, cash, buying power,
pending deposits, raw broker JSON, or shell commands.
"""
import json, re, sys
from datetime import datetime, timezone, timedelta
from pathlib import Path

TRADER = Path("/workspace/trader")
OUT = Path(__file__).resolve().parent / "site" / "data"
ET = timezone(timedelta(hours=-5))  # Nov–Mar is EST; ts in trades.jsonl carry their own offset

cfg = json.loads((TRADER / "config.json").read_text())
ACCOUNT = str(cfg.get("account_number", "")).strip()
STARTING_CAPITAL = float(cfg.get("starting_capital", 100.0))

UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", re.I)
SHORT_ID = re.compile(r"\b[0-9a-f]{8}\b")


def sanitize(text: str) -> str:
    t = text.replace("\\$", "$")
    # an early log line embedded the raw record command; keep only the echoed summary
    m = re.search(r'echo "- \$\(date[^)]*\)\s*(.*?)"\s*>>\s*log\.md', t)
    if m:
        t = m.group(1)
    else:
        t = re.split(r"\s*cd /workspace", t)[0]
    t = re.sub(r"\((open|close)\):\s*(before\.)?", "", t)
    t = re.sub(r"^\s*-?\s*\d{4}-\d{2}-\d{2}\s*", "", t)            # leading date
    t = re.sub(r"^\d{1,2}:\d{2}\s*M[SD]?T\s*", "", t)               # MST stamp
    t = re.sub(r"^\(?\d{1,2}:\d{2}\s*ET\)?\s*(\((regular|premarket|extended)\))?\s*:?\s*", "", t)
    t = re.sub(r"\((order|orders)[^)]*\)", "", t, flags=re.I)
    t = re.sub(r"\border\s+(" + UUID.pattern + r"|[0-9a-f]{8})\b", "order", t, flags=re.I)
    t = UUID.sub("", t)
    t = SHORT_ID.sub("", t)
    t = re.sub(r"[^.;]*\b(buying power|unleveraged|pending deposit|deposit)\b[^.;]*[.;]?", "", t, flags=re.I)
    t = re.sub(r",?\s*\bcash\s*~?\$?[\d.]+", "", t, flags=re.I)
    t = re.sub(r"\ball cash\b", "", t, flags=re.I)
    t = re.sub(r"\bEquity\s*~?\$?[\d.]+,?", "", t, flags=re.I)
    t = re.sub(r"Guard APPROVED[^.]*\.?", "", t)
    t = re.sub(r"\breviews? (clean|no checks)\.?", "", t, flags=re.I)
    t = re.sub(r"\b\d{7,}\b", "", t)
    t = re.sub(r"\(guard APPROVED,?\s*\)", "", t, flags=re.I)
    t = re.sub(r",?\s*\bid\s*\)", ")", t)
    t = re.sub(r"\bequity(\s+after)?\s*/?", "", t, flags=re.I)
    t = re.sub(r"\bbefore\.\s*", "", t)
    t = re.sub(r"\b(\d+\.\d+)0{2,}\b", r"\1", t)
    t = re.sub(r"\s\d+\.\d+/\d+\.\d+", "", t)
    t = re.sub(r"\bFILLED\b", "filled", t)
    t = re.sub(r"\bUSD(?=\d)", "$", t)
    t = re.sub(r"\(\s*\)", "", t)
    t = re.sub(r",\s*order,", ",", t)
    t = re.sub(r"\ball\s+(?=Day\b)", "", t)
    t = re.sub(r"(?<=\.)\s+\d+\.\d+\s+(?=[A-Z])", " ", t)
    if ACCOUNT:
        t = t.replace(ACCOUNT, "")
    t = re.sub(r"\s+([,.;])", r"\1", t)
    t = re.sub(r"([,.;])\1+", r"\1", t)
    t = re.sub(r"\s{2,}", " ", t).strip(" ,;.-")
    if len(t) > 300:
        t = t[:297].rsplit(" ", 1)[0] + "…"
    return t


def parse_log():
    """Return list of (iso_et, equity) snapshots and the raw lines."""
    text = (TRADER / "log.md").read_text()
    # some entries were appended with literal "\\n" separators on one physical line
    text = re.sub(r"\\n(?=- 20\d\d-)", "\n", text)
    text = re.sub(r"\s*(cd /workspace[^\n]*?)(?=- 20\d\d-\d\d-\d\d)", "\n", text)
    lines = text.splitlines()
    snaps = []
    for l in lines:
        d = re.search(r"(\d{4}-\d{2}-\d{2})", l)
        if not d or "day_open" in l:
            continue
        tm = re.search(r"(\d{1,2}):(\d{2})\s*ET\b", l)
        eq = re.search(r"[Ee]quity\s*~?\$?(\d{2,4}(?:\.\d+)?)", l)
        if not (tm and eq):
            continue
        v = float(eq.group(1))
        if not (STARTING_CAPITAL * 0.3 < v < STARTING_CAPITAL * 3):
            continue
        h, mi = int(tm.group(1)), int(tm.group(2))
        if h < 7 or h > 16:
            continue
        dt = datetime.fromisoformat(f"{d.group(1)}T{h:02d}:{mi:02d}:00").replace(tzinfo=ET)
        snaps.append((dt, round(v, 2)))
    # dedupe by minute, keep last
    by = {}
    for dt, v in snaps:
        by[dt] = v
    return sorted(by.items()), lines


def main():
    rows = [json.loads(l) for l in (TRADER / "trades.jsonl").read_text().splitlines() if l.strip()]
    # keep the latest record per order, only fills
    latest = {}
    for r in rows:
        latest[r["order_id"]] = r
    snaps, lines = parse_log()

    trades = []
    for r in sorted(latest.values(), key=lambda r: r["raw"].get("created_at") or r["ts"]):
        if r.get("state") not in ("filled", "partially_filled"):
            continue
        raw = r.get("raw", {})
        fill_utc = raw.get("last_transaction_at") or raw.get("created_at")
        t_et = datetime.fromisoformat(fill_utc.replace("Z", "+00:00")).astimezone(ET) if fill_utc else datetime.fromisoformat(r["ts"]).astimezone(ET)
        prefix = r["order_id"][:8]
        cands = [l for l in lines if prefix in l]
        clean = [l for l in cands if "/workspace" not in l]
        reason_line = (clean or cands or [""])[0]
        qty = float(r.get("filled_qty") or raw.get("cumulative_quantity") or 0)
        price = float(r.get("avg_price") or raw.get("average_price") or 0)
        trades.append({
            "time": t_et.isoformat(timespec="seconds"),
            "date": t_et.date().isoformat(),
            "symbol": r["symbol"],
            "side": r["side"],
            "shares": round(qty, 6),
            "price": round(price, 4),
            "notional": round(qty * price, 2),
            "order_type": raw.get("type", ""),
            "session": "pre-market" if raw.get("market_hours") == "extended_hours" else "regular",
            "sleeve": r.get("sleeve", ""),
            "reason": sanitize(reason_line) if reason_line else "",
        })
    for i, t in enumerate(trades, 1):
        t["n"] = i

    # equity series: starting point + log snapshots
    points = []
    first_day = trades[0]["date"] if trades else (snaps[0][0].date().isoformat() if snaps else None)
    for dt, v in snaps:
        if first_day and dt.date().isoformat() < first_day:
            continue
        points.append({"t": dt.isoformat(timespec="minutes"), "v": v})

    days = {}
    for p in points:
        days.setdefault(p["t"][:10], []).append(p["v"])
    daily, prev = [], STARTING_CAPITAL
    for d in sorted(days):
        close = days[d][-1]
        n = sum(1 for t in trades if t["date"] == d)
        daily.append({"date": d, "open": round(prev, 2), "close": close, "high": max(days[d]), "low": min(days[d]),
                      "pnl": round(close - prev, 2), "pnl_pct": round((close / prev - 1) * 100, 2), "trades": n})
        prev = close

    current = points[-1]["v"] if points else STARTING_CAPITAL
    wins = [d for d in daily if d["pnl"] > 0]
    equity = {
        "generated_at": datetime.now(timezone.utc).astimezone(ET).isoformat(timespec="minutes"),
        "starting_capital": STARTING_CAPITAL,
        "current_value": current,
        "as_of": points[-1]["t"] if points else None,
        "total_pnl": round(current - STARTING_CAPITAL, 2),
        "total_pnl_pct": round((current / STARTING_CAPITAL - 1) * 100, 2),
        "stats": {
            "trading_days": len(daily),
            "trades": len(trades),
            "green_days": len(wins),
            "best_day": max(daily, key=lambda d: d["pnl"])["date"] if daily else None,
            "worst_day": min(daily, key=lambda d: d["pnl"])["date"] if daily else None,
            "max_value": max((p["v"] for p in points), default=current),
            "min_value": min((p["v"] for p in points), default=current),
            "volume": round(sum(t["notional"] for t in trades), 2),
        },
        "daily": daily,
        "points": points,
    }

    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "trades.json").write_text(json.dumps({"trades": trades}, indent=1))
    (OUT / "equity.json").write_text(json.dumps(equity, indent=1))

    # safety check
    blob = (OUT / "trades.json").read_text() + (OUT / "equity.json").read_text()
    bad = []
    if ACCOUNT and ACCOUNT in blob: bad.append("account number")
    if UUID.search(blob): bad.append("uuid")
    for w in ("buying_power", "account_number", "deposit", "guard.py", "/workspace", "ref_id", "instrument"):
        if w in blob.lower(): bad.append(w)
    if re.search(r"cash\W{0,3}\$?\d", blob, re.I): bad.append("cash amount")
    if bad:
        print("SANITIZE FAIL:", bad, file=sys.stderr); sys.exit(2)
    print(f"ok: {len(trades)} trades, {len(points)} equity points, {len(daily)} days, value {current} ({equity['total_pnl']:+})")


if __name__ == "__main__":
    main()
