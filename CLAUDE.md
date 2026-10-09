# Vest Liquidity Scanner — agent rules

Companion to BookDepthIQ-Vest (`../BookDepthIQ-Vest`). Do not edit that project from here.

## Read-only — absolute

1. **No orders, no login, no account endpoints.** Public Vest REST and the public websocket only.
   Never add a token hook, an account read, or anything that writes to Vest.
2. **Never guess an endpoint.** Shapes come from live responses (noted in `src/vest/rest.ts`).
3. **Measure before choosing a threshold.** Score anchors in `src/scan/score.ts` came from a live
   scan of all 88 markets; retune them from recorded scans, not by feel.

## Engineering

- Wire symbol ≠ display symbol (`NQ-PERP` is `NDX-USD-PERP`). Resolve through `buildSymbolTable`.
- `src/vest/` and `src/book/stats.ts` are copied from BookDepthIQ-Vest; keep fixes in step.
- Logic lives in pure, tested modules (`src/scan/`); `web/` is the extension UI and engine.
- `npm test` and `npm run typecheck` must pass before a commit.
