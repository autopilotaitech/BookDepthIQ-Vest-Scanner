// Flow-burst fade, looked at closely: a 5-min burst of one-sided aggressive flow (imbalance > k,
// $ > hot × the usual 5 min) tends to come back on a market-maker-quoted book. Shows the whole
// parameter neighbourhood (not one lucky cell), gross vs net of costs, both weeks, every market.
//   npx tsx scripts/flowfade.ts data
import { readFileSync, existsSync } from 'node:fs';

const dir = process.argv[2]!;
const M: Array<[string, string, number]> = [
  ['BTC', 'BTC-PERP', 1e-4], ['ETH', 'ETH-PERP', 1e-4], ['SOL', 'SOL-PERP', 1e-4], ['NQ', 'NDX-USD-PERP', 2.5e-5],
  ['ES', 'SPX-USD-PERP', 2.5e-5], ['GOLD', 'GC-PERP', 1e-4], ['CL', 'CL-PERP', 1e-4], ['SI', 'SI-PERP', 1e-4],
];
const FROM = Date.UTC(2026, 8, 26), SPLIT = Date.UTC(2026, 9, 3);

interface S { n: number; mean: number; t: number; win: number }
const st = (xs: number[]): S => {
  const n = xs.length;
  if (!n) return { n, mean: 0, t: 0, win: 0 };
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, n - 1));
  return { n, mean, t: sd > 0 ? mean / (sd / Math.sqrt(n)) : 0, win: xs.filter((x) => x > 0).length / n };
};
const f = (s: S) => (s.n ? `${s.mean >= 0 ? '+' : ''}${s.mean.toFixed(1)} t${s.t.toFixed(1)} ${Math.round(s.win * 100)}% n${s.n}` : '—').padEnd(24);

for (const [name, sym, fee] of M) {
  const file = `${dir}/vest_${sym}.json`;
  if (!existsSync(file)) continue;
  const rows = JSON.parse(readFileSync(file, 'utf8')) as Array<[number, number, number, number]>;
  const jumps: number[] = [];
  for (let k = 1; k < rows.length; k++) if (rows[k]![3] !== rows[k - 1]![3]) jumps.push((Math.abs(rows[k]![1] - rows[k - 1]![1]) / rows[k]![1]) * 1e4);
  jumps.sort((a, b) => a - b);
  const cost = (jumps[Math.floor(jumps.length / 2)] ?? 0) + 2 * fee * 1e4;
  const t0 = Math.floor(rows[0]![0] / 60_000) * 60_000;
  const n = Math.ceil((rows.at(-1)![0] - t0) / 60_000) + 1;
  const c = new Float64Array(n), ok = new Uint8Array(n), usd = new Float64Array(n), delta = new Float64Array(n);
  let j = 0, last = NaN, lastT = -1e15;
  for (let i = 0; i < n; i++) {
    const end = t0 + (i + 1) * 60_000;
    while (j < rows.length && rows[j]![0] < end) {
      const [ms, p, u, side] = rows[j]!;
      usd[i]! += u; delta[i]! += side > 0 ? u : -u; last = p; lastT = ms; j++;
    }
    c[i] = last; ok[i] = end - lastT <= 2 * 60_000 ? 1 : 0;
  }
  console.log(`\n${name} — round trip ${cost.toFixed(2)} bps.  cells: imbalance k × burst size; each = IS net | OOS net | both weeks GROSS (before costs), hold 30m`);
  for (const H of [15, 30, 60]) {
    console.log(` hold ${H}m`);
    for (const k of [0.2, 0.3, 0.5, 0.7]) {
      const line: string[] = [];
      for (const hot of [1.5, 2, 3, 4]) {
        const is: number[] = [], oos: number[] = [], gross: number[] = [];
        let next = 0;
        for (let i = 125; i + 1 + H < n; i++) {
          const t = t0 + (i + 1) * 60_000;
          if (t < FROM || i < next || !ok[i]) continue;
          let u5 = 0, d5 = 0, u120 = 0;
          for (let q = i - 4; q <= i; q++) { u5 += usd[q]!; d5 += delta[q]!; }
          for (let q = i - 119; q <= i; q++) u120 += usd[q]!;
          if (!(u5 > 0) || !(u120 > 0)) continue;
          const imb = d5 / u5;
          if (Math.abs(imb) <= k || u5 / (u120 / 24) <= hot) continue;
          const a = i + 1, b = i + 1 + H;
          if (!ok[a] || !ok[b]) continue;
          const g = -Math.sign(imb) * Math.log(c[b]! / c[a]!) * 1e4;
          gross.push(g);
          (t < SPLIT ? is : oos).push(g - cost);
          next = i + Math.max(H, 30);
        }
        line.push(`${hot}×: ${f(st(is))}| ${f(st(oos))}| g ${f(st(gross))}`);
      }
      console.log(`  k>${k}  ${line.join('  ')}`);
    }
  }
}
