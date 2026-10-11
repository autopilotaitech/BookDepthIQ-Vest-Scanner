// Replay the scanner's call logic on recorded Vest trades and grade it like the scorecard does.
//   node scripts/fetch-trades.mjs data 16 BTC-PERP ETH-PERP SOL-PERP NDX-USD-PERP SPX-USD-PERP
//   npx tsx scripts/replay-calls.ts data
import { readFileSync } from 'node:fs';
import { MarketStats } from '../src/scan/metrics';
import { TIMEFRAMES, becameActionable, regime, type RegimeState } from '../src/scan/regime';
import { liquidityScore } from '../src/scan/score';
import { changeBps, flowShare } from '../src/scan/relative';

const dir = process.argv[2]!;
// spread bps (measured live), taker fee per side (Vest exchangeInfo)
const MARKETS: Array<[string, string, number, number]> = [
  ['BTC', 'vest_BTC-PERP.json', 0.6, 0.0001],
  ['ETH', 'vest_ETH-PERP.json', 1.1, 0.0001],
  ['SOL', 'vest_SOL-PERP.json', 2.4, 0.0001],
  ['NQ', 'vest_NDX-USD-PERP.json', 0.32, 0.000025],
  ['ES', 'vest_SPX-USD-PERP.json', 0.6, 0.000025],
];
const FROM = Date.UTC(2026, 8, 26);
const SPLIT = Date.UTC(2026, 9, 3);
const HOLDS = [5, 15, 30];
const STEP = 15_000;

interface Sig { t: number; mkt: string; win: number; rule: string; dir: 1 | -1 }
const sigs: Sig[] = [];
const prices = new Map<string, { t: Float64Array; p: Float64Array }>();
const cost = new Map<string, number>();

// Candidate rules on top of the scanner's own state edge (entering BREAKOUT/TRENDING).
const RULES: Array<{ name: string; k: number; minTrades: number; flow: number; stateEdge: boolean }> = [
  { name: 'OLD (current scanner)', k: 0, minTrades: 0, flow: -9, stateEdge: true },
  { name: 'move ≥2× cost', k: 2, minTrades: 0, flow: -9, stateEdge: true },
  { name: 'move ≥3× cost', k: 3, minTrades: 0, flow: -9, stateEdge: true },
  { name: '≥3× cost + ≥5 trades', k: 3, minTrades: 5, flow: -9, stateEdge: true },
  { name: '≥3× cost + ≥5 trades + flow ≥20%', k: 3, minTrades: 5, flow: 0.2, stateEdge: true },
  { name: '≥5× cost + ≥5 trades + flow ≥20%', k: 5, minTrades: 5, flow: 0.2, stateEdge: true },
  { name: 'impulse only: ≥3× cost + ≥5 trades + flow ≥20%', k: 3, minTrades: 5, flow: 0.2, stateEdge: false },
];

for (const [mkt, file, spread, fee] of MARKETS) {
  const rows = JSON.parse(readFileSync(`${dir}/${file}`, 'utf8')) as Array<[number, number, number, number]>;
  const c = spread + 2 * fee * 1e4;
  cost.set(mkt, c);
  prices.set(mkt, { t: Float64Array.from(rows.map((r) => r[0])), p: Float64Array.from(rows.map((r) => r[1])) });
  for (const win of [1, 5] as const) {
    const tf = TIMEFRAMES[win];
    const st = new MarketStats();
    let i = 0;
    let prev: RegimeState | undefined;
    const last = new Map<string, number>();
    const spanMs = tf.effBars * tf.barMs;
    const t0 = Math.max(FROM, rows[0]![0]) - 75 * 60_000;
    for (let t = t0; t <= rows.at(-1)![0]; t += STEP) {
      while (i < rows.length && rows[i]![0] <= t) {
        const [ms, px, usd, side] = rows[i]!;
        st.addTrade(ms, px, usd / px, side > 0 ? 'buy' : 'sell');
        i++;
      }
      if (t % 60_000 === 0) st.prune(t);
      if (t < FROM) continue;
      const s5 = st.summary(t, 5 * 60_000);
      const liq = liquidityScore({ ...s5, spreadBps: spread, top5Usd: 200_000 });
      const sW = win >= 5 ? st.summary(t, win * 60_000) : s5;
      const bars = st.bars(t, tf.slowBars + tf.fastBars + 5, tf.barMs);
      const r = regime(bars, liq, sW.usdPerMin, undefined, tf);
      const entered = becameActionable(prev, r.state) && r.dir !== 0;
      prev = r.state;
      const move = changeBps(bars, tf.effBars);
      const span = st.summary(t, Math.max(spanMs, 60_000));
      const nTrades = span.tradesPerMin * (Math.max(spanMs, 60_000) / 60_000);
      const flow = flowShare(span.buyUsd, span.sellUsd);
      for (const rule of RULES) {
        let d: 0 | 1 | -1 = 0;
        if (rule.stateEdge) {
          if (!entered) continue;
          d = r.dir;
        } else {
          if (move === undefined || liq < 40) continue;
          d = move > 0 ? 1 : -1;
        }
        if (rule.k > 0 && (move === undefined || move * d < rule.k * c)) continue;
        if (nTrades < rule.minTrades) continue;
        if (rule.flow > -1 && (flow === undefined || flow * d < rule.flow)) continue;
        const key = rule.name;
        if (t - (last.get(key) ?? -Infinity) < 10 * 60_000) continue;
        last.set(key, t);
        sigs.push({ t, mkt, win, rule: rule.name, dir: d });
      }
    }
  }
}

const priceAt = (mkt: string, t: number): number | undefined => {
  const { t: ts, p } = prices.get(mkt)!;
  let lo = 0, hi = ts.length - 1, ans = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (ts[m]! <= t) { ans = m; lo = m + 1; } else hi = m - 1; }
  return ans < 0 || t - ts[ans]! > 3 * 60_000 ? undefined : p[ans];
};

const fmt = (xs: number[]) => {
  if (!xs.length) return '      n=0'.padEnd(30);
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, xs.length - 1));
  const tt = sd > 0 ? m / (sd / Math.sqrt(xs.length)) : 0;
  return `${m >= 0 ? '+' : ''}${m.toFixed(1)} t${tt.toFixed(1)} ${Math.round((xs.filter((x) => x > 0).length / xs.length) * 100)}% n=${xs.length}`.padEnd(30);
};

for (const win of [1, 5]) {
  console.log(`\n══════ ${win}-min window · net bps per call (mean, t-stat, win%, n) · IS = 09-26..10-02 · OOS = 10-03..10-10`);
  for (const rule of RULES) {
    const mine = sigs.filter((s) => s.win === win && s.rule === rule.name);
    console.log(`\n  ${rule.name}`);
    for (const h of HOLDS) {
      const grade = (list: Sig[], fade = false) =>
        list
          .map((s) => {
            const a = priceAt(s.mkt, s.t);
            const b = priceAt(s.mkt, s.t + h * 60_000);
            if (a === undefined || b === undefined) return undefined;
            return (fade ? -s.dir : s.dir) * (b / a - 1) * 1e4 - cost.get(s.mkt)!;
          })
          .filter((x): x is number => x !== undefined);
      const is = mine.filter((s) => s.t < SPLIT);
      const oos = mine.filter((s) => s.t >= SPLIT);
      console.log(`    ${String(h).padStart(2)}m  follow  IS ${fmt(grade(is))} OOS ${fmt(grade(oos))}   fade  IS ${fmt(grade(is, true))} OOS ${fmt(grade(oos, true))}`);
    }
  }
}
// Per market for the old rule, so one market can't hide behind the average.
console.log('\n══════ OLD rule by market, 1-min window, 5m hold, all days');
for (const [mkt] of MARKETS) {
  const xs = sigs
    .filter((s) => s.win === 1 && s.rule === RULES[0]!.name && s.mkt === mkt)
    .map((s) => { const a = priceAt(mkt, s.t); const b = priceAt(mkt, s.t + 5 * 60_000); return a && b ? s.dir * (b / a - 1) * 1e4 - cost.get(mkt)! : undefined; })
    .filter((x): x is number => x !== undefined);
  console.log(`  ${mkt.padEnd(4)} ${fmt(xs)}`);
}

// NQ / ES opening drive only: 8:30–10:30 Chicago (13:30–15:30 UTC while on CDT), weekdays.
console.log('\n══════ NQ + ES, 8:30–10:30 Chicago only · follow / fade · all days');
const rth = (t: number) => { const d = new Date(t); const m = d.getUTCHours() * 60 + d.getUTCMinutes(); const wd = d.getUTCDay(); return wd >= 1 && wd <= 5 && m >= 13 * 60 + 30 && m < 15 * 60 + 30; };
for (const win of [1, 5]) for (const rule of RULES) {
  const mine = sigs.filter((s) => s.win === win && s.rule === rule.name && (s.mkt === 'NQ' || s.mkt === 'ES') && rth(s.t));
  const g = (h: number, fade: boolean) => mine.map((s) => { const a = priceAt(s.mkt, s.t); const b = priceAt(s.mkt, s.t + h * 60_000); return a && b ? (fade ? -s.dir : s.dir) * (b / a - 1) * 1e4 - cost.get(s.mkt)! : undefined; }).filter((x): x is number => x !== undefined);
  console.log(`  ${win}m ${rule.name.padEnd(48)} 15m follow ${fmt(g(15, false))} fade ${fmt(g(15, true))}`);
}
