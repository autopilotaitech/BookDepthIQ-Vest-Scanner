// Scorecard: grade the scanner's own calls. Pure: no I/O.
//
// A CALL is a trend + level setup (src/scan/setup.ts). Its entry is the price then; 15, 30 and 60
// minutes later the price is read again. The result is in bps of the entry, signed by the call's
// direction, MINUS the cost of a taker round trip (the spread plus Vest's taker fee each way). So
// a positive average means "taking every call by hand would have paid".

import type { LevelName, SetupKind } from './setup.js';

export const HORIZONS_MIN = [15, 30, 60] as const;
/** A horizon read later than this past its time is dropped (scanner was closed), not guessed. */
export const READ_GRACE_MS = 2 * 60_000;

export interface Call {
  t: number;
  sym: string; // display symbol
  kind: SetupKind;
  level: LevelName;
  dir: 1 | -1;
  entry: number;
  costBps: number;
  /** Net bps at each horizon (HORIZONS_MIN order); null = missed (scanner closed), undefined = pending. */
  net: Array<number | null | undefined>;
}

export function openCall(t: number, sym: string, kind: SetupKind, level: LevelName, dir: 1 | -1, entry: number, spreadBps: number, takerFee: number): Call {
  return { t, sym, kind, level, dir, entry, costBps: spreadBps + 2 * takerFee * 1e4, net: HORIZONS_MIN.map(() => undefined) };
}

/** Fill in any horizon that has come due. Returns true if something changed. */
export function gradeCall(c: Call, now: number, price: number | undefined): boolean {
  let changed = false;
  HORIZONS_MIN.forEach((h, i) => {
    if (c.net[i] !== undefined) return;
    const due = c.t + h * 60_000;
    if (now < due) return;
    if (now - due > READ_GRACE_MS || !(price! > 0)) c.net[i] = null;
    else c.net[i] = c.dir * (price! / c.entry - 1) * 1e4 - c.costBps;
    changed = true;
  });
  return changed;
}

export interface MarketGrade {
  sym: string;
  /** Calls graded at 30 min (the middle horizon) and their average net bps. */
  n: number;
  avgBps: number;
}

/** Average net bps at 30 min per market, most calls first. */
export function byMarket(calls: Call[]): MarketGrade[] {
  const m = new Map<string, number[]>();
  for (const c of calls) {
    const x = c.net[1];
    if (typeof x === 'number') (m.get(c.sym) ?? m.set(c.sym, []).get(c.sym)!).push(x);
  }
  return [...m.entries()].map(([sym, xs]) => ({ sym, n: xs.length, avgBps: xs.reduce((a, b) => a + b, 0) / xs.length })).sort((a, b) => b.n - a.n);
}

export function callsCsv(calls: Call[]): string {
  const f = (v: number | null | undefined) => (typeof v === 'number' ? v.toFixed(2) : v === null ? 'missed' : '');
  return [
    `time,market,kind,level,dir,entry,cost_bps,${HORIZONS_MIN.map((h) => `net_${h}m_bps`).join(',')}`,
    ...calls.map((c) => `${new Date(c.t).toISOString()},${c.sym},${c.kind},${c.level},${c.dir > 0 ? 'long' : 'short'},${c.entry},${c.costBps.toFixed(2)},${c.net.map(f).join(',')}`),
  ].join('\n');
}
