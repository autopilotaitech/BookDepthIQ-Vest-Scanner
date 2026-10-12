// Edge search with an honest test: every rule is CHOSEN on the first week (IS, 26 Sep – 2 Oct) and
// only rules that pass there are TESTED on the second week (OOS, 3 Oct – end), which they never saw.
// Net = direction × move over the hold, minus a taker round trip (measured spread + fee both ways).
//   npx tsx scripts/search.ts data
import { readFileSync, existsSync } from 'node:fs';
import { TrendEngine } from '../src/scan/supertrend';

const dir = process.argv[2]!;
const M: Array<[string, string, number, number]> = [
  ['BTC', 'BTC-PERP', 1, 1e-4], ['ETH', 'ETH-PERP', 0.01, 1e-4], ['SOL', 'SOL-PERP', 0.001, 1e-4],
  ['NQ', 'NDX-USD-PERP', 0.25, 2.5e-5], ['ES', 'SPX-USD-PERP', 0.25, 2.5e-5], ['GOLD', 'GC-PERP', 0.1, 1e-4],
  ['CL', 'CL-PERP', 0.01, 1e-4], ['SI', 'SI-PERP', 0.005, 1e-4],
];
const FROM = Date.UTC(2026, 8, 26), SPLIT = Date.UTC(2026, 9, 3);
const HOLDS = [5, 15, 30, 60];
const COOLDOWN = 30;
const chiFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hour: 'numeric', hourCycle: 'h23' });
const hourCache = new Map<number, number>();
const chiHour = (t: number) => {
  const k = Math.floor(t / 3600_000);
  let h = hourCache.get(k);
  if (h === undefined) hourCache.set(k, (h = Number(chiFmt.format(new Date(t))) % 24));
  return h;
};

interface Mkt {
  name: string;
  t0: number;
  n: number;
  c: Float64Array;
  ok: Uint8Array;
  usd: Float64Array;
  delta: Float64Array;
  cost: number;
  // features per minute (NaN = unknown)
  z: Float64Array; // log(c/vwap) in σ of 60-min moves
  r15: Float64Array; // 15-min move in σ
  rvol: Float64Array; // $ last 15 min vs same hour earlier days
  imb5: Float64Array; // (buy − sell) / total over 5 min
  hot5: Float64Array; // $ last 5 min vs avg 5 min over the last 2 h
  pos60: Float64Array; // where the close sits in the 60-min range, 0..1
  brk60: Int8Array; // +1 close above prior 60-min high, −1 below low
  trend: Int8Array; // 15m SuperTrend
}

const mkts: Mkt[] = [];
for (const [name, sym, tick, fee] of M) {
  const f = `${dir}/vest_${sym}.json`;
  if (!existsSync(f)) continue;
  const rows = JSON.parse(readFileSync(f, 'utf8')) as Array<[number, number, number, number]>;
  const jumps: number[] = [];
  for (let k = 1; k < rows.length; k++) if (rows[k]![3] !== rows[k - 1]![3]) jumps.push((Math.abs(rows[k]![1] - rows[k - 1]![1]) / rows[k]![1]) * 1e4);
  jumps.sort((a, b) => a - b);
  const cost = (jumps[Math.floor(jumps.length / 2)] ?? 0) + 2 * fee * 1e4;
  const t0 = Math.floor(rows[0]![0] / 60_000) * 60_000;
  const n = Math.ceil((rows.at(-1)![0] - t0) / 60_000) + 1;
  const m: Mkt = {
    name, t0, n, cost,
    c: new Float64Array(n), ok: new Uint8Array(n), usd: new Float64Array(n), delta: new Float64Array(n),
    z: new Float64Array(n).fill(NaN), r15: new Float64Array(n).fill(NaN), rvol: new Float64Array(n).fill(NaN),
    imb5: new Float64Array(n).fill(NaN), hot5: new Float64Array(n).fill(NaN), pos60: new Float64Array(n).fill(NaN),
    brk60: new Int8Array(n), trend: new Int8Array(n),
  };
  const st = new TrendEngine({ enabled: true, intervalSec: 900, numCandles: 10, multiplier: 3.0, switch: 'close', confirm: 1, volMult: 1.5, deltaMin: 0 });
  let j = 0, last = NaN, lastT = -1e15, day = -1, pv = 0, v = 0, candles = 0;
  const hourUsd = new Map<number, { sum: number; days: Set<number> }>();
  for (let i = 0; i < n; i++) {
    const end = t0 + (i + 1) * 60_000;
    while (j < rows.length && rows[j]![0] < end) {
      const [ms, p, usd, side] = rows[j]!;
      const d = Math.floor((ms + 2 * 3600_000) / 86400_000);
      if (d !== day) { day = d; pv = 0; v = 0; }
      pv += p * usd; v += usd;
      if (st.onTrade(ms, Math.round(p / tick), usd / p, side > 0)) candles++;
      m.usd[i]! += usd;
      m.delta[i]! += side > 0 ? usd : -usd;
      last = p; lastT = ms; j++;
    }
    m.c[i] = last;
    m.ok[i] = end - lastT <= 2 * 60_000 ? 1 : 0;
    const snap = st.snapshot().dir;
    m.trend[i] = candles >= 10 ? (snap === 'up' ? 1 : snap === 'down' ? -1 : 0) : 0;
    // σ of 1-min log returns over the last 120 min
    if (i >= 121) {
      let s2 = 0, k2 = 0;
      for (let k = i - 119; k <= i; k++) if (m.c[k - 1]! > 0) { const r = Math.log(m.c[k]! / m.c[k - 1]!); s2 += r * r; k2++; }
      const sd1 = k2 > 60 ? Math.sqrt(s2 / k2) : 0;
      if (sd1 > 0) {
        if (v > 0) m.z[i] = Math.log(last / (pv / v)) / (sd1 * Math.sqrt(60));
        m.r15[i] = Math.log(m.c[i]! / m.c[i - 15]!) / (sd1 * Math.sqrt(15));
      }
      let hi = -Infinity, lo = Infinity;
      for (let k = i - 60; k < i; k++) { hi = Math.max(hi, m.c[k]!); lo = Math.min(lo, m.c[k]!); }
      if (hi > lo) m.pos60[i] = (last - lo) / (hi - lo);
      m.brk60[i] = last > hi ? 1 : last < lo ? -1 : 0;
      let u5 = 0, d5 = 0, u120 = 0;
      for (let k = i - 4; k <= i; k++) { u5 += m.usd[k]!; d5 += m.delta[k]!; }
      for (let k = i - 119; k <= i; k++) u120 += m.usd[k]!;
      if (u5 > 0) m.imb5[i] = d5 / u5;
      if (u120 > 0) m.hot5[i] = u5 / (u120 / 24);
    }
    const hr = chiHour(end - 1);
    const hu = hourUsd.get(hr) ?? hourUsd.set(hr, { sum: 0, days: new Set() }).get(hr)!;
    if (hu.days.size >= 2 && i >= 15) {
      let u15 = 0;
      for (let k = i - 14; k <= i; k++) u15 += m.usd[k]!;
      const usual = (hu.sum / hu.days.size / 60) * 15;
      if (usual > 0) m.rvol[i] = u15 / usual;
    }
    hu.sum += m.usd[i]!;
    hu.days.add(day);
  }
  mkts.push(m);
}

type Rule = { name: string; fire: (m: Mkt, i: number) => -1 | 0 | 1 };
const rules: Rule[] = [];
const sgn = (x: number): -1 | 1 => (x > 0 ? 1 : -1);
const rv = {
  any: (_: number) => true,
  low: (x: number) => x < 0.7,
  high: (x: number) => x > 1.5,
};
for (const [rvn, rvf] of Object.entries(rv)) {
  for (const k of [1.5, 2, 2.5, 3]) {
    rules.push({ name: `VWAP fade |z|>${k} rvol:${rvn}`, fire: (m, i) => (Math.abs(m.z[i]!) > k && rvf(m.rvol[i]!) ? (-sgn(m.z[i]!) as -1 | 1) : 0) });
    rules.push({ name: `VWAP follow |z|>${k} rvol:${rvn}`, fire: (m, i) => (Math.abs(m.z[i]!) > k && rvf(m.rvol[i]!) ? sgn(m.z[i]!) : 0) });
    rules.push({ name: `15m move follow >${k}σ rvol:${rvn}`, fire: (m, i) => (Math.abs(m.r15[i]!) > k && rvf(m.rvol[i]!) ? sgn(m.r15[i]!) : 0) });
    rules.push({ name: `15m move fade >${k}σ rvol:${rvn}`, fire: (m, i) => (Math.abs(m.r15[i]!) > k && rvf(m.rvol[i]!) ? (-sgn(m.r15[i]!) as -1 | 1) : 0) });
  }
  for (const k of [0.3, 0.5, 0.7]) for (const hot of [2, 4]) {
    rules.push({ name: `flow burst follow imb>${k} ${hot}×$ rvol:${rvn}`, fire: (m, i) => (Math.abs(m.imb5[i]!) > k && m.hot5[i]! > hot && rvf(m.rvol[i]!) ? sgn(m.imb5[i]!) : 0) });
    rules.push({ name: `flow burst fade imb>${k} ${hot}×$ rvol:${rvn}`, fire: (m, i) => (Math.abs(m.imb5[i]!) > k && m.hot5[i]! > hot && rvf(m.rvol[i]!) ? (-sgn(m.imb5[i]!) as -1 | 1) : 0) });
  }
  rules.push({ name: `60m break follow, 15m trend agrees rvol:${rvn}`, fire: (m, i) => (m.brk60[i] !== 0 && m.brk60[i] === m.trend[i] && rvf(m.rvol[i]!) ? (m.brk60[i] as -1 | 1) : 0) });
  rules.push({ name: `60m break fade rvol:${rvn}`, fire: (m, i) => (m.brk60[i] !== 0 && rvf(m.rvol[i]!) ? (-m.brk60[i]! as -1 | 1) : 0) });
  rules.push({ name: `60m range edge fade (pos<.1/>.9), no trend rvol:${rvn}`, fire: (m, i) => (m.trend[i] === 0 && rvf(m.rvol[i]!) && (m.pos60[i]! < 0.1 || m.pos60[i]! > 0.9) ? (m.pos60[i]! < 0.1 ? 1 : -1) : 0) });
  rules.push({ name: `pullback to VWAP in 15m trend (|z|<.25) rvol:${rvn}`, fire: (m, i) => (m.trend[i] !== 0 && Math.abs(m.z[i]!) < 0.25 && rvf(m.rvol[i]!) ? (m.trend[i] as -1 | 1) : 0) });
}

/** All trades of a rule on one market, in [from, to). One at a time: cooldown, no overlap with the hold. */
function trades(rule: Rule, m: Mkt, H: number, from: number, to: number): number[] {
  const out: number[] = [];
  let next = 0;
  for (let i = 125; i + 1 + H < m.n; i++) {
    const t = m.t0 + (i + 1) * 60_000;
    if (t < from || t >= to || i < next || !m.ok[i]) continue;
    const d = rule.fire(m, i);
    if (!d) continue;
    const a = i + 1, b = i + 1 + H;
    if (!m.ok[a] || !m.ok[b]) continue;
    out.push(d * Math.log(m.c[b]! / m.c[a]!) * 1e4 - m.cost);
    next = i + Math.max(H, COOLDOWN);
  }
  return out;
}
const stats = (xs: number[]) => {
  const n = xs.length;
  if (!n) return { n, mean: 0, t: 0, win: 0 };
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, n - 1));
  return { n, mean, t: sd > 0 ? mean / (sd / Math.sqrt(n)) : 0, win: xs.filter((x) => x > 0).length / n };
};
const f = (s: ReturnType<typeof stats>) => `${s.mean >= 0 ? '+' : ''}${s.mean.toFixed(1)}bps t${s.t.toFixed(1)} ${Math.round(s.win * 100)}% n${s.n}`;

// Candidates: (rule, hold, market or ALL). Chosen on IS only.
interface Cand { rule: Rule; H: number; mk: string; is: ReturnType<typeof stats>; oos?: ReturnType<typeof stats> }
const cands: Cand[] = [];
let tested = 0;
for (const rule of rules) for (const H of HOLDS) {
  const per = mkts.map((m) => ({ m, is: trades(rule, m, H, FROM, SPLIT) }));
  const all = stats(per.flatMap((p) => p.is));
  tested++;
  cands.push({ rule, H, mk: 'ALL', is: all });
  for (const p of per) { tested++; cands.push({ rule, H, mk: p.m.name, is: stats(p.is) }); }
}
const pass = cands.filter((c) => c.is.n >= 15 && c.is.mean > 0 && c.is.t >= 2.5);
for (const c of pass) {
  const ms = c.mk === 'ALL' ? mkts : mkts.filter((m) => m.name === c.mk);
  c.oos = stats(ms.flatMap((m) => trades(c.rule, m, c.H, SPLIT, Infinity)));
}
console.log(`markets: ${mkts.map((m) => `${m.name} ${m.cost.toFixed(1)}bps`).join(', ')}`);
console.log(`tested ${tested} rule × hold × market combinations on IS; ${pass.length} passed (n≥15, mean>0, t≥2.5)\n`);
pass.sort((a, b) => (b.oos?.t ?? 0) - (a.oos?.t ?? 0));
for (const c of pass) console.log(`${(c.oos && c.oos.mean > 0 && c.oos.t >= 2 ? 'HOLDS ' : c.oos && c.oos.mean > 0 ? 'weak  ' : 'FAILS ')}${c.mk.padEnd(5)} hold ${String(c.H).padStart(2)}m  ${c.rule.name.padEnd(52)} IS ${f(c.is).padEnd(28)} OOS ${f(c.oos!)}`);
