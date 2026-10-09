// Volatility regime: is a market waking up, and is it going anywhere? Pure: no I/O.
//
// Built on 1-minute bars of the market's price path (book mid + trade prices, so quiet Vest
// markets whose market maker tracks the underlying still have a path).
//   vol×        = ATR of the last 5 bars ÷ ATR of the last 60   (each market against itself)
//   efficiency  = |net move| ÷ total distance over the last 15 bars   (1 = clean trend, 0 = chop)
//   RVOL        = $/min now ÷ this market's usual $/min for this hour
//   breakout    = price beyond the high/low of the 60 bars before the last 5
// Thresholds below are STARTING VALUES (owner's plan, 2026-10-09). The scanner records these
// numbers; retune the cut-offs from where real breakouts and chop fall (CLAUDE.md: measure first).

export interface Bar {
  t: number; // minute start (ms)
  o: number;
  h: number;
  l: number;
  c: number;
}

export const REGIME = {
  fastBars: 5,
  slowBars: 60,
  effBars: 15,
  minBars: 20, // fewer complete bars than this → not enough history to judge
  volExpanding: 1.5,
  volTrending: 1.2,
  effTrend: 0.5,
  effChop: 0.3,
  rvolHot: 1.5,
  minLiquidity: 40, // liquidity score below this → DEAD (can't fill it)
} as const;

/** Average true range of the last `n` bars (each bar's range, extended to the previous close). */
export function atr(bars: Bar[], n: number): number | undefined {
  if (bars.length < n || n <= 0) return undefined;
  const last = bars.slice(-n);
  const firstIdx = bars.length - n;
  let sum = 0;
  last.forEach((b, i) => {
    const prev = bars[firstIdx + i - 1];
    const tr = prev ? Math.max(b.h - b.l, Math.abs(b.h - prev.c), Math.abs(b.l - prev.c)) : b.h - b.l;
    sum += tr;
  });
  return sum / n;
}

/** Kaufman efficiency over the last `n` bars: signed (+ up, − down), magnitude 0–1. */
export function efficiency(bars: Bar[], n: number): number | undefined {
  if (bars.length < n + 1) return undefined;
  const closes = bars.slice(-(n + 1)).map((b) => b.c);
  let path = 0;
  for (let i = 1; i < closes.length; i++) path += Math.abs(closes[i]! - closes[i - 1]!);
  const net = closes[closes.length - 1]! - closes[0]!;
  return path > 0 ? net / path : 0;
}

/** +1 above the prior 60-bar high, −1 below its low, else 0 (prior = before the last `fast` bars). */
export function breakout(bars: Bar[], fast: number, slow: number): -1 | 0 | 1 {
  if (bars.length < fast + 10) return 0;
  const prior = bars.slice(Math.max(0, bars.length - fast - slow), bars.length - fast);
  const recent = bars.slice(-fast);
  const hi = Math.max(...prior.map((b) => b.h));
  const lo = Math.min(...prior.map((b) => b.l));
  const rHi = Math.max(...recent.map((b) => b.h));
  const rLo = Math.min(...recent.map((b) => b.l));
  if (rHi > hi && rLo >= lo) return 1;
  if (rLo < lo && rHi <= hi) return -1;
  return 0;
}

export type RegimeState = 'breakout' | 'trending' | 'expanding' | 'chop' | 'quiet' | 'dead' | 'warming';

export interface Regime {
  state: RegimeState;
  /** +1 up, −1 down, 0 none. */
  dir: -1 | 0 | 1;
  volRatio: number | undefined;
  eff: number | undefined; // signed
  rvol: number | undefined;
  breakout: -1 | 0 | 1;
  /** 0–100: liquidity × volatility expansion × cleanliness. */
  opportunity: number;
}

export function regime(bars: Bar[], liquidity: number | undefined, usdPerMin: number, hourAvgUsdPerMin: number | undefined): Regime {
  const fast = atr(bars, REGIME.fastBars);
  const slow = atr(bars, Math.min(REGIME.slowBars, bars.length));
  const volRatio = fast !== undefined && slow !== undefined && slow > 0 ? fast / slow : undefined;
  const eff = efficiency(bars, REGIME.effBars);
  const rvol = hourAvgUsdPerMin && hourAvgUsdPerMin > 0 ? usdPerMin / hourAvgUsdPerMin : undefined;
  const bo = breakout(bars, REGIME.fastBars, REGIME.slowBars);
  const absEff = eff === undefined ? 0 : Math.abs(eff);
  const dir: -1 | 0 | 1 = bo !== 0 ? bo : eff === undefined || absEff < REGIME.effChop ? 0 : eff > 0 ? 1 : -1;

  let state: RegimeState;
  if (liquidity === undefined || liquidity < REGIME.minLiquidity) state = 'dead';
  else if (bars.length < REGIME.minBars || volRatio === undefined || eff === undefined) state = 'warming';
  else if (bo !== 0 && volRatio >= REGIME.volExpanding && absEff >= REGIME.effTrend && (rvol === undefined || rvol >= REGIME.rvolHot)) state = 'breakout';
  else if (absEff >= REGIME.effTrend && volRatio >= REGIME.volTrending) state = 'trending';
  else if (volRatio >= REGIME.volExpanding) state = 'expanding';
  else if (absEff < REGIME.effChop) state = 'chop';
  else state = 'quiet';

  const volPart = volRatio === undefined ? 0 : Math.max(0, Math.min(1, (volRatio - 0.5) / 1.5)); // 0.5× → 0, 2× → 1
  const opportunity = state === 'dead' || state === 'warming' ? 0 : Math.round((liquidity ?? 0) * (0.25 + 0.75 * volPart) * (0.2 + 0.8 * absEff));
  return { state, dir, volRatio, eff, rvol, breakout: bo, opportunity };
}

/** Alert edge: entering BREAKOUT or TRENDING from any other state. */
export function becameActionable(prev: RegimeState | undefined, next: RegimeState): boolean {
  const hot = (s: RegimeState | undefined) => s === 'breakout' || s === 'trending';
  return hot(next) && !hot(prev) && prev !== undefined;
}
