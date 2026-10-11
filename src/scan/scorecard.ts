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
/** Fewer graded calls than this: too few to trust. */
export const MIN_TRUSTED = 30;

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

export interface Grade {
  n: number;
  avgBps: number | undefined;
  winRate: number | undefined;
}

export interface ScoreRow {
  label: string;
  /** One per horizon. */
  grades: Grade[];
}

function grade(xs: number[]): Grade {
  if (!xs.length) return { n: 0, avgBps: undefined, winRate: undefined };
  return { n: xs.length, avgBps: xs.reduce((a, b) => a + b, 0) / xs.length, winRate: xs.filter((x) => x > 0).length / xs.length };
}

/** Scorecard rows: breaks, pullbacks, all. */
export function scorecard(calls: Call[]): ScoreRow[] {
  const row = (label: string, list: Call[]): ScoreRow => ({
    label,
    grades: HORIZONS_MIN.map((_, i) => grade(list.map((c) => c.net[i]).filter((x): x is number => typeof x === 'number'))),
  });
  return [row('BREAK of a level', calls.filter((c) => c.kind === 'break')), row('PULLBACK that held', calls.filter((c) => c.kind === 'pullback')), row('all calls', calls)];
}

export function callsCsv(calls: Call[]): string {
  const f = (v: number | null | undefined) => (typeof v === 'number' ? v.toFixed(2) : v === null ? 'missed' : '');
  return [
    `time,market,kind,level,dir,entry,cost_bps,${HORIZONS_MIN.map((h) => `net_${h}m_bps`).join(',')}`,
    ...calls.map((c) => `${new Date(c.t).toISOString()},${c.sym},${c.kind},${c.level},${c.dir > 0 ? 'long' : 'short'},${c.entry},${c.costBps.toFixed(2)},${c.net.map(f).join(',')}`),
  ].join('\n');
}
