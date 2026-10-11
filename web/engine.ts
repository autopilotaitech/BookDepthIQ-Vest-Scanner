// The scanner's live engine: one public websocket for every market's depth + trades, periodic
// REST refreshes (24 h volume, sessions), a warm-up from recent trades, and the hourly history.
// Read-only: it never authenticates and never sends anything but SUBSCRIBE / PING.

import { buildSymbolTable, type SymbolTable } from '../src/vest/symbols';
import { VestMarketSocket } from '../src/vest/ws';
import { fetch24h, fetchExchangeInfo, fetchMarketHours, fetchTradesBefore, type MarketHoursAsset } from '../src/vest/rest';
import { forwardReturns } from '../src/scan/crowding';
import type { SymbolInfo } from '../src/vest/types';
import { MarketStats } from '../src/scan/metrics';
import { categoryOf, sessionAt, type Category, type SessionNow } from '../src/scan/score';
import { BASELINE_MIN_MINUTES, addHistory, addMinute, avgPerMin, hourIn, type HourMap } from '../src/scan/history';
import { liquidityScore } from '../src/scan/score';
import { TIMEFRAMES, regime, type Regime } from '../src/scan/regime';
import { gradeCall, openCall, type Call } from '../src/scan/scorecard';
import { HtfTracker, tradingDay, type Setup } from '../src/scan/setup';
import { tickSizeOf } from '../src/vest/symbols';

export interface Market {
  info: SymbolInfo;
  display: string;
  category: Category;
  stats: MarketStats;
  vol24h: number;
  session: SessionNow;
}

const HISTORY_KEY = 'scanner.hours.v1';
export const HISTORY_TZ = 'America/Chicago';
const RECORD_KEY = 'scanner.regime.v1';
const RECORD_MARKETS = 8; // top markets by 24 h volume
const RECORD_KEEP_MS = 2 * 24 * 3600_000;
const CALLS_KEY = 'scanner.calls.v2'; // v2: trend + level setups (v1 held the old state calls)
const CALLS_KEEP_MS = 14 * 24 * 3600_000;
/** Markets given a higher-timeframe tracker: the most traded by 24 h volume. */
const HTF_MARKETS = 10;
/**
 * History per tracker: page back until it holds the previous trading day AND enough 15-min candles
 * of real trading (after a weekend or holiday that means going back to the last session, e.g.
 * Friday for NQ at Sunday's Globex open). Capped in time and pages.
 */
const HTF_MIN_BUCKETS = 40; // 15-min candles with trades (10 hours)
const HTF_MAX_BACK_MS = 6 * 24 * 3600_000;
const HTF_MAX_PAGES = 300;

/** A setup that fired, for alerts and the table. */
export interface SetupEvent {
  sym: string;
  setup: Setup;
}

interface LiveTrade {
  id: string;
  t: number;
  price: number;
  qty: number;
  side: 'buy' | 'sell';
}

/** One recorded minute of regime numbers, for tuning the thresholds later. */
export interface RegimeRecord {
  t: number;
  sym: string;
  score: number | undefined;
  vol: number | undefined;
  eff: number | undefined;
  rvol: number | undefined;
  bo: number;
  state: string;
  /** Added in v0.4 (older rows lack it). */
  price?: number;
}

export class Engine {
  markets = new Map<string, Market>();
  status: 'starting' | 'live' | 'reconnecting' | 'error' = 'starting';
  statusDetail = '';
  warming = 0; // markets still warming up from history
  hours: HourMap = loadHours();
  records: RegimeRecord[] = loadRecords();
  backfilling = '';
  /** Trend + level calls (scorecard), 14 days. */
  calls: Call[] = loadCalls();
  /** Higher-timeframe trend + levels per market (top markets only), by wire symbol. */
  htf = new Map<string, HtfTracker>();
  /** Setups as they fire (newest last); the panel turns new ones into alerts. */
  events: SetupEvent[] = [];
  /** Latest setup per market (display symbol), for the table. */
  lastSetup = new Map<string, Setup>();
  /** Live trades held while a market's history is loading, so the tracker sees time order. */
  private htfBuffer = new Map<string, LiveTrade[]>();
  private htfLoading = false;
  private table: SymbolTable | null = null;
  private sock: VestMarketSocket | null = null;
  private hoursAsset = new Map<number, MarketHoursAsset>();
  private timers: ReturnType<typeof setInterval>[] = [];
  private lastMinute = Math.floor(Date.now() / 60_000);
  /** Only minutes that started after this were fully observed (and may be recorded). */
  private readonly startedAt = Date.now();
  private listeners = new Set<() => void>();
  private dirty = false;

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Coalesce redraws to ~4 per second: 176 streams would otherwise re-render constantly. */
  private changed(): void {
    if (this.dirty) return;
    this.dirty = true;
    setTimeout(() => {
      this.dirty = false;
      for (const f of this.listeners) f();
    }, 250);
  }

  async start(): Promise<void> {
    let infos: SymbolInfo[];
    try {
      infos = (await fetchExchangeInfo()).filter((i) => i.tradingStatus === 'TRADING');
    } catch (e) {
      this.status = 'error';
      this.statusDetail = `exchangeInfo failed: ${(e as Error).message}`;
      this.changed();
      return;
    }
    this.table = buildSymbolTable(infos);
    for (const info of infos) {
      this.markets.set(info.symbol, {
        info,
        display: info.displaySymbol ?? info.symbol,
        category: categoryOf(info.categories, undefined),
        stats: new MarketStats(),
        vol24h: 0,
        session: { session: 'unknown', open: true },
      });
    }
    this.sock = new VestMarketSocket({
      onStatus: (s, d) => {
        this.status = s === 'open' ? 'live' : 'reconnecting';
        this.statusDetail = d ?? '';
        this.changed();
      },
      onDepth: (sym, msg) => {
        this.markets.get(sym)?.stats.addDepth(Date.now(), msg.data.bids, msg.data.asks);
        this.changed();
      },
      onTrade: (sym, msg) => {
        const d = msg.data;
        this.markets.get(sym)?.stats.addTrade(d.time, Number(d.price), Number(d.qty), d.side);
        const buf = this.htfBuffer.get(sym);
        if (buf) buf.push({ id: d.id, t: d.time, price: Number(d.price), qty: Number(d.qty), side: d.side });
        else this.htf.get(sym)?.addTrade(d.time, Number(d.price), Number(d.qty), d.side);
        this.changed();
      },
    });
    this.sock.start();
    for (const sym of this.markets.keys()) this.sock.subscribe(sym, ['depth', 'trades']);
    void this.refresh24h();

    void this.refreshSessions();
    void this.warmUp().then(() => this.loadHtf());
    this.timers.push(setInterval(() => void this.loadHtf(), 10 * 60_000));
    this.timers.push(setInterval(() => void this.refresh24h(), 5 * 60_000));
    this.timers.push(setInterval(() => void this.refreshSessions(), 5 * 60_000));
    this.timers.push(setInterval(() => this.tick(), 5_000));
    this.changed();
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.sock?.stop();
  }

  /** Every 5 s: prune old data; on each new minute, record the finished minute into the hour map. */
  private tick(): void {
    const now = Date.now();
    const minute = Math.floor(now / 60_000);
    if (minute > this.lastMinute && this.status === 'live' && (minute - 1) * 60_000 >= this.startedAt) {
      const start = (minute - 1) * 60_000;
      for (const [sym, m] of this.markets) {
        const usd = m.stats.perMinute(start + 30_000, 1)[0] ?? 0;
        if (m.session.open) addMinute(this.hours, sym, start, usd, HISTORY_TZ);
      }
      saveHours(this.hours);
      this.recordRegimes(now);
    }
    if (minute > this.lastMinute) this.checkSetups(minute * 60_000);
    this.lastMinute = minute;
    for (const m of this.markets.values()) m.stats.prune(now);
    this.gradeCalls(now);
    this.changed();
  }

  /** On each minute close: every tracked market whose trend + level setup fires opens a call. */
  private checkSetups(minuteEnd: number): void {
    let added = false;
    for (const [sym, tr] of this.htf) {
      const m = this.markets.get(sym);
      if (!m || !m.session.open) continue;
      const spread = m.stats.summary(minuteEnd, 5 * 60_000).spreadBps;
      if (spread === undefined) continue;
      const fee = Number(m.info.takerFee ?? 0) || 0;
      const setup = tr.minuteClose(minuteEnd, spread + 2 * fee * 1e4);
      if (!setup) continue;
      this.calls.push(openCall(minuteEnd, m.display, setup.kind, setup.level, setup.dir, setup.close, spread, fee));
      this.events.push({ sym: m.display, setup });
      if (this.events.length > 50) this.events.shift();
      this.lastSetup.set(m.display, setup);
      added = true;
    }
    if (added) this.saveCalls();
  }

  /**
   * Load ~2 days of trades into a higher-timeframe tracker for each of the most traded markets
   * that has none yet. Live trades are buffered meanwhile and replayed after, in time order.
   */
  private async loadHtf(): Promise<void> {
    if (this.htfLoading) return;
    this.htfLoading = true;
    try {
      const top = [...this.markets.values()].filter((m) => m.vol24h > 0).sort((a, b) => b.vol24h - a.vol24h).slice(0, HTF_MARKETS);
      for (const m of top) {
        const sym = m.info.symbol;
        if (this.htf.has(sym)) continue;
        this.htfBuffer.set(sym, []);
        const to = Date.now();
        const limit = to - HTF_MAX_BACK_MS;
        const today = tradingDay(to);
        const rows: LiveTrade[] = [];
        const buckets = new Set<number>();
        const days = new Set<string>();
        let end = to;
        try {
          for (let page = 0; page < HTF_MAX_PAGES && end > limit; page++) {
            const got = await fetchTradesBefore(sym, end, 1000);
            if (!got.length) break;
            for (const r of got) {
              rows.push({ id: r.id, t: r.time, price: Number(r.price), qty: Number(r.qty), side: r.side });
              buckets.add(Math.floor(r.time / 900_000));
            }
            const oldest = got[got.length - 1]!.time;
            days.add(tradingDay(oldest));
            if (oldest >= end) break;
            end = oldest;
            // Stop once a full earlier trading day is in hand: we are into the day before it.
            const earlier = [...days].filter((d) => d < today).sort();
            if (buckets.size >= HTF_MIN_BUCKETS && earlier.length >= 2) break;
          }
        } catch {
          this.htfBuffer.delete(sym);
          continue; // try again on the next round
        }
        const seen = new Set(rows.map((r) => r.id));
        const all = [...rows, ...(this.htfBuffer.get(sym) ?? []).filter((r) => !seen.has(r.id))].sort((a, b) => a.t - b.t);
        const tr = new HtfTracker(tickSizeOf(m.info));
        for (const r of all) tr.addTrade(r.t, r.price, r.qty, r.side);
        this.htfBuffer.delete(sym);
        this.htf.set(sym, tr);
        this.changed();
      }
    } finally {
      this.htfLoading = false;
    }
  }

  /** Grade calls whose 15/30/60-minute read has come due. */
  private gradeCalls(now: number): void {
    let dirty = false;
    const byDisplay = new Map([...this.markets.values()].map((m) => [m.display, m]));
    for (const c of this.calls) {
      if (c.net.every((x) => x !== undefined)) continue;
      if (gradeCall(c, now, byDisplay.get(c.sym)?.stats.lastPrice())) dirty = true;
    }
    if (dirty) this.saveCalls();
  }

  private saveCalls(): void {
    const cut = Date.now() - CALLS_KEEP_MS;
    while (this.calls.length && this.calls[0]!.t < cut) this.calls.shift();
    try {
      localStorage.setItem(CALLS_KEY, JSON.stringify(this.calls));
    } catch {
      /* storage full or unavailable: keep in memory */
    }
  }

  clearCalls(): void {
    this.calls = [];
    try {
      localStorage.removeItem(CALLS_KEY);
    } catch {
      /* nothing stored */
    }
    this.changed();
  }

  /** Market by display symbol (e.g. a benchmark), resolved through the symbol table. */
  byDisplay(name: string): Market | undefined {
    const info = this.table?.resolve(name);
    return info ? this.markets.get(info.symbol) : undefined;
  }

  private async refresh24h(): Promise<void> {
    try {
      for (const t of await fetch24h()) {
        const m = this.markets.get(t.symbol);
        if (m) m.vol24h = Number(t.quoteVolume) || 0;
      }
      this.changed();
    } catch {
      /* the table still works on live data */
    }
  }

  private async refreshSessions(): Promise<void> {
    const ids = [...new Set([...this.markets.values()].map((m) => m.info.assetId).filter((x): x is number => typeof x === 'number'))];
    if (!ids.length) return;
    try {
      const now = Date.now();
      for (const a of await fetchMarketHours(ids, now - 60_000, now + 24 * 3600_000)) this.hoursAsset.set(a.assetId, a);
      this.updateSessions();
    } catch {
      /* sessions stay 'unknown' (treated as open) */
    }
  }

  /** Re-derive each market's session from the cached schedule (cheap; the panel calls it on render
   * with notify=false so a redraw never schedules another redraw). */
  updateSessions(now = Date.now(), notify = true): void {
    for (const m of this.markets.values()) {
      const a = m.info.assetId !== undefined ? this.hoursAsset.get(m.info.assetId) : undefined;
      m.session = sessionAt(a, now);
      if (m.category === 'other' || m.category === 'stock') m.category = categoryOf(m.info.categories, a?.key?.assetType);
    }
    if (notify) this.changed();
  }

  /** One page of recent trades per market (≤ 1000, enough for the 15-minute window on all but NQ). */
  private async warmUp(): Promise<void> {
    const syms = [...this.markets.keys()];
    this.warming = syms.length;
    const now = Date.now();
    let i = 0;
    const worker = async () => {
      while (i < syms.length) {
        const sym = syms[i++]!;
        try {
          const rows = await fetchTradesBefore(sym, now, 1000);
          const st = this.markets.get(sym)!.stats;
          for (const r of rows) if (r.time >= now - 60 * 60_000) st.addTrade(r.time, Number(r.price), Number(r.qty), r.side);
        } catch {
          /* skip: live trades fill in */
        }
        this.warming--;
        this.changed();
      }
    };
    await Promise.all(Array.from({ length: 6 }, worker));
  }

  /**
   * Backfill "liquid by hour" for the most-traded markets: page back through up to `hours` of
   * trades (≤ 40 pages each), then bucket by hour. Quiet minutes count as $0.
   */
  async backfillHours(top = 12, hours = 24): Promise<void> {
    const list = [...this.markets.values()].sort((a, b) => b.vol24h - a.vol24h).slice(0, top);
    const to = Date.now();
    const from = to - hours * 3600_000;
    for (const m of list) {
      this.backfilling = m.display;
      this.changed();
      const trades: Array<{ t: number; usd: number }> = [];
      let end = to;
      let reached = from;
      try {
        for (let page = 0; page < 40 && end > from; page++) {
          const rows = await fetchTradesBefore(m.info.symbol, end, 1000);
          if (!rows.length) {
            reached = from;
            break;
          }
          for (const r of rows) trades.push({ t: r.time, usd: Number(r.price) * Number(r.qty) });
          const oldest = rows[rows.length - 1]!.time;
          reached = Math.max(from, oldest);
          if (oldest >= end) break;
          end = oldest;
        }
      } catch {
        continue;
      }
      // Only the span actually covered is counted (a capped page walk may stop short of `from`).
      addHistory(this.hours, m.info.symbol, trades, reached, to, HISTORY_TZ);
    }
    this.backfilling = '';
    saveHours(this.hours);
    this.changed();
  }

  /** Regime for a market right now: liquidity score, volatility, trend vs chop, relative volume. */
  regimeOf(m: Market, now: number, windowMs: number): { score: number | undefined; regime: Regime } {
    const s = m.stats.summary(now, windowMs);
    // "Can I get filled here?" needs a steadier read than one minute: Vest's tape is thin (ES can
    // print ~2 trades/min), so a 1-minute window would call good markets dead between prints.
    // Liquidity always uses at least 5 minutes; the window drives the regime timing and $/min.
    const liqSummary = windowMs >= 5 * 60_000 ? s : m.stats.summary(now, 5 * 60_000);
    const score = m.session.open ? liquidityScore(liqSummary) : undefined;
    const usual = avgPerMin(this.hours, m.info.symbol, hourIn(now, HISTORY_TZ), BASELINE_MIN_MINUTES);
    const tf = windowMs <= 60_000 ? TIMEFRAMES[1] : windowMs <= 5 * 60_000 ? TIMEFRAMES[5] : TIMEFRAMES[15];
    return { score, regime: regime(m.stats.bars(now, tf.slowBars + tf.fastBars + 5, tf.barMs), score, s.usdPerMin, usual, tf) };
  }

  /** Once a minute: keep the top markets' regime numbers (2 days) so thresholds can be tuned. */
  private recordRegimes(now: number): void {
    const top = [...this.markets.values()].sort((a, b) => b.vol24h - a.vol24h).slice(0, RECORD_MARKETS);
    for (const m of top) {
      const { score, regime: r } = this.regimeOf(m, now, 5 * 60_000);
      this.records.push({
        t: now,
        sym: m.display,
        score,
        vol: r.volRatio,
        eff: r.eff,
        rvol: r.rvol,
        bo: r.breakout,
        state: r.state,
        price: m.stats.lastPrice(),
      });
    }
    const cut = now - RECORD_KEEP_MS;
    while (this.records.length && this.records[0]!.t < cut) this.records.shift();
    try {
      localStorage.setItem(RECORD_KEY, JSON.stringify(this.records));
    } catch {
      /* storage full or unavailable: keep in memory */
    }
  }

  /** The recorded minutes as CSV (for tuning). */
  recordsCsv(): string {
    const f = (v: number | undefined, d = 3) => (v === undefined || !Number.isFinite(v) ? '' : v.toFixed(d));
    const fwd = forwardReturns(this.records.map((r) => ({ t: r.t, sym: r.sym, price: r.price })), [5, 15, 60]);
    return [
      'time,market,price,score,vol_ratio,efficiency,rvol,breakout,state,fwd_5m_pct,fwd_15m_pct,fwd_60m_pct',
      ...this.records.map(
        (r, i) =>
          `${new Date(r.t).toISOString()},${r.sym},${r.price ?? ''},${r.score ?? ''},${f(r.vol)},${f(r.eff)},${f(r.rvol)},${r.bo},${r.state},${f(fwd[i]![0], 4)},${f(fwd[i]![1], 4)},${f(fwd[i]![2], 4)}`,
      ),
    ].join('\n');
  }

  clearHours(): void {
    this.hours = {};
    saveHours(this.hours);
    this.changed();
  }

  resolve(name: string): SymbolInfo | undefined {
    return this.table?.resolve(name);
  }
}

function loadHours(): HourMap {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    return raw ? (JSON.parse(raw) as HourMap) : {};
  } catch {
    return {};
  }
}

function loadCalls(): Call[] {
  try {
    const raw = localStorage.getItem(CALLS_KEY);
    return raw ? (JSON.parse(raw) as Call[]) : [];
  } catch {
    return [];
  }
}

function loadRecords(): RegimeRecord[] {
  try {
    const raw = localStorage.getItem(RECORD_KEY);
    return raw ? (JSON.parse(raw) as RegimeRecord[]) : [];
  } catch {
    return [];
  }
}

function saveHours(h: HourMap): void {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(h));
  } catch {
    /* storage unavailable: the heat map just won't persist */
  }
}
