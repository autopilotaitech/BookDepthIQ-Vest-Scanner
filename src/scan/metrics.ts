// Per-market rolling statistics from Vest's public trade and depth streams. Pure: no I/O.

import { ladderScore } from '../book/stats.js';
import type { Bar } from './regime.js';

export interface Summary {
  /** $ traded per minute over the window. */
  usdPerMin: number;
  tradesPerMin: number;
  /** Median spread in basis points of mid (undefined before a two-sided book). */
  spreadBps: number | undefined;
  /** Median of min(top-5 bid $, top-5 ask $): size you could trade without walking far. */
  top5Usd: number | undefined;
  /** High − low of trade prices over the window, in bps of the last price. */
  rangeBps: number;
  /** Book updates per second. */
  updPerSec: number;
  /** Book is moving but nothing traded: Vest's market maker quoting an idle market. */
  quoted: boolean;
  /** Share of resting sizes that are whole multiples of one unit (market-maker ladder), 0–1. */
  ladder: number;
}

interface TradePt {
  t: number;
  price: number;
  usd: number;
}
interface DepthPt {
  t: number;
  spreadBps: number;
  top5Usd: number;
}

const KEEP_TRADES_MS = 60 * 60_000; // sparkline needs an hour
const KEEP_DEPTH_MS = 15 * 60_000;
const DEPTH_SAMPLE_MS = 1000; // keep at most one depth sample per second
/** Finest bar kept: 15 s, so the 1-minute scalping window can see a move inside a minute. */
export const BASE_BAR_MS = 15_000;

export class MarketStats {
  private trades: TradePt[] = [];
  private depth: DepthPt[] = [];
  private updates: number[] = [];
  private lastDepthAt = -Infinity;
  ladder = 0;
  /** 15-second bars of the price path (book mid + trades), bar start → bar. Kept 75 minutes.
   * Read back at 15 s (scalping window) or merged into 1-minute bars. */
  private barMap = new Map<number, Bar>();

  /** Fold a price into its minute's bar. */
  private mark(t: number, price: number): void {
    if (!(price > 0)) return;
    const m = Math.floor(t / BASE_BAR_MS) * BASE_BAR_MS;
    const b = this.barMap.get(m);
    if (!b) this.barMap.set(m, { t: m, o: price, h: price, l: price, c: price });
    else {
      b.h = Math.max(b.h, price);
      b.l = Math.min(b.l, price);
      if (t >= m) b.c = price;
    }
  }

  /**
   * Complete bars of `barMs` (a multiple of 15 s; default 1 minute) up to, not including, the
   * current bar, oldest first, at most `max` of them. Bars with no price are filled flat at the
   * previous close: no movement is information too.
   */
  bars(now: number, max = 75, barMs = 60_000): Bar[] {
    const step = Math.max(BASE_BAR_MS, Math.round(barMs / BASE_BAR_MS) * BASE_BAR_MS);
    const cur = Math.floor(now / step) * step;
    const keys = [...this.barMap.keys()].filter((k) => k < cur).sort((a, b) => a - b);
    if (!keys.length) return [];
    const out: Bar[] = [];
    let prev: Bar | undefined;
    const first = Math.max(Math.floor(keys[0]! / step) * step, cur - max * step);
    for (let m = first; m < cur; m += step) {
      let agg: Bar | undefined;
      for (let k = m; k < m + step; k += BASE_BAR_MS) {
        const b = this.barMap.get(k);
        if (!b) continue;
        agg = agg ? { t: m, o: agg.o, h: Math.max(agg.h, b.h), l: Math.min(agg.l, b.l), c: b.c } : { t: m, o: b.o, h: b.h, l: b.l, c: b.c };
      }
      if (agg) {
        out.push(agg);
        prev = agg;
      } else if (prev) out.push({ t: m, o: prev.c, h: prev.c, l: prev.c, c: prev.c });
    }
    return out;
  }

  addTrade(t: number, price: number, qty: number): void {
    if (!(price > 0) || !(qty > 0)) return;
    this.trades.push({ t, price, usd: price * qty });
    this.mark(t, price);
    // trades usually arrive in order; history backfill may not, so keep them sorted
    const n = this.trades.length;
    if (n > 1 && this.trades[n - 2]!.t > t) this.trades.sort((a, b) => a.t - b.t);
  }

  /** One `@depth` snapshot (price/qty strings, best first). */
  addDepth(t: number, bids: Array<[string, string]>, asks: Array<[string, string]>): void {
    this.updates.push(t);
    if (t - this.lastDepthAt < DEPTH_SAMPLE_MS) return;
    if (!bids.length || !asks.length) return;
    const bb = Number(bids[0]![0]);
    const ba = Number(asks[0]![0]);
    const mid = (bb + ba) / 2;
    if (!(mid > 0) || !(ba >= bb)) return;
    this.lastDepthAt = t;
    this.mark(t, mid);
    const top5 = (side: Array<[string, string]>) => side.slice(0, 5).reduce((x, l) => x + Number(l[0]) * Number(l[1]), 0);
    this.depth.push({ t, spreadBps: ((ba - bb) / mid) * 1e4, top5Usd: Math.min(top5(bids), top5(asks)) });
    this.ladder = ladderScore([...bids, ...asks].map((l) => Number(l[1]))).score;
  }

  /** Drop data older than what any view needs. */
  prune(now: number): void {
    const cutT = now - KEEP_TRADES_MS;
    let i = 0;
    while (i < this.trades.length && this.trades[i]!.t < cutT) i++;
    if (i) this.trades.splice(0, i);
    const cutD = now - KEEP_DEPTH_MS;
    while (this.depth.length && this.depth[0]!.t < cutD) this.depth.shift();
    while (this.updates.length && this.updates[0]! < cutD) this.updates.shift();
    const cutB = now - 75 * 60_000;
    for (const k of this.barMap.keys()) if (k < cutB) this.barMap.delete(k);
  }

  summary(now: number, windowMs: number): Summary {
    const from = now - windowMs;
    const mins = windowMs / 60_000;
    let usd = 0;
    let n = 0;
    let hi = -Infinity;
    let lo = Infinity;
    let last = 0;
    for (const tr of this.trades) {
      if (tr.t < from || tr.t > now) continue;
      usd += tr.usd;
      n++;
      hi = Math.max(hi, tr.price);
      lo = Math.min(lo, tr.price);
      last = tr.price;
    }
    const d = this.depth.filter((x) => x.t >= from && x.t <= now);
    const upd = this.updates.filter((x) => x >= from && x <= now).length;
    const updWindowSec = Math.min(windowMs, KEEP_DEPTH_MS) / 1000;
    const tradesPerMin = n / mins;
    const updPerSec = upd / updWindowSec;
    return {
      usdPerMin: usd / mins,
      tradesPerMin,
      spreadBps: median(d.map((x) => x.spreadBps)),
      top5Usd: median(d.map((x) => x.top5Usd)),
      rangeBps: n > 1 && last > 0 ? ((hi - lo) / last) * 1e4 : 0,
      updPerSec,
      quoted: n === 0 && upd > 0,
      ladder: this.ladder,
    };
  }

  /** $ traded in each of the last `minutes` whole minutes, oldest first (for sparklines). */
  perMinute(now: number, minutes = 60): number[] {
    const out = new Array<number>(minutes).fill(0);
    const end = Math.floor(now / 60_000) * 60_000 + 60_000;
    const start = end - minutes * 60_000;
    for (const tr of this.trades) {
      if (tr.t < start || tr.t >= end) continue;
      out[Math.floor((tr.t - start) / 60_000)]! += tr.usd;
    }
    return out;
  }
}

export function median(xs: number[]): number | undefined {
  if (!xs.length) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}
