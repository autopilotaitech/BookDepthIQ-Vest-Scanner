// "Liquid by hour": average $ traded per minute for each market in each hour of the day, built
// from what the scanner sees plus a trade-history backfill. Pure: no I/O (the caller persists it).

export interface HourBucket {
  usd: number;
  minutes: number;
}

/** symbol → 24 buckets (hour of day in the chosen time zone). */
export type HourMap = Record<string, HourBucket[]>;

export function emptyHours(): HourBucket[] {
  return Array.from({ length: 24 }, () => ({ usd: 0, minutes: 0 }));
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();
/** Hour of day (0–23) of `ms` in `timeZone`. */
export function hourIn(ms: number, timeZone: string): number {
  let f = fmtCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone, hour: '2-digit', hourCycle: 'h23' });
    fmtCache.set(timeZone, f);
  }
  return Number(f.format(new Date(ms))) % 24;
}

/** Record one observed minute for a market. */
export function addMinute(map: HourMap, symbol: string, minuteStartMs: number, usd: number, timeZone: string): void {
  const h = hourIn(minuteStartMs, timeZone);
  const b = (map[symbol] ??= emptyHours());
  b[h]!.usd += usd;
  b[h]!.minutes += 1;
}

/** Average $ per minute for a market and hour; undefined until `minMinutes` were observed. */
export function avgPerMin(map: HourMap, symbol: string, hour: number, minMinutes = 1): number | undefined {
  const b = map[symbol]?.[hour];
  return b && b.minutes >= Math.max(1, minMinutes) ? b.usd / b.minutes : undefined;
}

/** A usable "usual volume" baseline needs at least this many observed minutes for the hour. */
export const BASELINE_MIN_MINUTES = 30;

/**
 * Backfill from trade history: trades are bucketed by minute; every minute from the first to the
 * last covered time counts as observed (a quiet minute is real information, $0).
 */
export function addHistory(map: HourMap, symbol: string, trades: Array<{ t: number; usd: number }>, fromMs: number, toMs: number, timeZone: string): void {
  const byMin = new Map<number, number>();
  for (const tr of trades) {
    if (tr.t < fromMs || tr.t >= toMs) continue;
    const m = Math.floor(tr.t / 60_000);
    byMin.set(m, (byMin.get(m) ?? 0) + tr.usd);
  }
  for (let m = Math.ceil(fromMs / 60_000); m < Math.floor(toMs / 60_000); m++) addMinute(map, symbol, m * 60_000, byMin.get(m) ?? 0, timeZone);
}
