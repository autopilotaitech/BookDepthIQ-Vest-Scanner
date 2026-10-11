// Trend + levels calls: higher-timeframe SuperTrend (the panel's own engine) sets the side; a call
// fires only when price BREAKS a level, or PULLS BACK to one and holds, in that direction.
// Levels: prior-day high/low, today's high/low so far, today's VWAP (day starts 17:00 Chicago).
//   node scripts/fetch-trades.mjs data 16 BTC-PERP ETH-PERP SOL-PERP NDX-USD-PERP SPX-USD-PERP GC-PERP NVDA-USD-PERP
//   npx tsx scripts/replay-setups.ts data
// Graded like the scorecard: entry at the minute after the call, fixed hold, minus a taker round
// trip. IS = 09-26..10-02, OOS = 10-03..10-10. Read-only research.
import { readFileSync } from 'node:fs';
import { TrendEngine } from '../src/scan/supertrend';

const dir = process.argv[2]!;
const M: Array<[string, string, number, number, number]> = [
  // name, file, tick, round-trip cost bps (spread from prints + fees), fee
  ['BTC', 'BTC-PERP', 1, 2.7, 1e-4], ['ETH', 'ETH-PERP', 0.01, 3.46, 1e-4], ['SOL', 'SOL-PERP', 0.001, 4.64, 1e-4],
  ['NQ', 'NDX-USD-PERP', 0.25, 0.91, 2.5e-5], ['ES', 'SPX-USD-PERP', 0.25, 1.14, 2.5e-5], ['GOLD', 'GC-PERP', 0.1, 5.24, 1e-4], ['NVDA', 'NVDA-USD-PERP', 0.01, 4.96, 1e-4],
];
const FROM = Date.UTC(2026, 8, 26), SPLIT = Date.UTC(2026, 9, 3);
const HOLDS = [15, 30, 60, 120];
const dayOf = (t: number) => Math.floor((t + 7 * 3600_000 - 5 * 3600_000) / 86400_000); // 17:00 CDT = 22:00 UTC

interface Call { t: number; mkt: string; kind: string; htf: string; dir: 1 | -1; i: number }
const calls: Call[] = [];
const series = new Map<string, { px: Float64Array; ok: Uint8Array; t0: number; cost: number }>();

for (const [name, sym, tick, cost] of M) {
  const rows = JSON.parse(readFileSync(`${dir}/vest_${sym}.json`, 'utf8')) as Array<[number, number, number, number]>;
  const t0 = Math.floor(rows[0]![0] / 60_000) * 60_000;
  const n = Math.ceil((rows.at(-1)![0] - t0) / 60_000) + 1;
  const px = new Float64Array(n), ok = new Uint8Array(n);
  for (const htfSec of [900, 3600]) {
    const st = new TrendEngine({ enabled: true, intervalSec: htfSec, numCandles: 10, multiplier: 3.0, switch: 'close', confirm: 1, volMult: 1.5, deltaMin: 0 });
    let j = 0, last = NaN, lastT = -1e15;
    let day = -1, pdh = NaN, pdl = NaN, dh = -Infinity, dl = Infinity, pv = 0, v = 0;
    let prevClose = NaN;
    const recent: number[] = []; // last 5 closes
    let lastCall = -1e15;
    for (let i = 0; i < n; i++) {
      const end = t0 + (i + 1) * 60_000;
      // levels as they stood BEFORE this minute (no peeking)
      const lv = { pdh, pdl, dh, dl, vwap: v > 0 ? pv / v : NaN };
      while (j < rows.length && rows[j]![0] < end) {
        const [ms, p, usd, side] = rows[j]!;
        const d = dayOf(ms);
        if (d !== day) { if (day >= 0) { pdh = dh; pdl = dl; } day = d; dh = -Infinity; dl = Infinity; pv = 0; v = 0; }
        dh = Math.max(dh, p); dl = Math.min(dl, p); pv += p * usd; v += usd;
        st.onTrade(ms, Math.round(p / tick), usd / p, side > 0);
        last = p; lastT = ms; j++;
      }
      const fresh = end - lastT <= 2 * 60_000;
      if (htfSec === 900) { px[i] = last; ok[i] = fresh ? 1 : 0; }
      if (!fresh || end < FROM) { prevClose = last; continue; }
      const c = last;
      recent.push(c); if (recent.length > 5) recent.shift();
      const trend = st.snapshot().dir;
      if (trend === 'neutral' || end - lastCall < 30 * 60_000) { prevClose = c; continue; }
      const d: 1 | -1 = trend === 'up' ? 1 : -1;
      const tol = c * (cost / 1e4); // a level "touch" = within one round-trip cost
      const levels = d > 0 ? [lv.pdh, lv.dh, lv.vwap] : [lv.pdl, lv.dl, lv.vwap];
      let kind = '';
      for (const L of levels) {
        if (!(L > 0) || !Number.isFinite(L)) continue;
        // BREAK: this close beyond the level, previous close not
        if (d > 0 ? c > L + tol && prevClose <= L : c < L - tol && prevClose >= L) { kind = 'break'; break; }
      }
      if (!kind) for (const L of [lv.vwap, d > 0 ? lv.pdh : lv.pdl, d > 0 ? lv.pdl : lv.pdh]) {
        if (!(L > 0) || !Number.isFinite(L)) continue;
        // PULLBACK-HOLD: touched the level from the trend side in the last 5 min, now moving away
        const touched = recent.slice(0, -1).some((x) => Math.abs(x - L) <= tol);
        const holding = d > 0 ? c > L + tol && c > prevClose : c < L - tol && c < prevClose;
        if (touched && holding) { kind = 'pullback'; break; }
      }
      if (kind) { calls.push({ t: end, mkt: name, kind, htf: htfSec === 900 ? '15m' : '60m', dir: d, i }); lastCall = end; }
      prevClose = c;
    }
  }
  series.set(name, { px, ok, t0, cost });
}

const grade = (list: Call[], H: number) => list.map((c) => {
  const s = series.get(c.mkt)!;
  const a = c.i + 1, b = c.i + 1 + H;
  if (b >= s.px.length || !s.ok[a] || !s.ok[b]) return undefined;
  return c.dir * Math.log(s.px[b]! / s.px[a]!) * 1e4 - s.cost;
}).filter((x): x is number => x !== undefined);
const fmt = (xs: number[]) => {
  if (!xs.length) return 'n=0'.padEnd(28);
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, xs.length - 1));
  return `${m >= 0 ? '+' : ''}${m.toFixed(1)} t${(sd > 0 ? m / (sd / Math.sqrt(xs.length)) : 0).toFixed(1)} ${Math.round((xs.filter((x) => x > 0).length / xs.length) * 100)}% n=${xs.length}`.padEnd(28);
};
for (const htf of ['15m', '60m']) for (const kind of ['break', 'pullback', 'any']) {
  const sel = calls.filter((c) => c.htf === htf && (kind === 'any' || c.kind === kind));
  console.log(`\n── HTF ${htf} SuperTrend · ${kind}`);
  for (const H of HOLDS) console.log(`   hold ${String(H).padStart(3)}m   IS ${fmt(grade(sel.filter((c) => c.t < SPLIT), H))} OOS ${fmt(grade(sel.filter((c) => c.t >= SPLIT), H))}`);
  const per = M.map(([nm]) => `${nm} ${fmt(grade(sel.filter((c) => c.mkt === nm), 60)).split(' ')[0]}(${sel.filter((c) => c.mkt === nm).length})`).join('  ');
  console.log(`   60m by market: ${per}`);
}
