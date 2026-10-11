// Trend + levels setups: the scanner's calls. Pure: no I/O.
//
// A call needs THREE things, in this order:
//   1. a higher-timeframe trend (15-minute SuperTrend, the panel's own engine). No trend → no call,
//      so chop stays silent;
//   2. a level: prior-day high/low, today's high/low so far, or today's VWAP (the trading day
//      starts 17:00 Chicago, like CME);
//   3. a 1-minute close that either BREAKS the level in the trend's direction, or PULLS BACK to it
//      (within one round-trip cost) and moves away again in the trend's direction.
// One call per market per 30 minutes.

import { TrendEngine, type TrendConfig, type TrendDir } from './supertrend.js';

/** 15-minute candles, 10-candle ATR, 3× bands, flips on a close through the line. */
export const HTF_TREND: TrendConfig = { enabled: true, intervalSec: 900, numCandles: 10, multiplier: 3.0, switch: 'close', confirm: 1, volMult: 1.5, deltaMin: 0 };
/** Candles needed before the trend counts (ATR warm-up). */
export const HTF_MIN_CANDLES = 10;
export const SETUP_COOLDOWN_MS = 30 * 60_000;

const DAY_FMT = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' });
let dayCacheHour = NaN;
let dayCacheKey = '';

/** Trading-day key: the day starts 17:00 America/Chicago (DST-aware). Cached per hour: it is called
 * for every trade, including ~100k history trades when a tracker loads. */
export function tradingDay(t: number): string {
  const h = Math.floor(t / 3600_000);
  if (h !== dayCacheHour) {
    dayCacheHour = h;
    dayCacheKey = DAY_FMT.format(new Date(h * 3600_000 + 7 * 3600_000));
  }
  return dayCacheKey;
}

export interface Levels {
  pdh: number | undefined;
  pdl: number | undefined;
  hod: number | undefined;
  lod: number | undefined;
  vwap: number | undefined;
}

export type LevelName = 'prior-day high' | 'prior-day low' | "today's high" | "today's low" | 'VWAP';

export type SetupKind = 'break' | 'pullback';

export interface Setup {
  t: number;
  kind: SetupKind;
  dir: 1 | -1;
  level: LevelName;
  price: number; // the level
  close: number;
}

/**
 * One market's higher-timeframe state, fed every trade in time order (history first, then live).
 * `minuteClose()` is called once per finished minute and returns a setup when one fires.
 */
export class HtfTracker {
  private trend = new TrendEngine(HTF_TREND);
  private candles = 0;
  private day = '';
  private pdh: number | undefined;
  private pdl: number | undefined;
  private hod = -Infinity;
  private lod = Infinity;
  private pv = 0;
  private v = 0;
  private lastPrice: number | undefined;
  private lastT = -Infinity;
  /** Levels as they stood at the start of the current minute (a close may not test itself). */
  private minuteLevels: Levels = { pdh: undefined, pdl: undefined, hod: undefined, lod: undefined, vwap: undefined };
  private closes: number[] = [];
  private lastSetupAt = -Infinity;

  constructor(private readonly tick: number) {}

  addTrade(t: number, price: number, qty: number, side?: 'buy' | 'sell'): void {
    if (!(price > 0) || !(qty > 0) || t < this.lastT) return; // time order only
    const d = tradingDay(t);
    if (d !== this.day) {
      if (this.day) {
        this.pdh = this.hod;
        this.pdl = this.lod;
      }
      this.day = d;
      this.hod = -Infinity;
      this.lod = Infinity;
      this.pv = 0;
      this.v = 0;
    }
    this.hod = Math.max(this.hod, price);
    this.lod = Math.min(this.lod, price);
    this.pv += price * qty;
    this.v += qty;
    if (this.trend.onTrade(t, Math.round(price / this.tick), qty, side === 'buy')) this.candles++;
    this.lastPrice = price;
    this.lastT = t;
  }

  /** Higher-timeframe direction, neutral until the ATR has warmed up. */
  trendDir(): TrendDir {
    return this.candles >= HTF_MIN_CANDLES ? this.trend.snapshot().dir : 'neutral';
  }

  levels(): Levels {
    return {
      pdh: this.pdh,
      pdl: this.pdl,
      hod: Number.isFinite(this.hod) ? this.hod : undefined,
      lod: Number.isFinite(this.lod) ? this.lod : undefined,
      vwap: this.v > 0 ? this.pv / this.v : undefined,
    };
  }

  /**
   * Close the minute ending at `t`. `costBps` = a taker round trip on this market, used as the
   * "at the level" tolerance. Returns a setup or undefined. Needs a trade within the last 2 min.
   */
  minuteClose(t: number, costBps: number): Setup | undefined {
    const lv = this.minuteLevels;
    this.minuteLevels = this.levels();
    const c = this.lastPrice;
    if (c === undefined || t - this.lastT > 2 * 60_000) return undefined;
    const prev = this.closes.at(-1);
    this.closes.push(c);
    if (this.closes.length > 6) this.closes.shift();
    const dirStr = this.trendDir();
    if (dirStr === 'neutral' || prev === undefined || t - this.lastSetupAt < SETUP_COOLDOWN_MS) return undefined;
    const s = findSetup(dirStr === 'up' ? 1 : -1, lv, c, prev, this.closes.slice(0, -1), (c * costBps) / 1e4);
    if (!s) return undefined;
    this.lastSetupAt = t;
    return { t, ...s, close: c };
  }
}

/** The rule itself, separated for tests. `recent` = closes before this one (oldest first). */
export function findSetup(dir: 1 | -1, lv: Levels, close: number, prevClose: number, recent: number[], tol: number): Omit<Setup, 't' | 'close'> | undefined {
  const up = dir > 0;
  const breaks: Array<[LevelName, number | undefined]> = up
    ? [['prior-day high', lv.pdh], ["today's high", lv.hod], ['VWAP', lv.vwap]]
    : [['prior-day low', lv.pdl], ["today's low", lv.lod], ['VWAP', lv.vwap]];
  for (const [level, L] of breaks) {
    if (L === undefined) continue;
    if (up ? close > L + tol && prevClose <= L : close < L - tol && prevClose >= L) return { kind: 'break', dir, level, price: L };
  }
  const holds: Array<[LevelName, number | undefined]> = up
    ? [['VWAP', lv.vwap], ['prior-day high', lv.pdh], ['prior-day low', lv.pdl]]
    : [['VWAP', lv.vwap], ['prior-day low', lv.pdl], ['prior-day high', lv.pdh]];
  for (const [level, L] of holds) {
    if (L === undefined) continue;
    const touched = recent.some((x) => Math.abs(x - L) <= tol);
    const holding = up ? close > L + tol && close > prevClose : close < L - tol && close < prevClose;
    if (touched && holding) return { kind: 'pullback', dir, level, price: L };
  }
  return undefined;
}
