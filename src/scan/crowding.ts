// Funding and open-interest crowding. Pure: no I/O.
//
// Vest settles funding hourly; a positive rate means longs pay shorts (the perp trades rich to the
// index, longs crowded), negative means shorts pay longs. /v3/oi gives long and short open
// interest per market. A market is CROWDED when its funding is extreme; open interest leaning the
// same way strengthens the read. The cut-offs are STARTING VALUES: the scanner records funding,
// premium, OI skew and the price 5/15/60 minutes later so they can be tested (measure first).

export const CROWDING = {
  /** |funding| at or above this yearly rate counts as crowded (25% ≈ 0.0029%/h). */
  aprCrowded: 0.25,
  /** |OI skew| at or above this counts as open interest leaning one way. */
  skewLean: 0.2,
} as const;

export interface Crowding {
  /** Funding as a yearly rate (fraction): hourly × 24 × 365. */
  apr: number | undefined;
  /** (long OI − short OI) ÷ (long OI + short OI), −1 … +1. */
  oiSkew: number | undefined;
  /** Which side is crowded (paying), if funding is extreme. */
  crowded: 'long' | 'short' | undefined;
  /** Open interest leans the same way as the crowded side. */
  oiAgrees: boolean;
}

export function oiSkew(longOi: number | undefined, shortOi: number | undefined): number | undefined {
  if (longOi === undefined || shortOi === undefined) return undefined;
  const tot = longOi + shortOi;
  return tot > 0 ? (longOi - shortOi) / tot : undefined;
}

export function crowding(hourlyFunding: number | undefined, skew: number | undefined): Crowding {
  const apr = hourlyFunding === undefined || !Number.isFinite(hourlyFunding) ? undefined : hourlyFunding * 24 * 365;
  const crowded = apr === undefined || Math.abs(apr) < CROWDING.aprCrowded ? undefined : apr > 0 ? 'long' : 'short';
  const oiAgrees = crowded !== undefined && skew !== undefined && Math.abs(skew) >= CROWDING.skewLean && (crowded === 'long' ? skew > 0 : skew < 0);
  return { apr, oiSkew: skew, crowded, oiAgrees };
}

/**
 * Forward returns for recorded rows: for each row, the % change of the same market's price
 * `minutes` later (the nearest row at or after that time, within 2 minutes), else undefined.
 */
export function forwardReturns<T extends { t: number; sym: string; price: number | undefined }>(rows: T[], minutes: number[]): Array<Array<number | undefined>> {
  const bySym = new Map<string, T[]>();
  for (const r of rows) (bySym.get(r.sym) ?? bySym.set(r.sym, []).get(r.sym)!).push(r);
  for (const list of bySym.values()) list.sort((a, b) => a.t - b.t);
  return rows.map((r) =>
    minutes.map((m) => {
      if (!r.price) return undefined;
      const target = r.t + m * 60_000;
      const later = bySym.get(r.sym)!.find((x) => x.t >= target && x.t <= target + 2 * 60_000 && x.price);
      return later ? (later.price! / r.price - 1) * 100 : undefined;
    }),
  );
}
