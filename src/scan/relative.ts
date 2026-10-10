// Relative strength vs a benchmark, and buy/sell pressure. Pure: no I/O.

import type { Bar } from './regime.js';
import type { Category } from './score.js';

/**
 * Benchmark display symbol for a market: alts vs BTC, stocks and ETFs vs NQ, index vs ES
 * (ES itself vs NQ). Commodities, FX and BTC itself have none.
 */
export function benchmarkFor(display: string, category: Category): string | undefined {
  if (category === 'crypto') return display === 'BTC-PERP' ? undefined : 'BTC-PERP';
  if (category === 'stock' || category === 'etf') return 'NQ-PERP';
  if (category === 'index') return display === 'ES-PERP' ? 'NQ-PERP' : 'ES-PERP';
  return undefined;
}

/** % change in bps over the last `n` complete bars (close of the bar n back → last close). */
export function changeBps(bars: Bar[], n: number): number | undefined {
  if (bars.length < n + 1) return undefined;
  const a = bars[bars.length - 1 - n]!.c;
  const b = bars[bars.length - 1]!.c;
  return a > 0 ? (b / a - 1) * 1e4 : undefined;
}

/** Market's move minus its benchmark's over the same bars, bps. + = stronger than the benchmark. */
export function relativeBps(own: Bar[], bench: Bar[], n: number): number | undefined {
  const a = changeBps(own, n);
  const b = changeBps(bench, n);
  return a === undefined || b === undefined ? undefined : a - b;
}

/** Share of the window's traded $ that was taken by buyers minus sellers, −1 … +1. */
export function flowShare(buyUsd: number, sellUsd: number): number | undefined {
  const tot = buyUsd + sellUsd;
  return tot > 0 ? (buyUsd - sellUsd) / tot : undefined;
}

/** Flow that disagrees by this much with the price direction is flagged. */
export const FLOW_DIVERGE = 0.2;

/** Price going one way while aggressive flow goes the other (e.g. a new high on net selling). */
export function flowDiverges(dir: -1 | 0 | 1, share: number | undefined): boolean {
  if (share === undefined || dir === 0) return false;
  return dir > 0 ? share <= -FLOW_DIVERGE : share >= FLOW_DIVERGE;
}
