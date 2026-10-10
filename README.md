# Vest funding history

Collected automatically by the `Collect funding` workflow on `main`, twice an hour (:05 and :55
UTC), 24/7. Vest publishes only the current funding rate and open interest, so this branch is the
history. One CSV per month in `funding/`:

`time_utc, symbol, display, funding_per_h, mark, index, premium_bps, long_oi, short_oi`

- `funding_per_h`: Vest's `oneHrFundingRate` (fraction per hour; + longs pay shorts).
- `premium_bps`: (mark − index) ÷ index × 10,000.
- `long_oi`, `short_oi`: Vest `/v3/oi`, in units of the market.

Public data only. Not affiliated with Vest Markets.
