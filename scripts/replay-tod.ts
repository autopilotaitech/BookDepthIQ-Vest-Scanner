// Do the trend + level calls do better at some times of day, or outside chop? Same call rules as
// replay-setups.ts (15m SuperTrend side, prior-day/today high-low/VWAP break or pullback, one call
// per market per 30 min). Each call is tagged with:
//   - its Chicago session: ASIA 17:00–02:00, LONDON 02:00–08:30, NY 08:30–15:00, LATE 15:00–17:00
//   - chop: efficiency of the last 60 one-minute closes, |net move| / path (0 = pure chop, 1 = straight line)
//   - rvol: $ traded in the last 15 min vs the same clock hour on earlier days
// Graded like the scorecard: entry the minute after, fixed hold, minus a taker round trip.
//   npx tsx scripts/replay-tod.ts data
import { readFileSync, existsSync } from 'node:fs';
import { TrendEngine } from '../src/scan/supertrend';

const dir = process.argv[2]!;
// name, file, tick, taker fee. Spread is measured from the prints below.
const M: Array<[string, string, number, number]> = [
  ['BTC', 'BTC-PERP', 1, 1e-4], ['ETH', 'ETH-PERP', 0.01, 1e-4], ['SOL', 'SOL-PERP', 0.001, 1e-4],
  ['NQ', 'NDX-USD-PERP', 0.25, 2.5e-5], ['ES', 'SPX-USD-PERP', 0.25, 2.5e-5], ['GOLD', 'GC-PERP', 0.1, 1e-4],
  ['CL', 'CL-PERP', 0.01, 1e-4], ['SI', 'SI-PERP', 0.005, 1e-4],
];
const SPLIT = Date.UTC(2026, 9, 3);
const HOLDS = [30, 60];
const dayOf = (t: number) => Math.floor((t + 2 * 3600_000) / 86400_000); // 17:00 CDT = 22:00 UTC
const chiFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' });
const chiMin = (t: number) => {
  const [h, m] = chiFmt.format(new Date(t)).split(':').map(Number);
  return h! * 60 + m!;
};
const session = (t: number) => {
  const m = chiMin(t);
  return m >= 17 * 60 || m < 2 * 60 ? 'ASIA' : m < 8 * 60 + 30 ? 'LONDON' : m < 15 * 60 ? 'NY' : 'LATE';
};

interface Call { t: number; mkt: string; dir: 1 | -1; i: number; sess: string; hour: number; eff: number; rvol: number }
const calls: Call[] = [];
const series = new Map<string, { px: Float64Array; ok: Uint8Array; cost: number }>();

for (const [name, sym, tick, fee] of M) {
  const f = `${dir}/vest_${sym}.json`;
  if (!existsSync(f)) {
    console.log(`(no data for ${name})`);
    continue;
  }
  const rows = JSON.parse(readFileSync(f, 'utf8')) as Array<[number, number, number, number]>;
  if (rows.length < 100) continue;
  // Spread: median price jump between consecutive prints of opposite aggressor side, in bps.
  const jumps: number[] = [];
  for (let k = 1; k < rows.length; k++) if (rows[k]![3] !== rows[k - 1]![3]) jumps.push((Math.abs(rows[k]![1] - rows[k - 1]![1]) / rows[k]![1]) * 1e4);
  jumps.sort((a, b) => a - b);
  const spread = jumps[Math.floor(jumps.length / 2)] ?? 0;
  const cost = spread + 2 * fee * 1e4;
  const t0 = Math.floor(rows[0]![0] / 60_000) * 60_000;
  const n = Math.ceil((rows.at(-1)![0] - t0) / 60_000) + 1;
  const px = new Float64Array(n), ok = new Uint8Array(n), usdMin = new Float64Array(n);
  const st = new TrendEngine({ enabled: true, intervalSec: 900, numCandles: 10, multiplier: 3.0, switch: 'close', confirm: 1, volMult: 1.5, deltaMin: 0 });
  const hourUsd = new Map<number, { sum: number; days: Set<number> }>(); // clock hour (Chicago) → $ on earlier days
  let j = 0, last = NaN, lastT = -1e15;
  let day = -1, pdh = NaN, pdl = NaN, dh = -Infinity, dl = Infinity, pv = 0, v = 0;
  let prevClose = NaN, lastCall = -1e15;
  const recent: number[] = [];
  for (let i = 0; i < n; i++) {
    const end = t0 + (i + 1) * 60_000;
    const lv = { pdh, pdl, dh, dl, vwap: v > 0 ? pv / v : NaN };
    while (j < rows.length && rows[j]![0] < end) {
      const [ms, p, usd, side] = rows[j]!;
      const d = dayOf(ms);
      if (d !== day) { if (day >= 0) { pdh = dh; pdl = dl; } day = d; dh = -Infinity; dl = Infinity; pv = 0; v = 0; }
      dh = Math.max(dh, p); dl = Math.min(dl, p); pv += p * usd; v += usd;
      st.onTrade(ms, Math.round(p / tick), usd / p, side > 0);
      usdMin[i]! += usd;
      last = p; lastT = ms; j++;
    }
    const hr = Math.floor(chiMin(end - 1) / 60);
    const hu = hourUsd.get(hr) ?? hourUsd.set(hr, { sum: 0, days: new Set() }).get(hr)!;
    const fresh = end - lastT <= 2 * 60_000;
    px[i] = last; ok[i] = fresh ? 1 : 0;
    const c = last;
    // features as of this minute close
    let eff = NaN;
    if (i >= 60 && ok[i - 60]) {
      let path = 0;
      for (let k = i - 59; k <= i; k++) path += Math.abs(px[k]! - px[k - 1]!);
      eff = path > 0 ? Math.abs(px[i]! - px[i - 60]!) / path : 0;
    }
    let u15 = 0;
    for (let k = Math.max(0, i - 14); k <= i; k++) u15 += usdMin[k]!;
    const usual = hu.days.size >= 2 ? (hu.sum / hu.days.size / 60) * 15 : NaN; // avg $ per 15 min in this hour
    const rvol = usual > 0 ? u15 / usual : NaN;
    hu.sum += usdMin[i]!;
    hu.days.add(day);

    if (!fresh) { prevClose = c; continue; }
    recent.push(c); if (recent.length > 5) recent.shift();
    const trend = st.snapshot().dir;
    if (trend === 'neutral' || end - lastCall < 30 * 60_000) { prevClose = c; continue; }
    const d: 1 | -1 = trend === 'up' ? 1 : -1;
    const tol = c * (cost / 1e4);
    let kind = '';
    for (const L of d > 0 ? [lv.pdh, lv.dh, lv.vwap] : [lv.pdl, lv.dl, lv.vwap]) {
      if (!(L > 0) || !Number.isFinite(L)) continue;
      if (d > 0 ? c > L + tol && prevClose <= L : c < L - tol && prevClose >= L) { kind = 'break'; break; }
    }
    if (!kind) for (const L of [lv.vwap, d > 0 ? lv.pdh : lv.pdl, d > 0 ? lv.pdl : lv.pdh]) {
      if (!(L > 0) || !Number.isFinite(L)) continue;
      const touched = recent.slice(0, -1).some((x) => Math.abs(x - L) <= tol);
      const holding = d > 0 ? c > L + tol && c > prevClose : c < L - tol && c < prevClose;
      if (touched && holding) { kind = 'pullback'; break; }
    }
    if (kind) { calls.push({ t: end, mkt: name, dir: d, i, sess: session(end), hour: hr, eff, rvol }); lastCall = end; }
    prevClose = c;
  }
  series.set(name, { px, ok, cost });
  console.log(`${name}: spread ${spread.toFixed(2)} bps, round trip ${cost.toFixed(2)} bps, ${calls.filter((x) => x.mkt === name).length} calls`);
}

const grade = (list: Call[], H: number) => list.map((c) => {
  const s = series.get(c.mkt)!;
  const a = c.i + 1, b = c.i + 1 + H;
  if (b >= s.px.length || !s.ok[a] || !s.ok[b]) return undefined;
  return c.dir * Math.log(s.px[b]! / s.px[a]!) * 1e4 - s.cost;
}).filter((x): x is number => x !== undefined);
const fmt = (xs: number[]) => {
  if (!xs.length) return 'n=0'.padEnd(26);
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, xs.length - 1));
  return `${m >= 0 ? '+' : ''}${m.toFixed(1)} t${(sd > 0 ? m / (sd / Math.sqrt(xs.length)) : 0).toFixed(1)} ${Math.round((xs.filter((x) => x > 0).length / xs.length) * 100)}% n=${xs.length}`.padEnd(26);
};
const row = (label: string, sel: Call[]) =>
  console.log(`  ${label.padEnd(26)} ${HOLDS.map((H) => `${H}m ${fmt(grade(sel, H))}`).join(' ')}  | OOS 60m ${fmt(grade(sel.filter((c) => c.t >= SPLIT), 60))}`);

console.log(`\nAll calls`);
row('all', calls);
console.log(`\nBy Chicago session`);
for (const s of ['ASIA', 'LONDON', 'NY', 'LATE']) row(s, calls.filter((c) => c.sess === s));
console.log(`\nBy chop (efficiency of the last 60 min)`);
for (const [lo, hi] of [[0, 0.1], [0.1, 0.2], [0.2, 0.35], [0.35, 1.01]]) row(`eff ${lo}–${hi}`, calls.filter((c) => c.eff >= lo! && c.eff < hi!));
console.log(`\nBy relative volume (last 15 min vs this hour on earlier days)`);
for (const [lo, hi] of [[0, 0.5], [0.5, 1], [1, 2], [2, 1e9]]) row(`rvol ${lo}–${hi === 1e9 ? '∞' : hi}`, calls.filter((c) => c.rvol >= lo! && c.rvol < hi!));
console.log(`\nBy Chicago hour`);
for (let h = 0; h < 24; h++) {
  const sel = calls.filter((c) => c.hour === h);
  if (sel.length) row(`${String(h).padStart(2, '0')}:00`, sel);
}
console.log(`\nBy market × session (60m avg bps, n)`);
for (const [nm] of M) {
  const cells = ['ASIA', 'LONDON', 'NY', 'LATE'].map((s) => {
    const g = grade(calls.filter((c) => c.mkt === nm && c.sess === s), 60);
    return `${s} ${g.length ? (g.reduce((a, b) => a + b, 0) / g.length).toFixed(1) : '—'} (${g.length})`;
  });
  console.log(`  ${nm.padEnd(5)} ${cells.join('  ')}`);
}
