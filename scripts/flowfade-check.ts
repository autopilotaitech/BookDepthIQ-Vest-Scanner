// The one rule the search found, checked on data it never saw. Rule fixed in advance (chosen on
// 26 Sep – 2 Oct): 5-min aggressive flow > 30% one-sided AND 5-min $ > 2× the usual 5 min (last 2 h)
// → fade it, hold 30 min, one at a time, 30-min cooldown. Taker round trip taken off every trade.
//   npx tsx scripts/flowfade-check.ts data30 NDX-USD-PERP 2.5e-5
import { readFileSync } from 'node:fs';

const [dir, sym, feeArg] = process.argv.slice(2);
const fee = Number(feeArg ?? 1e-4);
const K = 0.3, HOT = 2, H = 30, COOL = 30;
const PERIODS: Array<[string, number, number]> = [
  ['UNSEEN before   10–25 Sep', Date.UTC(2026, 8, 10), Date.UTC(2026, 8, 26)],
  ['chosen on (IS)  26 Sep–2 Oct', Date.UTC(2026, 8, 26), Date.UTC(2026, 9, 3)],
  ['tested (OOS)    3–9 Oct', Date.UTC(2026, 9, 3), Date.UTC(2026, 9, 9, 21)],
  ['UNSEEN after    9–12 Oct', Date.UTC(2026, 9, 9, 21), Infinity],
];
const rows = JSON.parse(readFileSync(`${dir}/vest_${sym}.json`, 'utf8')) as Array<[number, number, number, number]>;
const jumps: number[] = [];
for (let k = 1; k < rows.length; k++) if (rows[k]![3] !== rows[k - 1]![3]) jumps.push((Math.abs(rows[k]![1] - rows[k - 1]![1]) / rows[k]![1]) * 1e4);
jumps.sort((a, b) => a - b);
const spread = jumps[Math.floor(jumps.length / 2)] ?? 0;
const cost = spread + 2 * fee * 1e4;
const t0 = Math.floor(rows[0]![0] / 60_000) * 60_000;
const n = Math.ceil((rows.at(-1)![0] - t0) / 60_000) + 1;
const c = new Float64Array(n), hi = new Float64Array(n), lo = new Float64Array(n), ok = new Uint8Array(n), usd = new Float64Array(n), delta = new Float64Array(n);
let j = 0, last = NaN, lastT = -1e15;
for (let i = 0; i < n; i++) {
  const end = t0 + (i + 1) * 60_000;
  hi[i] = -Infinity; lo[i] = Infinity;
  while (j < rows.length && rows[j]![0] < end) {
    const [ms, p, u, side] = rows[j]!;
    usd[i]! += u; delta[i]! += side > 0 ? u : -u; hi[i] = Math.max(hi[i]!, p); lo[i] = Math.min(lo[i]!, p); last = p; lastT = ms; j++;
  }
  if (!Number.isFinite(hi[i]!)) { hi[i] = last; lo[i] = last; }
  c[i] = last; ok[i] = end - lastT <= 2 * 60_000 ? 1 : 0;
}
const chi = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hour: 'numeric', hourCycle: 'h23', month: 'short', day: 'numeric' });

interface Tr { t: number; net: number; netNow: number; mae: number; mfe: number; dir: number }
const all: Tr[] = [];
let next = 0;
for (let i = 125; i + 1 + H < n; i++) {
  if (i < next || !ok[i]) continue;
  let u5 = 0, d5 = 0, u120 = 0;
  for (let q = i - 4; q <= i; q++) { u5 += usd[q]!; d5 += delta[q]!; }
  for (let q = i - 119; q <= i; q++) u120 += usd[q]!;
  if (!(u5 > 0) || !(u120 > 0)) continue;
  const imb = d5 / u5;
  if (Math.abs(imb) <= K || u5 / (u120 / 24) <= HOT) continue;
  const a = i + 1, b = i + 1 + H;
  if (!ok[a] || !ok[b]) continue;
  const d = -Math.sign(imb);
  let mae = 0, mfe = 0;
  for (let q = a + 1; q <= b; q++) {
    mae = Math.min(mae, d * Math.log((d > 0 ? lo[q]! : hi[q]!) / c[a]!) * 1e4);
    mfe = Math.max(mfe, d * Math.log((d > 0 ? hi[q]! : lo[q]!) / c[a]!) * 1e4);
  }
  all.push({
    t: t0 + (i + 1) * 60_000, dir: d, mae, mfe,
    net: d * Math.log(c[b]! / c[a]!) * 1e4 - cost, // enter a minute after the signal
    netNow: d * Math.log(c[b - 1]! / c[i]!) * 1e4 - cost, // enter right at the signal close
  });
  next = i + Math.max(H, COOL);
}
const st = (xs: number[]) => {
  const k = xs.length;
  if (!k) return '—';
  const m = xs.reduce((s, x) => s + x, 0) / k;
  const sd = Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, k - 1));
  return `${m >= 0 ? '+' : ''}${m.toFixed(2)} bps  t${(sd > 0 ? m / (sd / Math.sqrt(k)) : 0).toFixed(1)}  ${Math.round((xs.filter((x) => x > 0).length / k) * 100)}% win  n${k}`;
};
console.log(`${sym}: round trip ${cost.toFixed(2)} bps (spread ${spread.toFixed(2)}). 1 bp ≈ ${(c[n - 1]! / 1e4).toFixed(2)} pts`);
for (const [name, from, to] of PERIODS) {
  const s = all.filter((x) => x.t >= from && x.t < to);
  console.log(`  ${name.padEnd(30)} enter +1 min: ${st(s.map((x) => x.net)).padEnd(40)} enter at signal: ${st(s.map((x) => x.netNow))}`);
}
console.log(`\n  all ${st(all.map((x) => x.net))}`);
console.log(`  longs (fading selling) ${st(all.filter((x) => x.dir > 0).map((x) => x.net))}   shorts (fading buying) ${st(all.filter((x) => x.dir < 0).map((x) => x.net))}`);
const byDay = new Map<string, number[]>();
for (const x of all) {
  const k = chi.format(new Date(x.t)).split(',')[0]!;
  (byDay.get(k) ?? byDay.set(k, []).get(k)!).push(x.net);
}
const days = [...byDay.entries()];
console.log(`\n  days: ${days.filter(([, v]) => v.reduce((a, b) => a + b, 0) > 0).length}/${days.length} positive`);
console.log('  ' + days.map(([k, v]) => `${k} ${v.reduce((a, b) => a + b, 0).toFixed(0)}(${v.length})`).join('  '));
const sess = (t: number) => {
  const h = Number(chi.format(new Date(t)).split(', ')[1]);
  return h >= 17 || h < 2 ? 'ASIA' : h < 8 ? 'LONDON' : h < 15 ? 'NY' : 'LATE';
};
console.log('\n  by session: ' + ['ASIA', 'LONDON', 'NY', 'LATE'].map((s) => `${s} ${st(all.filter((x) => sess(x.t) === s).map((x) => x.net))}`).join(' | '));
const q = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.floor(p * (xs.length - 1))]!;
const maes = all.map((x) => x.mae), mfes = all.map((x) => x.mfe);
console.log(`\n  worst move against within 30 min (bps): median ${q(maes, 0.5).toFixed(1)}, 25% worse than ${q(maes, 0.25).toFixed(1)}, 10% worse than ${q(maes, 0.1).toFixed(1)}`);
console.log(`  best move for within 30 min (bps):      median ${q(mfes, 0.5).toFixed(1)}, 25% better than ${q(mfes, 0.75).toFixed(1)}`);
