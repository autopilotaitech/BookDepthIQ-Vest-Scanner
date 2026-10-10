// The scanner's live engine: one public websocket for every market's depth + trades, periodic
// REST refreshes (24 h volume, sessions), a warm-up from recent trades, and the hourly history.
// Read-only: it never authenticates and never sends anything but SUBSCRIBE / PING.

import { buildSymbolTable, type SymbolTable } from '../src/vest/symbols';
import { VestMarketSocket } from '../src/vest/ws';
import { fetch24h, fetchExchangeInfo, fetchMarketHours, fetchOi, fetchTickersLatest, fetchTradesBefore, type MarketHoursAsset } from '../src/vest/rest';
import { crowding, forwardReturns, oiSkew, type Crowding } from '../src/scan/crowding';
import type { SymbolInfo } from '../src/vest/types';
import { MarketStats } from '../src/scan/metrics';
import { categoryOf, sessionAt, type Category, type SessionNow } from '../src/scan/score';
import { BASELINE_MIN_MINUTES, addHistory, addMinute, avgPerMin, hourIn, type HourMap } from '../src/scan/history';
import { liquidityScore } from '../src/scan/score';
import { TIMEFRAMES, regime, type Regime } from '../src/scan/regime';

export interface Market {
  info: SymbolInfo;
  display: string;
  category: Category;
  stats: MarketStats;
  vol24h: number;
  session: SessionNow;
  /** Vest's hourly funding rate (fraction); + longs pay shorts. */
  funding: number | undefined;
  /** (mark − index) ÷ index, in bps. */
  premiumBps: number | undefined;
  /** (long OI − short OI) ÷ total, −1 … +1. */
  oiSkew: number | undefined;
}

const HISTORY_KEY = 'scanner.hours.v1';
export const HISTORY_TZ = 'America/Chicago';
const RECORD_KEY = 'scanner.regime.v1';
const RECORD_MARKETS = 8; // top markets by 24 h volume
const RECORD_KEEP_MS = 2 * 24 * 3600_000;

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
  /** Added in v0.4 (older rows lack them). */
  price?: number;
  funding?: number;
  premiumBps?: number;
  oiSkew?: number;
  crowded?: string;
}

export class Engine {
  markets = new Map<string, Market>();
  status: 'starting' | 'live' | 'reconnecting' | 'error' = 'starting';
  statusDetail = '';
  warming = 0; // markets still warming up from history
  hours: HourMap = loadHours();
  records: RegimeRecord[] = loadRecords();
  backfilling = '';
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
        funding: undefined,
        premiumBps: undefined,
        oiSkew: undefined,
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
        this.markets.get(sym)?.stats.addTrade(msg.data.time, Number(msg.data.price), Number(msg.data.qty));
        this.changed();
      },
    });
    this.sock.start();
    for (const sym of this.markets.keys()) this.sock.subscribe(sym, ['depth', 'trades']);
    void this.refresh24h();
    void this.refreshFunding();
    this.timers.push(setInterval(() => void this.refreshFunding(), 60_000));
    void this.refreshSessions();
    void this.warmUp();
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
    this.lastMinute = minute;
    for (const m of this.markets.values()) m.stats.prune(now);
    this.changed();
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

  /** Every minute: funding, mark − index premium and open-interest skew for every market. */
  private async refreshFunding(): Promise<void> {
    try {
      const syms = [...this.markets.keys()];
      for (let i = 0; i < syms.length; i += 40) {
        for (const t of await fetchTickersLatest(syms.slice(i, i + 40))) {
          const m = this.markets.get(t.symbol);
          if (!m) continue;
          const f = Number(t.oneHrFundingRate);
          m.funding = Number.isFinite(f) ? f : undefined;
          const mark = Number(t.markPrice);
          const idx = Number(t.indexPrice);
          m.premiumBps = mark > 0 && idx > 0 ? ((mark - idx) / idx) * 1e4 : undefined;
        }
      }
      for (const o of await fetchOi()) {
        const m = this.markets.get(o.symbol);
        if (m) m.oiSkew = oiSkew(Number(o.longOi), Number(o.shortOi));
      }
      this.changed();
    } catch {
      /* funding columns stay as they were */
    }
  }

  crowdingOf(m: Market): Crowding {
    return crowding(m.funding, m.oiSkew);
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
          for (const r of rows) if (r.time >= now - 60 * 60_000) st.addTrade(r.time, Number(r.price), Number(r.qty));
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
    const crowdedMarkets = [...this.markets.values()].filter((m) => this.crowdingOf(m).crowded && !top.includes(m));
    for (const m of [...top, ...crowdedMarkets]) {
      const { score, regime: r } = this.regimeOf(m, now, 5 * 60_000);
      const c = this.crowdingOf(m);
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
        funding: m.funding,
        premiumBps: m.premiumBps,
        oiSkew: m.oiSkew,
        crowded: c.crowded,
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
      'time,market,price,score,vol_ratio,efficiency,rvol,breakout,state,funding_per_h,funding_apr,premium_bps,oi_skew,crowded,fwd_5m_pct,fwd_15m_pct,fwd_60m_pct',
      ...this.records.map(
        (r, i) =>
          `${new Date(r.t).toISOString()},${r.sym},${r.price ?? ''},${r.score ?? ''},${f(r.vol)},${f(r.eff)},${f(r.rvol)},${r.bo},${r.state},${f(r.funding, 7)},${r.funding === undefined ? '' : f(r.funding * 8760, 4)},${f(r.premiumBps, 2)},${f(r.oiSkew)},${r.crowded ?? ''},${f(fwd[i]![0], 4)},${f(fwd[i]![1], 4)},${f(fwd[i]![2], 4)}`,
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
