#!/usr/bin/env python3
"""Build the public data files for the tracker site from the bot's private records.

Usage:
  TRADER_DIR=/path/to/bot python3 scripts/export.py [--out site/data]
  python3 scripts/export.py --trader-dir /path/to/bot

Inputs (private, inside TRADER_DIR): trades.jsonl, log.md, config.json,
research/history/<date>.md (optional). Only what the bot itself logged is used.

Optional richer per-trade context: if a trades.jsonl record carries a "why" object
  {"reason": str, "plain": str, "signals": {name: number|str}, "score": num,
   "news": [{"headline": str, "source": str, "url": str, "time": iso}]}
it is sanitized and published as trade["logged"] (and "plain" overrides the
auto-translated sentence).
Outputs (public): data/trades.json, data/equity.json

Never published: account numbers, order/instrument/ref ids, cash, buying power,
deposits, raw broker JSON, shell commands or file paths.
"""
import argparse, json, os, re, sys
from datetime import datetime, timezone, timedelta
from pathlib import Path

ap = argparse.ArgumentParser()
ap.add_argument("--trader-dir", default=os.environ.get("TRADER_DIR"))
ap.add_argument("--out", default=str(Path(__file__).resolve().parent.parent / "data"))
ARGS = ap.parse_args()
if not ARGS.trader_dir:
    sys.exit("set TRADER_DIR or pass --trader-dir")
TRADER = Path(ARGS.trader_dir)
OUT = Path(ARGS.out)
ET = timezone(timedelta(hours=-5))  # Nov-Mar is EST; broker timestamps carry their own offset

cfg = json.loads((TRADER / "config.json").read_text())
ACCOUNT = str(cfg.get("account_number", "")).strip()
STARTING_CAPITAL = float(cfg.get("starting_capital", 100.0))

UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", re.I)
SHORT_ID = re.compile(r"\b[0-9a-f]{8}\b")
PATHLIKE = re.compile(r"(?:/[\w.-]+){2,}")


def sanitize(text: str) -> str:
    t = text.replace("\\$", "$")
    m = re.search(r'echo "- \$\(date[^)]*\)\s*(.*?)"\s*>>\s*log\.md', t)
    if m:
        t = m.group(1)
    else:
        t = re.split(r"\s*cd /", t)[0]
    t = PATHLIKE.sub("", t)
    t = re.sub(r"\((open|close)\):\s*(before\.)?", "", t)
    t = re.sub(r"^\s*-?\s*\d{4}-\d{2}-\d{2}\s*", "", t)
    t = re.sub(r"^\d{1,2}:\d{2}\s*M[SD]?T\s*", "", t)
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
    t = re.sub(r"\bguard(\.py)?\b", "", t, flags=re.I)
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
        t = t[:297].rsplit(" ", 1)[0] + "\u2026"
    return t


# ---------------------------------------------------------------- plain English
def _num(pat, s, g=1):
    m = re.search(pat, s, re.I)
    return float(m.group(g)) if m else None


def _pct(v):
    return f"{abs(v):.1f}".rstrip("0").rstrip(".") + "%"


def plain(t, raw):
    """Translate the bot's shorthand note into one or two plain sentences."""
    r = raw.lower()
    sym, buy = t["symbol"], t["side"] == "buy"
    bet = "rise" if sym == "TQQQ" else "fall"
    out = []
    if buy:
        if "forced" in r:
            out.append(f"Made a small ${t['notional']:.0f} trade because the bot's rules call for at least one trade a day, "
                       "and its signals weren't strong enough for a normal one.")
        else:
            verb = "Added to" if re.search(r"\b(re-)?add\b", r) else "Bought"
            score = _num(r"score\s*([+-]?\d*\.\d+)", r)
            strength = "" if score is None else ("strongly " if abs(score) >= 0.6 else "mildly " if abs(score) < 0.4 else "")
            dirw = "up" if sym == "TQQQ" else "down"
            ev = []
            if "pce" in r or "gdp" in r: ev.append("it was reacting to the morning's inflation and GDP reports")
            if "new low" in r: ev.append("the Nasdaq had just hit a new low for the day")
            elif "breaking lower" in r: ev.append("the Nasdaq was breaking lower")
            elif re.search(r"new (day|session) high", r): ev.append("the Nasdaq had just hit a new high for the day")
            if "failed-bounce" in r: ev.append("a bounce had just stalled where the bot's research expected it to")
            if "bear trend" in r and not ev: ev.append("the trend was down")
            if ("trend15m" in r or "bull" in r) and sym == "TQQQ" and not ev: ev.append("the short-term trend was up")
            lead = f"{verb} {sym}, a bet that the Nasdaq would {bet}. The bot's signals {strength}pointed {dirw}"
            out.append(lead + (": " + "; ".join(ev) + "." if ev else "."))
            agree = ("bearish" if sym == "SQQQ" else "bullish")
            other = "bullish" if agree == "bearish" else "bearish"
            mult = _num(r"x(\d\.\d+)", r)
            if re.search(r"research (flipped |brief )?" + agree, r) or ("bias -1" in r and sym == "SQQQ"):
                out.append("The bot's news research agreed" + (", so it bought a little more." if mult and mult > 1 else "."))
            elif re.search(r"research[^.;]*" + other, r) or "size reduced" in r:
                out.append("Its news research leaned the other way" + (", so it bought less than usual." if (mult and mult < 1) or "reduced" in r else "."))
            if "high-fear" in r: out.append("Markets were jittery, so it kept the size small.")
        stop = _num(r"stop\s*-?(\d+(?:\.\d+)?)\s*%", r)
        tp = _num(r"(?:tp|target)\s*(\d+(?:\.\d+)?)\s*%", r)
        if stop and tp:
            s = f"It planned to sell if the trade lost {_pct(stop)} or gained {_pct(tp)}"
            if "flat by" in r:
                s += ", and to be out before the close"
                if "nvda" in r: s += " (Nvidia reported earnings that night)"
            out.append(s + ".")
        return " ".join(out)

    # sells
    gain = _num(r"(?:pnl\s*|trim[^.]*?|\()\+(\d+(?:\.\d+)?)%", r) or _num(r"\+(\d+(?:\.\d+)?)%", r)
    if re.search(r"\bstop\b", r) and re.search(r"stop (sell|exit|hit)|tactical stop|breached|past -", r):
        loss = _num(r"-(\d+(?:\.\d+)?)%", r)
        stop = _num(r"stop -?(\d+(?:\.\d+)?)%", r)
        if re.search(r"past -(\d+(?:\.\d+)?)% stop", r): stop = _num(r"past -(\d+(?:\.\d+)?)% stop", r)
        s = f"Sold {sym} because it fell"
        if loss: s += f" {_pct(loss)}"
        s += " from its buy price"
        if stop and loss and loss - stop > 0.05: s += f", past its {_pct(stop)} stop-loss"
        else: s += ", hitting its stop-loss"
        out.append(s + ".")
        if sym == "SQQQ" and "bounc" in r: out.append("The Nasdaq had bounced back up.")
        if sym == "TQQQ" and ("fell" in r or "faded" in r): out.append("The Nasdaq had turned lower.")
        if "fed speech" in r: out.append("A Fed speech was also coming up.")
    elif "take profit" in r or "take-profit" in r or ("trim" in r and gain):
        part = "half of its" if "half" in r else "some of its"
        s = f"Sold {part} {sym} to lock in a gain"
        if gain: s += f" of about {_pct(gain)}"
        if "take" in r: s += ", past its 3% profit target"
        elif "conviction fades" in r: s += ", as the signal got weaker"
        else: s += ", taking profits in steps"
        out.append(s + ". It kept the rest in case the move continued.")
    elif re.search(r"score (faded|flipped)|-> exit|target cash|discretionary", r):
        s = f"Sold {sym} because the bot's signals "
        s += "flipped" if "flipped" in r else "faded"
        if "bounc" in r and sym == "SQQQ": s += " as the Nasdaq bounced back up"
        elif sym == "TQQQ": s += " as the Nasdaq lost momentum"
        out.append(s + ", so the reason for the trade was gone.")
        if "nvda" in r: out.append("It also wanted to be out before Nvidia's earnings report.")
    elif re.search(r"\beod\b|flatten|never overnight|15:50", r):
        s = "Sold everything before the close: the bot doesn't hold its short-term trades overnight"
        if "thanksgiving" in r: s += ", and markets were about to close for Thanksgiving"
        out.append(s + ".")
    else:
        out.append(f"Sold {sym}.")
    if "news scan" in r and "no new shock" in r:
        out.append("A quick news check found nothing that changed the plan.")
    return " ".join(out)


# ---------------------------------------------------------------- log + news
def parse_log():
    text = (TRADER / "log.md").read_text()
    text = re.sub(r"\\n(?=- 20\d\d-)", "\n", text)
    text = re.sub(r"\s*(cd /[^\n]*?)(?=- 20\d\d-\d\d-\d\d)", "\n", text)
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
    by = {}
    for dt, v in snaps:
        by[dt] = v
    return sorted(by.items()), lines


OUTLETS = ["CNBC", "WSJ", "Bloomberg", "FT", "Reuters", "Axios", "CNN", "AP", "Barron's", "MarketWatch", "Yahoo", "Politico", "NYT"]


def _impact(s):
    s = s.strip().lower()
    if not s: return ""
    if re.match(r"^(\+|bullish|positive|ai-demand positive|supportive)", s) or s.startswith("+"): return "good"
    if re.match(r"^(−|-|bearish|negative|hawkish|mildly negative|mild negative|mild ai|risk-off|overhang|export|headline risk|ai sentiment drag|mild ai-sentiment negative|negative tail)", s): return "bad"
    return "neutral"


def bot_news():
    """News the bot wrote into its own research notes, by date. Items: time, text, source, impact, seen (minute)."""
    out = {}
    hist = TRADER / "research" / "history"
    if not hist.is_dir():
        return out
    for f in sorted(hist.glob("20*.md")):
        day = f.stem
        seen_min, in_news, seen_text, items = 0, False, set(), []
        for line in f.read_text().splitlines():
            h = re.match(r"^# .*?(\d{1,2}):(\d{2}) ET", line)
            if h:
                seen_min = int(h.group(1)) * 60 + int(h.group(2)); in_news = False; continue
            if line.startswith("## "):
                in_news = line.lower().startswith("## news"); continue
            if not in_news:
                continue
            tm, text, imp = "", "", ""
            row = re.match(r"^\|\s*([^|]*)\|\s*([^|]+)\|\s*([^|]*)\|", line)
            if row and not re.match(r"^\|\s*(time|-)", line, re.I) and "---" not in line:
                tm, text, imp = row.group(1).strip(), row.group(2).strip(), row.group(3).strip()
            else:
                b = re.match(r"^-\s+(.*)", line)
                if not b: continue
                body = b.group(1)
                mt = re.match(r"^((?:[A-Z][a-z]{2}\s+)?~?\d{1,2}[:/]\d{2}(?:[–-]\d{1,2}:\d{2})?(?:\s*close)?|~?\d{1,2}:\d{2}|Pre-open|Overnight|Tue PM|Mon PM)\s*:?\s+", body)
                if mt: tm, body = mt.group(1), body[mt.end():]
                mi = re.search(r"\s+(?:Impact:\s*)?([−+]|[−+0]/[−+0]|0 to slightly −)\.?\s*(\(.*\))?$", body)
                if mi: imp, body = mi.group(1), body[:mi.start()]
                body = re.sub(r"\.?\s*Impact:\s*([^.]*)\.?$", lambda m: (imp := m.group(1)) and "", body) if "Impact:" in body else body
                text = body.strip().rstrip(".")
            text = sanitize(text)
            if not text or len(text) < 12: continue
            key = re.sub(r"\W+", "", text.lower())[:60]
            if key in seen_text: continue
            seen_text.add(key)
            src = next((o for o in OUTLETS if re.search(r"(^|[\s(/])" + re.escape(o) + r"\b", text)), "")
            items.append({"time": tm.replace("~", "\u2248"), "text": text[:240], "source": src,
                          "impact": _impact(imp), "seen": seen_min})
        out[day] = items
    return out


def logged_context(w):
    """Sanitize an optional structured 'why' object logged by the bot with a fill."""
    if not isinstance(w, dict):
        return None
    out = {}
    for k in ("reason", "plain"):
        if isinstance(w.get(k), str) and w[k].strip():
            out[k] = sanitize(w[k])
    if isinstance(w.get("score"), (int, float)):
        out["score"] = round(float(w["score"]), 3)
    sig = w.get("signals")
    if isinstance(sig, dict):
        out["signals"] = {str(k)[:40]: (round(v, 3) if isinstance(v, (int, float)) else sanitize(str(v))[:60])
                          for k, v in list(sig.items())[:12]}
    news = []
    for n in (w.get("news") or [])[:6]:
        if not isinstance(n, dict) or not n.get("headline"): continue
        url = str(n.get("url") or "")
        news.append({"headline": sanitize(str(n["headline"]))[:200], "source": sanitize(str(n.get("source") or ""))[:40],
                     "url": url if re.match(r"^https?://", url) else "", "time": str(n.get("time") or "")[:25]})
    if news: out["news"] = news
    return out or None


# ---------------------------------------------------------------- round trips
def round_trips(trades):
    lots, rts = {}, []
    for t in trades:
        q = lots.setdefault(t["symbol"], [])
        if t["side"] == "buy":
            q.append({"n": t["n"], "time": t["time"], "left": t["shares"], "price": t["price"]})
            continue
        need, cost, used, first = t["shares"], 0.0, [], None
        while need > 1e-7 and q:
            lot = q[0]; take = min(lot["left"], need)
            cost += take * lot["price"]; need -= take; lot["left"] -= take
            first = first or lot["time"]
            if lot["n"] not in used: used.append(lot["n"])
            if lot["left"] <= 1e-7: q.pop(0)
        sold = t["shares"] - max(need, 0)
        proceeds = sold * t["price"]
        prev = rts[-1] if rts else None
        # merge legs of the same exit decision (same symbol, within 90 s)
        if prev and prev["symbol"] == t["symbol"] and abs(datetime.fromisoformat(t["time"]).timestamp() - datetime.fromisoformat(prev["exit_time"]).timestamp()) <= 90:
            prev["shares"] += sold; prev["cost"] += cost; prev["proceeds"] += proceeds
            prev["exit_n"].append(t["n"]); prev["entry_n"] += [n for n in used if n not in prev["entry_n"]]
            continue
        rts.append({"symbol": t["symbol"], "entry_time": first or t["time"], "exit_time": t["time"], "shares": sold,
                    "cost": cost, "proceeds": proceeds, "entry_n": used, "exit_n": [t["n"]]})
    for i, r in enumerate(rts, 1):
        r["id"] = i
        r["pnl"] = round(r["proceeds"] - r["cost"], 2)
        r["pnl_pct"] = round((r["proceeds"] / r["cost"] - 1) * 100, 2) if r["cost"] else 0
        r["hold_min"] = round((datetime.fromisoformat(r["exit_time"]) - datetime.fromisoformat(r["entry_time"])).total_seconds() / 60)
        r["shares"] = round(r["shares"], 6); r["cost"] = round(r["cost"], 2); r["proceeds"] = round(r["proceeds"], 2)
        r["date"] = r["exit_time"][:10]
    open_pos = []
    for sym, q in lots.items():
        sh = sum(l["left"] for l in q)
        if sh > 1e-5:
            open_pos.append({"symbol": sym, "shares": round(sh, 6),
                             "avg_price": round(sum(l["left"] * l["price"] for l in q) / sh, 4),
                             "cost": round(sum(l["left"] * l["price"] for l in q), 2), "since": q[0]["time"]})
    return rts, open_pos


def main():
    rows = [json.loads(l) for l in (TRADER / "trades.jsonl").read_text().splitlines() if l.strip()]
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
        clean = [l for l in cands if not re.search(r"cd /|\.py\b", l)]
        reason_line = (clean or cands or [""])[0]
        qty = float(r.get("filled_qty") or raw.get("cumulative_quantity") or 0)
        price = float(r.get("avg_price") or raw.get("average_price") or 0)
        t = {
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
            "details": sanitize(reason_line) if reason_line else "",
        }
        t["why"] = plain(t, t["details"]) if t["details"] else ""
        lg = logged_context(r.get("why"))
        if lg:
            t["logged"] = lg
            if lg.get("plain"): t["why"] = lg["plain"]
            if not t["details"] and lg.get("reason"): t["details"] = lg["reason"]
        trades.append(t)
    for i, t in enumerate(trades, 1):
        t["n"] = i

    rts, open_pos = round_trips(trades)
    by_n = {t["n"]: t for t in trades}
    for rt in rts:
        rt["entry_why"] = by_n[rt["entry_n"][0]]["why"] if rt["entry_n"] else ""
        rt["exit_why"] = by_n[rt["exit_n"][0]]["why"]
        for n in rt["exit_n"]:
            by_n[n]["result"] = {"pnl": rt["pnl"], "pnl_pct": rt["pnl_pct"], "rt": rt["id"]}

    bn = bot_news()
    news = {}
    for d in sorted({t["date"] for t in trades} | set(bn)):
        news[d] = {"bot": bn.get(d, [])}
    for t in trades:
        m = int(t["time"][11:13]) * 60 + int(t["time"][14:16])
        items = [i for i in news.get(t["date"], {}).get("bot", []) if i["seen"] <= m]
        t["news"] = [bn_i for bn_i in items[-3:]]
        t["news"] = [{"time": i["time"], "text": i["text"], "source": i["source"], "impact": i["impact"]} for i in t["news"]]

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
    won = [r for r in rts if r["pnl"] > 0]
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
            "round_trips": len(rts),
            "winning_round_trips": len(won),
        },
        "daily": daily,
        "points": points,
    }

    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "trades.json").write_text(json.dumps({"trades": trades, "round_trips": rts, "open_positions": open_pos, "news": news}, indent=1, ensure_ascii=False))
    (OUT / "equity.json").write_text(json.dumps(equity, indent=1))

    blob = (OUT / "trades.json").read_text() + (OUT / "equity.json").read_text()
    bad = []
    if ACCOUNT and ACCOUNT in blob: bad.append("account number")
    if str(TRADER.resolve()) in blob or str(TRADER) in blob: bad.append("private path")
    if UUID.search(blob): bad.append("uuid")
    for w in ("buying_power", "account_number", "deposit", "ref_id", "instrument"):
        if w in blob.lower(): bad.append(w)
    if re.search(r"cash\W{0,3}\$?\d", blob, re.I): bad.append("cash amount")
    if bad:
        print("SANITIZE FAIL:", bad, file=sys.stderr); sys.exit(2)
    nb = sum(len(v["bot"]) for v in news.values()); nl = sum(1 for t in trades if t.get("logged"))
    print(f"ok: {len(trades)} trades, {len(rts)} round trips, {len(open_pos)} open, {len(points)} points, "
          f"{len(daily)} days, {nb} bot news notes, {nl} trades with logged context, value {current} ({equity['total_pnl']:+})")


if __name__ == "__main__":
    main()
