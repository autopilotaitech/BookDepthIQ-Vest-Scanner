// Liquidity score 0–100 and market sessions. Pure: no I/O.
//
// Starting weights (plan, 2026-10-09): $ per minute 40%, trades per minute 20%, cost (spread) 20%,
// top-5 depth 10%, room to move (range ÷ spread) 10%. Each input is mapped onto 0–1 on a log scale
// between two anchors. Anchors come from a 30-second scan of all 88 Vest markets on 2026-10-09
// (NQ-PERP $1.6M/min, 16 trades/min, 0.32 bps, $555k top-5; idle markets $0 and 4–135 bps). They
// are starting points to be tuned against a week of recorded scans.

import type { MarketHoursAsset } from '../vest/rest.js';
import type { Summary } from './metrics.js';

export const WEIGHTS = { usd: 0.4, trades: 0.2, cost: 0.2, depth: 0.1, room: 0.1 } as const;

export const ANCHORS = {
  usdPerMin: [1_000, 1_000_000],
  tradesPerMin: [0.5, 20],
  spreadBps: [0.3, 30], // lower is better
  top5Usd: [20_000, 1_000_000],
  room: [1, 20], // range ÷ spread
} as const;

/** log-scale position of x between lo and hi, clamped to 0–1 (≤ 0 → 0). */
export function logPos(x: number | undefined, lo: number, hi: number): number {
  if (x === undefined || !(x > 0)) return 0;
  return Math.max(0, Math.min(1, Math.log(x / lo) / Math.log(hi / lo)));
}

/** A market with a moving book but no prints never scores above this. */
export const QUOTED_CAP = 15;

export function liquidityScore(s: Summary): number {
  const room = s.spreadBps && s.spreadBps > 0 ? s.rangeBps / s.spreadBps : 0;
  const cost = s.spreadBps === undefined ? 0 : 1 - logPos(s.spreadBps, ANCHORS.spreadBps[0], ANCHORS.spreadBps[1]);
  const v =
    WEIGHTS.usd * logPos(s.usdPerMin, ...ANCHORS.usdPerMin) +
    WEIGHTS.trades * logPos(s.tradesPerMin, ...ANCHORS.tradesPerMin) +
    WEIGHTS.cost * cost +
    WEIGHTS.depth * logPos(s.top5Usd, ...ANCHORS.top5Usd) +
    WEIGHTS.room * logPos(room, ...ANCHORS.room);
  const score = Math.round(v * 100);
  return s.quoted || s.tradesPerMin === 0 ? Math.min(score, QUOTED_CAP) : score;
}

export interface SessionNow {
  /** Vest's session label: regular, after_hours, overnight, pre_market, … or 'unknown'. */
  session: string;
  open: boolean;
  /** When this session state ends (ms), if known. */
  untilMs?: number;
}

/** The session state covering `now` for an asset; unknown (treated as open) when not covered. */
export function sessionAt(a: MarketHoursAsset | undefined, now: number): SessionNow {
  const p = a?.periods.find((x) => x.fromMs <= now && now < x.toMs);
  if (!p) return { session: 'unknown', open: true };
  const session = p.state.session && p.state.session !== 'unspecified' ? p.state.session : p.state.tradingStatus === 'OPEN' ? 'open' : 'closed';
  return { session, open: p.state.tradingStatus === 'OPEN', untilMs: p.toMs };
}

export type Category = 'index' | 'crypto' | 'stock' | 'etf' | 'commodity' | 'fx' | 'other';

/** Category from exchangeInfo `categories` first, then the market-hours asset type. */
export function categoryOf(categories: string[] | undefined, assetType: string | undefined): Category {
  const c = (categories ?? []).map((x) => x.toLowerCase());
  if (c.includes('etf')) return 'etf';
  if (c.includes('commodity')) return 'commodity';
  if (c.includes('index')) return 'index';
  if (c.includes('stock')) return 'stock';
  switch ((assetType ?? '').toUpperCase()) {
    case 'CRYPTO':
      return 'crypto';
    case 'INDEX':
      return 'index';
    case 'EQUITY':
      return 'stock';
    case 'COMMODITY':
      return 'commodity';
    case 'FX':
    case 'FOREX':
    case 'CURRENCY':
      return 'fx';
    default:
      return 'other';
  }
}

/** Alert edge: true only when the score crosses up through the threshold (not while it stays above). */
export function crossedUp(prev: number | undefined, next: number | undefined, threshold: number): boolean {
  return next !== undefined && next >= threshold && (prev === undefined || prev < threshold);
}
