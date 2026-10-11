import { useEffect, useMemo, useRef, useState } from 'react';
import { Engine, type Market } from './engine';
import type { Category } from '../src/scan/score';
import { avgPerMin } from '../src/scan/history';
import type { Summary } from '../src/scan/metrics';
import { TIMEFRAMES, atr, type Regime, type RegimeState } from '../src/scan/regime';
import { benchmarkFor, flowDiverges, flowShare, relativeBps } from '../src/scan/relative';
import { HORIZONS_MIN, MIN_TRUSTED, callsCsv, scorecard, type Grade } from '../src/scan/scorecard';
import type { Setup } from '../src/scan/setup';
import { ROOM_GOOD, ROOM_OK, sizeCheck, type SizeCheck } from '../src/scan/size';

// Per-viewer settings (window, filter, alerts, sort) in localStorage; guarded, defaults always work.
interface Prefs {
  windowMin: 1 | 5 | 15;
  category: 'all' | Category;
  openOnly: boolean;
  alertsOn: boolean;
  /** Hide CHOP and DEAD markets. */
  hideChop: boolean;
  sort: 'opp' | 'score' | 'usd' | 'trades' | 'spread' | 'depth' | 'vol24h' | 'vol' | 'eff' | 'rs' | 'flow' | 'room';
  /** Your trade size in $ notional, for the size check. */
  sizeUsd: number;
}
const PREFS_KEY = 'scanner.prefs.v3';
const DEFAULT_PREFS: Prefs = { windowMin: 1, category: 'all', openOnly: true, alertsOn: false, hideChop: false, sort: 'opp', sizeUsd: 5000 };

const STATE_LABEL: Record<RegimeState, string> = { breakout: 'BREAKOUT', trending: 'TRENDING', expanding: 'EXPANDING', coiling: 'COILING', chop: 'CHOP', quiet: 'QUIET', dead: 'DEAD', warming: 'WARMING' };
const STATE_TITLE: Record<RegimeState, string> = {
  breakout: 'beyond its recent high/low (15 min on the 1-min window, 60 min otherwise) with volatility ≥ 1.5× and a clean move. A move, not an entry: in a 2-week replay, following these lost money after costs. Check the scorecard.',
  trending: 'moving one way cleanly (efficiency ≥ 0.5) with volatility ≥ 1.2×. A move, not an entry: in a 2-week replay, following these lost money after costs. Check the scorecard.',
  expanding: 'volatility ≥ 1.5× but no clean direction yet: watch',
  chop: 'moving back and forth (efficiency < 0.3): skip',
  coiling: 'range squeezed to ≤ 0.6× normal while trading is at least usual for the hour (needs RVOL): watch for the break',
  quiet: 'liquid but calm',
  dead: 'not liquid enough to fill (score < 40) or quoted only',
  warming: 'collecting at least 20 one-minute bars',
};
function loadPrefs(): Prefs {
  try {
    return { ...DEFAULT_PREFS, ...(JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as Partial<Prefs>) };
  } catch {
    return DEFAULT_PREFS;
  }
}

const CATS: Array<{ id: Prefs['category']; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'index', label: 'Index' },
  { id: 'crypto', label: 'Crypto' },
  { id: 'stock', label: 'Stocks' },
  { id: 'etf', label: 'ETFs' },
  { id: 'commodity', label: 'Commodities' },
  { id: 'fx', label: 'FX' },
  { id: 'other', label: 'Other' },
];

const fmtUsd = (v: number | undefined) =>
  v === undefined ? '—' : v >= 1e9 ? `$${(v / 1e9).toFixed(2)}B` : v >= 1e6 ? `$${(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `$${(v / 1e3).toFixed(0)}k` : v > 0 ? `$${v.toFixed(0)}` : '$0';
const SESSION_LABEL: Record<string, string> = { regular: 'regular', after_hours: 'after hours', overnight: 'overnight', pre_market: 'pre-market', premarket: 'pre-market', extended: 'extended', open: 'open', closed: 'closed', unknown: '—' };

interface Row {
  m: Market;
  s: Summary;
  score: number | undefined;
  r: Regime;
  spark: number[];
  /** Benchmark display symbol and this market's move minus the benchmark's, bps. */
  bench: string | undefined;
  rs: number | undefined;
  /** Aggressive buy − sell share of $ over at least 5 min, −1 … +1. */
  flow: number | undefined;
  size: SizeCheck | undefined;
}

function Spark({ data, tone }: { data: number[]; tone: string }) {
  const max = Math.max(1e-9, ...data);
  const pts = data.map((v, i) => `${((i / Math.max(1, data.length - 1)) * 110).toFixed(1)},${(20 - (v / max) * 17).toFixed(1)}`).join(' ');
  const last = data.length ? 20 - (data[data.length - 1]! / max) * 17 : 20;
  return (
    <svg className="spark" width="110" height="22" viewBox="0 0 110 22" aria-hidden="true">
      <polyline points={pts} fill="none" stroke={tone} strokeWidth="1.5" strokeLinejoin="round" />
      <circle cx="110" cy={last.toFixed(1)} r="2" fill={tone} />
    </svg>
  );
}

function GradeLine({ g }: { g: Grade }) {
  return (
    <span>
      <span className={g.avgBps! > 0 ? 'up' : 'down'}>
        {g.avgBps! > 0 ? '+' : ''}
        {g.avgBps!.toFixed(1)} bps
      </span>{' '}
      · {Math.round(g.winRate! * 100)}% win · n={g.n}
    </span>
  );
}

/** "▲ BREAK prior-day high 25,120" */
function setupText(s: Setup): string {
  const px = s.price >= 1000 ? s.price.toLocaleString(undefined, { maximumFractionDigits: 2 }) : String(+s.price.toPrecision(6));
  return `${s.dir > 0 ? '▲' : '▼'} ${s.kind === 'break' ? 'BREAK' : 'PULLBACK held'} ${s.level} ${px}`;
}

export function App() {
  const engine = useMemo(() => new Engine(), []);
  const [, setTick] = useState(0);
  const [prefs, setPrefs] = useState<Prefs>(loadPrefs);
  const [toast, setToast] = useState<string>('');
  const alerted = useRef(0); // engine.events already alerted

  useEffect(() => {
    const off = engine.subscribe(() => setTick((n) => n + 1));
    void engine.start();
    return () => {
      off();
      engine.stop();
    };
  }, [engine]);

  const update = (p: Partial<Prefs>) => {
    const next = { ...prefs, ...p };
    setPrefs(next);
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(next));
    } catch {
      /* not persisted */
    }
  };

  const now = Date.now();
  engine.updateSessions(now, false);
  const windowMs = prefs.windowMin * 60_000;
  const tf = TIMEFRAMES[prefs.windowMin];
  const barsOf = (m: Market) => m.stats.bars(now, tf.slowBars + tf.fastBars + 5, tf.barMs);
  const benchBars = new Map<string, ReturnType<typeof barsOf>>();
  const rows: Row[] = [...engine.markets.values()].map((m) => {
    const s = m.stats.summary(now, windowMs);
    const { score, regime: r } = engine.regimeOf(m, now, windowMs);
    // Relative strength over the trend span; flow over ≥ 5 min (Vest's tape is thin, like liquidity).
    const bench = benchmarkFor(m.display, m.category);
    let rs: number | undefined;
    if (bench) {
      if (!benchBars.has(bench)) {
        const bm = engine.byDisplay(bench);
        benchBars.set(bench, bm ? barsOf(bm) : []);
      }
      rs = relativeBps(barsOf(m), benchBars.get(bench)!, tf.effBars);
    }
    const fs = windowMs >= 5 * 60_000 ? s : m.stats.summary(now, 5 * 60_000);
    // Size check: a typical 1-minute move (ATR of 1-min bars) and a round trip, at your size.
    const size = sizeCheck(prefs.sizeUsd, m.stats.lastPrice(), atr(m.stats.bars(now, 20, 60_000), 15), fs.spreadBps, Number(m.info.takerFee ?? 0) || 0, fs.top5Usd);
    return { m, s, score, r, spark: m.stats.perMinute(now, 60), bench, rs, flow: flowShare(fs.buyUsd, fs.sellUsd), size };
  });

  // Alerts: a trend + level setup firing (the scanner's calls). Events alerted once each.
  useEffect(() => {
    const evs = engine.events;
    if (alerted.current > evs.length) alerted.current = 0;
    for (const e of evs.slice(alerted.current)) {
      if (!prefs.alertsOn) continue;
      const msg = `${e.sym} ${setupText(e.setup)} · 15m trend ${e.setup.dir > 0 ? 'up' : 'down'}`;
      setToast(msg);
      const chrome = (globalThis as { chrome?: { notifications?: { create(o: object): void } } }).chrome;
      try {
        chrome?.notifications?.create({ type: 'basic', iconUrl: 'icon128.png', title: 'Vest Liquidity Scanner', message: msg });
      } catch {
        /* in-page toast only */
      }
    }
    alerted.current = evs.length;
  });

  const visible = rows
    .filter((r) => prefs.category === 'all' || r.m.category === prefs.category)
    .filter((r) => !prefs.openOnly || r.m.session.open)
    .filter((r) => !prefs.hideChop || (r.r.state !== 'chop' && r.r.state !== 'dead'))
    .sort((a, b) => {
      const k = prefs.sort;
      const v = (r: Row) =>
        k === 'opp' ? r.r.opportunity : k === 'room' ? (r.size?.ratio ?? -1) : k === 'rs' ? (r.rs ?? -1e9) : k === 'flow' ? (r.flow ?? -9) : k === 'vol' ? (r.r.volRatio ?? -1) : k === 'eff' ? Math.abs(r.r.eff ?? 0) : k === 'score' ? (r.score ?? -1) : k === 'usd' ? r.s.usdPerMin : k === 'trades' ? r.s.tradesPerMin : k === 'spread' ? -(r.s.spreadBps ?? 1e9) : k === 'depth' ? (r.s.top5Usd ?? 0) : r.m.vol24h;
      return v(b) - v(a);
    });

  // Row click: open the market on Vest, reusing one tab. The #bdiq-switch marker tells the
  // BookDepthIQ-Vest panel (if installed) to switch to the same market; Vest itself ignores it.
  const vestTab = useRef<number | undefined>(undefined);
  const open = async (m: Market) => {
    const url = `https://next.vestmarkets.com/trade/${encodeURIComponent(m.display)}#bdiq-switch`;
    type Tab = { id?: number };
    const chrome = (globalThis as { chrome?: { tabs?: { create(o: { url: string }): Promise<Tab>; update(id: number, o: { url: string; active: boolean }): Promise<Tab> } } }).chrome;
    if (!chrome?.tabs) {
      window.open(url, '_blank', 'noopener');
      return;
    }
    if (vestTab.current !== undefined) {
      try {
        await chrome.tabs.update(vestTab.current, { url, active: true });
        return;
      } catch {
        vestTab.current = undefined; // closed
      }
    }
    vestTab.current = (await chrome.tabs.create({ url })).id;
  };

  const th = (k: Prefs['sort'], label: string, title: string) => (
    <th aria-sort={prefs.sort === k ? 'descending' : 'none'}>
      <button className={prefs.sort === k ? 'on' : ''} title={title} onClick={() => update({ sort: k })}>
        {label}
      </button>
    </th>
  );

  // Heat map: top 12 markets by 24 h volume, average $/min per hour (Chicago).
  const heatMarkets = [...engine.markets.values()].sort((a, b) => b.vol24h - a.vol24h).slice(0, 12);
  const heatMax = Math.max(1, ...heatMarkets.flatMap((m) => Array.from({ length: 24 }, (_, h) => avgPerMin(engine.hours, m.info.symbol, h) ?? 0)));
  const nowHour = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hour: '2-digit', hourCycle: 'h23' }).format(new Date()));

  return (
    <div className="app">
      <header className="bar">
        <span className="title">VEST LIQUIDITY SCANNER</span>
        <span className={`chip ${engine.status === 'live' ? 'live' : engine.status === 'error' ? 'closed' : 'ah'}`} title={engine.statusDetail}>
          <i />
          {engine.markets.size} markets · {engine.status}
        </span>
        {engine.warming > 0 && <span className="muted">warming up {engine.warming}…</span>}
        <span className="spacer" />
        <label>
          window
          <select value={prefs.windowMin} onChange={(e) => update({ windowMin: Number(e.target.value) as 1 | 5 | 15 })} title="1 min = scalping: 15-second bars, volatility over the last minute vs 15 min">
            <option value={1}>1 min (scalp)</option>
            <option value={5}>5 min</option>
            <option value={15}>15 min</option>
          </select>
        </label>
        <label>
          <input type="checkbox" checked={prefs.openOnly} onChange={(e) => update({ openOnly: e.target.checked })} /> open now only
        </label>
        <label title="hide markets that are chopping or too thin to fill">
          <input type="checkbox" checked={prefs.hideChop} onChange={(e) => update({ hideChop: e.target.checked })} /> hide chop
        </label>
        <label title="your trade size in $ notional (price × units), for the Your size column">
          size $
          <input type="number" min={0} step={500} value={prefs.sizeUsd} onChange={(e) => update({ sizeUsd: Math.max(0, Number(e.target.value) || 0) })} />
        </label>
        <label title="notify when a trend + level setup fires (15-min trend, then a break of or pullback to the prior-day high/low, today's high/low or VWAP)">
          <input type="checkbox" checked={prefs.alertsOn} onChange={(e) => update({ alertsOn: e.target.checked })} /> alert on setups
        </label>
      </header>

      <nav className="cats" aria-label="market type">
        {CATS.map((c) => (
          <button key={c.id} className={prefs.category === c.id ? 'on' : ''} onClick={() => update({ category: c.id })}>
            {c.label}
          </button>
        ))}
      </nav>

      {toast && (
        <div className="toast" role="status" onClick={() => setToast('')}>
          🔔 {toast} <span className="muted">(click to dismiss)</span>
        </div>
      )}

      <div className="tablewrap">
        <table>
          <thead>
            <tr>
              <th>Market</th>
              {th('opp', 'Opportunity', 'liquidity × volatility expansion × clean direction, 0–100')}
              <th title="15-minute SuperTrend (the panel's engine), from ~2 days of trades. Tracked for the 10 most traded markets; — = no trend yet or not tracked">15m trend</th>
              <th title="the latest trend + level setup in the last 30 min: a BREAK of, or a PULLBACK that held, the prior-day high/low, today's high/low or VWAP, in the 15m trend's direction">Setup</th>
              <th title="short-term activity, not an entry signal: BREAKOUT / TRENDING = moving · EXPANDING / COILING = watch · CHOP / DEAD = skip">State</th>
              {th('vol', 'Vol ×', prefs.windowMin === 1 ? 'average 15-s range, last 1 min ÷ last 15 min (1.0 = normal)' : prefs.windowMin === 5 ? 'average 1-min range, last 5 min ÷ last 60 min (1.0 = normal)' : 'average 1-min range, last 15 min ÷ last 60 min (1.0 = normal)')}
              {th('eff', 'Trend', `net move ÷ distance travelled over the last ${prefs.windowMin === 1 ? '2' : prefs.windowMin === 5 ? '15' : '30'} min (100% = straight line, 0% = chop)`)}
              <th title="$/min now ÷ this market's usual $/min for this hour">RVOL</th>
              {th('rs', 'RS', `relative strength: this market's move minus its benchmark's over the last ${prefs.windowMin === 1 ? '2' : prefs.windowMin === 5 ? '15' : '30'} min, in bps (alts vs BTC, stocks/ETFs vs NQ, index vs ES; ES vs NQ). + = leading. Higher-beta markets run further both ways.`)}
              {th('flow', 'Flow', 'aggressive buying minus selling as a share of $ traded, over at least the last 5 min. ⚠ = price moving against the flow (e.g. a breakout up on net selling)')}
              <th>Session</th>
              {th('usd', '$ / min', 'dollars traded per minute over the window')}
              {th('trades', 'Trades / min', 'prints per minute over the window')}
              {th('spread', 'Spread bps', 'median spread, basis points of mid (lower is cheaper)')}
              {th('depth', 'Top-5 depth', 'median of the smaller side of the top 5 levels, in $')}
              {th('room', 'Your size', `at $${prefs.sizeUsd.toLocaleString()}: a typical 1-min move (1-min ATR) in $ / a taker round trip (spread + fee each way) in $. Green = a minute covers ≥ ${ROOM_GOOD}× the cost, amber ≥ ${ROOM_OK}×. ⚠ = your size is bigger than the top 5 levels: a market order walks the book`)}
              <th title="$ traded per minute, last 60 minutes">Last 60 min</th>
              {th('vol24h', '24 h vol', "Vest's 24 h volume")}
              {th('score', 'Liquidity', 'liquidity score 0–100 over at least the last 5 min (steady fill check): $/min 40%, trades/min 20%, cost 20%, depth 10%, room to move 10%')}
            </tr>
          </thead>
          <tbody>
            {visible.map((r) => {
              const tone = r.score === undefined ? 'var(--faint)' : r.score >= 70 ? 'var(--live)' : r.score >= 40 ? 'var(--warn)' : 'var(--dead)';
              return (
                <tr key={r.m.info.symbol} onClick={() => void open(r.m)} title={`open ${r.m.display} on Vest (and switch the BookDepthIQ-Vest panel to it)`} className={r.score !== undefined && r.score >= 70 ? 'top' : ''}>
                  <td>
                    <span className="sym">{r.m.display}</span> {r.s.quoted && <span className="quoted" title="the book is moving but nothing traded: market-maker quotes only">QUOTED</span>}
                  </td>
                  <td>
                    <span className={`opp ${r.r.opportunity >= 50 ? 's-hi' : r.r.opportunity >= 25 ? 's-mid' : ''}`}>{r.r.state === 'dead' || r.r.state === 'warming' ? '—' : r.r.opportunity}</span>
                  </td>
                  {(() => {
                    const d = engine.htf.get(r.m.info.symbol)?.trendDir();
                    return <td className={d === 'up' ? 'up' : d === 'down' ? 'down' : ''}>{d === 'up' ? '▲ up' : d === 'down' ? '▼ down' : '—'}</td>;
                  })()}
                  {(() => {
                    const su = engine.lastSetup.get(r.m.display);
                    const fresh = su && now - su.t < 30 * 60_000;
                    return (
                      <td className={fresh ? (su.dir > 0 ? 'up' : 'down') : ''} title={fresh ? `${new Date(su.t).toLocaleTimeString()} · close ${su.close}` : ''}>
                        {fresh ? setupText(su) : '—'}
                      </td>
                    );
                  })()}
                  <td>
                    <span className={`state st-${r.r.state}`} title={STATE_TITLE[r.r.state]}>
                      {r.r.dir > 0 ? '▲ ' : r.r.dir < 0 ? '▼ ' : ''}
                      {STATE_LABEL[r.r.state]}
                    </span>
                  </td>
                  <td className={r.r.volRatio !== undefined && r.r.volRatio >= 1.5 ? 'hot' : ''}>{r.r.volRatio === undefined ? '—' : `${r.r.volRatio.toFixed(1)}×`}</td>
                  <td>{r.r.eff === undefined ? '—' : `${r.r.eff > 0 ? '▲' : r.r.eff < 0 ? '▼' : ''}${Math.round(Math.abs(r.r.eff) * 100)}%`}</td>
                  <td className={r.r.rvol !== undefined && r.r.rvol >= 1.5 ? 'hot' : ''}>{r.r.rvol === undefined ? '—' : `${r.r.rvol.toFixed(1)}×`}</td>
                  <td className={r.rs === undefined ? '' : r.rs > 0 ? 'up' : r.rs < 0 ? 'down' : ''} title={r.bench ? `vs ${r.bench}` : 'no benchmark'}>
                    {r.rs === undefined ? '—' : `${r.rs > 0 ? '+' : ''}${r.rs.toFixed(0)}`}
                    {r.bench && <small> {r.bench.replace('-PERP', '')}</small>}
                  </td>
                  <td className={r.flow === undefined ? '' : r.flow > 0 ? 'up' : r.flow < 0 ? 'down' : ''}>
                    {r.r.state !== 'dead' && flowDiverges(r.r.dir, r.flow) && <span className="diverge" title="price is moving against the flow">⚠ </span>}
                    {r.flow === undefined ? '—' : Math.abs(r.flow) < 0.005 ? 'even' : `${r.flow > 0 ? 'buy' : 'sell'} ${Math.round(Math.abs(r.flow) * 100)}%`}
                  </td>
                  <td>
                    <span className={`chip ${!r.m.session.open ? 'closed' : r.m.session.session === 'regular' || r.m.session.session === 'open' ? 'live' : 'ah'}`}>
                      <i />
                      {SESSION_LABEL[r.m.session.session] ?? r.m.session.session.replace(/_/g, ' ')}
                    </span>
                  </td>
                  <td>{fmtUsd(r.s.usdPerMin)}</td>
                  <td>{r.s.tradesPerMin.toFixed(r.s.tradesPerMin >= 10 ? 0 : 1)}</td>
                  <td>{r.s.spreadBps === undefined ? '—' : r.s.spreadBps.toFixed(2)}</td>
                  <td>{fmtUsd(r.s.top5Usd)}</td>
                  <td className={r.size === undefined ? '' : r.size.ratio >= ROOM_GOOD ? 'up' : r.size.ratio >= ROOM_OK ? 'hot' : 'down'}>
                    {r.size?.walks && <span className="diverge" title="bigger than the top 5 levels: walks the book">⚠ </span>}
                    {r.size === undefined ? '—' : `$${r.size.moveUsd.toFixed(2)} / $${r.size.costUsd.toFixed(2)}`}
                  </td>
                  <td>
                    <Spark data={r.spark} tone={tone} />
                  </td>
                  <td>{fmtUsd(r.m.vol24h)}</td>
                  <td>
                    <span className={`score ${r.score === undefined ? '' : r.score >= 70 ? 's-hi' : r.score >= 40 ? 's-mid' : 's-lo'}`}>{r.score ?? '—'}</span>
                  </td>
                </tr>
              );
            })}
            {visible.length === 0 && (
              <tr>
                <td colSpan={19} className="muted empty">
                  {engine.status === 'starting' ? 'Loading Vest markets…' : 'No markets match this filter right now.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <section className="hours scorecard">
        <div className="hourshead">
          <h2>Scorecard: are the calls any good?</h2>
          <span className="muted">
            every trend + level setup (15m trend, then a break of or pullback to a level), graded {HORIZONS_MIN.join(' / ')} min later · net of spread + taker fees both ways · recorded while this window is open
          </span>
          <span className="spacer" />
          <button className="ghost" onClick={() => void navigator.clipboard?.writeText(callsCsv(engine.calls)).then(() => setToast('Calls copied as CSV'), () => setToast('Copy failed'))}>
            Copy calls as CSV
          </button>
          <button className="ghost" onClick={() => engine.clearCalls()}>
            Clear
          </button>
        </div>
        <table className="card">
          <thead>
            <tr>
              <th>Call</th>
              {HORIZONS_MIN.map((h) => (
                <th key={h} title="average net bps · share that made money · calls graded">
                  {h} min later
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {scorecard(engine.calls).map((row) => (
              <tr key={row.label}>
                <td>{row.label}</td>
                {row.grades.map((g, i) => (
                  <td key={i} className={g.n < MIN_TRUSTED ? 'faint' : ''} title={g.n < MIN_TRUSTED ? `only ${g.n} graded: under ${MIN_TRUSTED}, too few to trust` : ''}>
                    {g.n === 0 ? '—' : <GradeLine g={g} />}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="hours">
        <div className="hourshead">
          <h2>Liquid by hour (Chicago)</h2>
          <span className="muted">average $ per minute · top 12 by 24 h volume · built while this window is open</span>
          <span className="spacer" />
          <button disabled={!!engine.backfilling} onClick={() => void engine.backfillHours()}>
            {engine.backfilling ? `backfilling ${engine.backfilling}…` : 'Backfill last 24 h'}
          </button>
          <button className="ghost" onClick={() => engine.clearHours()}>
            Clear
          </button>
        </div>
        <div className="heat" role="table" aria-label="average dollars per minute by hour of day">
          <div className="h" />
          {Array.from({ length: 24 }, (_, h) => (
            <div key={h} className={`h ${h === nowHour ? 'now' : ''}`}>
              {h % 3 === 0 ? String(h).padStart(2, '0') : ''}
            </div>
          ))}
          {heatMarkets.map((m) => (
            <div key={m.info.symbol} className="hrow" role="row">
              <div className="m">{m.display}</div>
              {Array.from({ length: 24 }, (_, h) => {
                const v = avgPerMin(engine.hours, m.info.symbol, h);
                const a = v === undefined ? 0 : Math.max(0.06, Math.sqrt(v / heatMax));
                return <div key={h} className={`c ${v === undefined ? 'none' : ''} ${h === nowHour ? 'now' : ''}`} style={{ opacity: v === undefined ? 1 : a }} title={`${m.display} ${String(h).padStart(2, '0')}:00 — ${v === undefined ? 'not observed yet' : `${fmtUsd(v)}/min`}`} />;
              })}
            </div>
          ))}
        </div>
      </section>

      <footer className="muted">
        Read-only: public Vest data, no login, no orders. Click a row to open that market on Vest. Recorded {engine.records.length} regime minutes for tuning{' '}
        <button
          className="ghost"
          title="copy the recorded minutes as CSV: price, liquidity, vol ×, efficiency, RVOL, breakout, state, and the price change 5/15/60 min later"
          onClick={() => void navigator.clipboard?.writeText(engine.recordsCsv()).then(() => setToast('Recorded stats copied as CSV'), () => setToast('Copy failed'))}
        >
          Copy as CSV
        </button>
      </footer>
    </div>
  );
}
