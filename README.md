# Vest Liquidity Scanner

A Chrome extension that finds the **Vest Markets** perps with real trading right now. It watches
all of Vest's markets at once, ranks them by actual prints (not by how full the book looks), and
can alert you when a market wakes up.

**Read-only:** public Vest data only. No login, no account access, no orders. A companion to
[BookDepthIQ-Vest](https://github.com/autopilotaitech/BookDepthIQ-Vest), the trading panel.

> **Beta.** Scores use starting weights that will be tuned against recorded scans.

## Why it ranks trades, not the book

A 30-second scan of all 88 Vest markets (2026-10-09) found every book updating but **84 of 88
markets with zero trades**: Vest's market maker quotes everything. NQ-PERP traded about
$1.6M a minute; most markets traded nothing. A full-looking book proves nothing on Vest, so the
scanner ranks on prints and flags books that move with no trades as **QUOTED**.

## Install

```bash
npm install
npm run build        # creates dist/ — load it with "Load unpacked"
```

1. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, pick `dist`.
2. Click the toolbar icon. The scanner opens in its own window and scans while it is open.

## What you see

| Column | Meaning |
|---|---|
| **Session** | Vest's own session for the market right now (regular, after hours, overnight…), from its market-hours schedule. "Open now only" hides closed markets. |
| **$ / min**, **Trades / min** | Real trading over the window (1, 5 or 15 min). |
| **Spread bps** | Median spread in basis points of mid: your cost to cross. |
| **Top-5 depth** | Median $ resting in the top 5 levels (smaller side): size you can trade without walking the book. |
| **Last 60 min** | $ traded per minute, as a sparkline. |
| **24 h vol** | Vest's 24-hour volume. |
| **Score** | 0–100: $/min 40%, trades/min 20%, cost 20%, depth 10%, room to move (range ÷ spread) 10%, each on a log scale. Markets with no prints are capped at 15 and tagged **QUOTED**. ≥ 70 green, 40–69 amber. |

**Catch volatility, skip chop.** Each market also gets a regime from bars of its price path (book
mid + trades). The **window** sets the speed:

| Window | Bars | Vol × compares | Trend over | Breakout vs |
|---|---|---|---|---|
| **1 min** (scalp, default) | 15 s | last 1 min vs 15 min | 2 min | prior 15 min |
| 5 min | 1 min | last 5 vs 60 min | 15 min | prior 60 min |
| 15 min | 1 min | last 15 vs 60 min | 30 min | prior 60 min |

Liquidity (can you get filled?) always uses at least the last 5 minutes: Vest's tape is thin, so a
one-minute read would call good markets dead between prints.

| Column | Meaning |
|---|---|
| **Opportunity** | 0–100: liquidity × volatility expansion × clean direction. The default sort. |
| **State** | **▲/▼ BREAKOUT** (beyond its 60-min high/low, vol ≥ 1.5×, clean move) and **TRENDING** (efficiency ≥ 0.5, vol ≥ 1.2×) are the trades; **EXPANDING** (vol ≥ 1.5×, no direction yet) is a watch; **CHOP** (efficiency < 0.3) and **DEAD** (liquidity < 40) are skips. |
| **Vol ×** | recent average bar range ÷ the longer baseline (see the table above). 1.0 = normal. |
| **Trend** | net move ÷ distance travelled (100% = straight line, 0% = chop), with direction. |
| **RVOL** | $/min now ÷ this market's usual $/min for this hour (needs 30 recorded minutes for the hour; **Backfill last 24 h** gives it at once). |

- **Hide chop** removes CHOP and DEAD rows. **Alerts** fire when a liquid market enters
  BREAKOUT or TRENDING.
- The cut-offs are starting values. The scanner records these numbers every minute for the top 8
  markets (2 days); **Copy as CSV** in the footer exports them so the cut-offs can be tuned.

- **Filter** by index, crypto, stocks, ETFs, commodities or FX. **Sort** by any column.
- **Click a row** to open that market on Vest.
- **Liquid by hour (Chicago):** average $ per minute per hour of the day for the top 12 markets.
  It builds while the window is open; **Backfill last 24 h** fills it from Vest's trade history.

## How it works

One public websocket carries depth and trades for every market (≤ 80 streams per subscribe).
REST supplies the market list (`/v3/exchangeInfo`), 24 h volume (`/v3/ticker/24hr`), sessions
(`POST /v4/market-hours`) and recent trades for warm-up (`/v3/trades?endTime=…`). The Vest client
code (`src/vest/`, `src/book/stats.ts`) comes from BookDepthIQ-Vest.

```bash
npm test             # metrics, score, sessions, hourly history
npm run typecheck
```

## License

MIT. Not affiliated with or endorsed by Vest Markets.
