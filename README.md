# Trader Bot — Live Trade Tracker

**Live:** https://trader-tracker-murex.vercel.app

Public, static site that follows an experimental AI trading bot running a ~$100 Robinhood account in TQQQ / SQQQ.

- **Replay chart**: press Play to watch the account value move intraday (Day) or across a week (Week). Each fill pops in as a marker (▲ buy / ▼ sell, cyan = TQQQ, purple = SQQQ) with the bot's own reasoning.
- Account value, total P&L vs the $100 starting deposit, daily P&L, summary stats, and every trade by day.

## How it works

No build step. `index.html` + `app.js` + `style.css` read two JSON files:

- `data/equity.json`: starting capital, current value, daily open/close/P&L, intraday value snapshots
- `data/trades.json`: fills (time ET, symbol, side, shares, price, notional, order type, session) plus a short sanitized `reason`

Both are generated off-repo by `scripts/export.py` from the bot's private logs and committed after each trading day. Vercel redeploys on every push to `main`.

**What's never published:** account numbers, broker order/instrument IDs, cash, buying power, deposits, or raw broker data.

*Not financial advice. Small experimental account; 3× leveraged ETFs are very risky.*
