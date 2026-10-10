import { useEffect, useMemo, useRef, useState } from 'react';
import { Engine, type Market } from './engine';
import type { Category } from '../src/scan/score';
import { avgPerMin } from '../src/scan/history';
import type { Summary } from '../src/scan/metrics';
import { becameActionable, type Regime, type RegimeState } from '../src/scan/regime';

// Per-viewer settings (window, filter, alerts, sort) in localStorage; guarded, defaults always work.
interface Prefs {
  windowMin: 1 | 5 | 15;
  category: 'all' | Category;
  openOnly: boolean;
  alertsOn: boolean;
  /** Hide CHOP and DEAD markets. */
  hideChop: boolean;
  sort: 'opp' | 'score' | 'usd' | 'trades' | 'spread' | 'depth' | 'vol24h' | 'vol' | 'eff';
}
const PREFS_KEY = 'scanner.prefs.v3';
const DEFAULT_PREFS: Prefs = { windowMin: 1, category: 'all', openOnly: true, alertsOn: false, hideChop: false, sort: 'opp' };

const STATE_LABEL: Record<RegimeState, string> = { breakout: 'BREAKOUT', trending: 'TRENDING', expanding: 'EXPANDING', chop: 'CHOP', quiet: 'QUIET', dead: 'DEAD', warming: 'WARMING' };
const STATE_TITLE: Record<RegimeState, string> = {
  breakout: 'beyond its recent high/low (15 min on the 1-min window, 60 min otherwise) with volatility ≥ 1.5× and a clean move: the setup you want',
  trending: 'moving one way cleanly (efficiency ≥ 0.5) with volatility ≥ 1.2×',
  expanding: 'volatility ≥ 1.5× but no clean direction yet: watch',
  chop: 'moving back and forth (efficiency < 0.3): skip',
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

export function App() {
  const engine = useMemo(() => new Engine(), []);
  const [, setTick] = useState(0);
  const [prefs, setPrefs] = useState<Prefs>(loadPrefs);
  const [toast, setToast] = useState<string>('');
  const prevStates = useRef(new Map<string, RegimeState>());
  const lastAlert = useRef(new Map<string, number>());

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
  const rows: Row[] = [...engine.markets.values()].map((m) => {
    const s = m.stats.summary(now, windowMs);
    const { score, regime: r } = engine.regimeOf(m, now, windowMs);
    return { m, s, score, r, spark: m.stats.perMinute(now, 60) };
  });

  // Alerts: a liquid market entering BREAKOUT or TRENDING (10-minute cooldown per market).
  useEffect(() => {
    for (const r of rows) {
      const sym = r.m.info.symbol;
      const prev = prevStates.current.get(sym);
      if (prefs.alertsOn && engine.warming === 0 && becameActionable(prev, r.r.state) && now - (lastAlert.current.get(sym) ?? 0) > 10 * 60_000) {
        lastAlert.current.set(sym, now);
        const msg = `${r.m.display} ${r.r.dir > 0 ? '▲' : r.r.dir < 0 ? '▼' : ''} ${STATE_LABEL[r.r.state]}: vol ${r.r.volRatio?.toFixed(1) ?? '?'}×, ${fmtUsd(r.s.usdPerMin)}/min`;
        setToast(msg);
        const chrome = (globalThis as { chrome?: { notifications?: { create(o: object): void } } }).chrome;
        try {
          chrome?.notifications?.create({ type: 'basic', iconUrl: 'icon128.png', title: 'Vest Liquidity Scanner', message: msg });
        } catch {
          /* in-page toast only */
        }
      }
      prevStates.current.set(sym, r.r.state);
    }
  });

  const visible = rows
    .filter((r) => prefs.category === 'all' || r.m.category === prefs.category)
    .filter((r) => !prefs.openOnly || r.m.session.open)
    .filter((r) => !prefs.hideChop || (r.r.state !== 'chop' && r.r.state !== 'dead'))
    .sort((a, b) => {
      const k = prefs.sort;
      const v = (r: Row) =>
        k === 'opp' ? r.r.opportunity : k === 'vol' ? (r.r.volRatio ?? -1) : k === 'eff' ? Math.abs(r.r.eff ?? 0) : k === 'score' ? (r.score ?? -1) : k === 'usd' ? r.s.usdPerMin : k === 'trades' ? r.s.tradesPerMin : k === 'spread' ? -(r.s.spreadBps ?? 1e9) : k === 'depth' ? (r.s.top5Usd ?? 0) : r.m.vol24h;
      return v(b) - v(a);
    });

  const open = (m: Market) => {
    const url = `https://next.vestmarkets.com/trade/${encodeURIComponent(m.display)}`;
    const chrome = (globalThis as { chrome?: { tabs?: { create(o: { url: string }): void } } }).chrome;
    if (chrome?.tabs) chrome.tabs.create({ url });
    else window.open(url, '_blank', 'noopener');
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
        <label title="notify when a liquid market enters BREAKOUT or TRENDING">
          <input type="checkbox" checked={prefs.alertsOn} onChange={(e) => update({ alertsOn: e.target.checked })} /> alert on breakout / trend
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
              <th title="BREAKOUT / TRENDING = trade it · EXPANDING = watch · CHOP / DEAD = skip">State</th>
              {th('vol', 'Vol ×', prefs.windowMin === 1 ? 'average 15-s range, last 1 min ÷ last 15 min (1.0 = normal)' : prefs.windowMin === 5 ? 'average 1-min range, last 5 min ÷ last 60 min (1.0 = normal)' : 'average 1-min range, last 15 min ÷ last 60 min (1.0 = normal)')}
              {th('eff', 'Trend', `net move ÷ distance travelled over the last ${prefs.windowMin === 1 ? '2' : prefs.windowMin === 5 ? '15' : '30'} min (100% = straight line, 0% = chop)`)}
              <th title="$/min now ÷ this market's usual $/min for this hour">RVOL</th>
              <th>Session</th>
              {th('usd', '$ / min', 'dollars traded per minute over the window')}
              {th('trades', 'Trades / min', 'prints per minute over the window')}
              {th('spread', 'Spread bps', 'median spread, basis points of mid (lower is cheaper)')}
              {th('depth', 'Top-5 depth', 'median of the smaller side of the top 5 levels, in $')}
              <th title="$ traded per minute, last 60 minutes">Last 60 min</th>
              {th('vol24h', '24 h vol', "Vest's 24 h volume")}
              {th('score', 'Liquidity', 'liquidity score 0–100 over at least the last 5 min (steady fill check): $/min 40%, trades/min 20%, cost 20%, depth 10%, room to move 10%')}
            </tr>
          </thead>
          <tbody>
            {visible.map((r) => {
              const tone = r.score === undefined ? 'var(--faint)' : r.score >= 70 ? 'var(--live)' : r.score >= 40 ? 'var(--warn)' : 'var(--dead)';
              return (
                <tr key={r.m.info.symbol} onClick={() => open(r.m)} title={`open ${r.m.display} on Vest`} className={r.score !== undefined && r.score >= 70 ? 'top' : ''}>
                  <td>
                    <span className="sym">{r.m.display}</span> {r.s.quoted && <span className="quoted" title="the book is moving but nothing traded: market-maker quotes only">QUOTED</span>}
                  </td>
                  <td>
                    <span className={`opp ${r.r.opportunity >= 50 ? 's-hi' : r.r.opportunity >= 25 ? 's-mid' : ''}`}>{r.r.state === 'dead' || r.r.state === 'warming' ? '—' : r.r.opportunity}</span>
                  </td>
                  <td>
                    <span className={`state st-${r.r.state}`} title={STATE_TITLE[r.r.state]}>
                      {r.r.dir > 0 ? '▲ ' : r.r.dir < 0 ? '▼ ' : ''}
                      {STATE_LABEL[r.r.state]}
                    </span>
                  </td>
                  <td className={r.r.volRatio !== undefined && r.r.volRatio >= 1.5 ? 'hot' : ''}>{r.r.volRatio === undefined ? '—' : `${r.r.volRatio.toFixed(1)}×`}</td>
                  <td>{r.r.eff === undefined ? '—' : `${r.r.eff > 0 ? '▲' : r.r.eff < 0 ? '▼' : ''}${Math.round(Math.abs(r.r.eff) * 100)}%`}</td>
                  <td className={r.r.rvol !== undefined && r.r.rvol >= 1.5 ? 'hot' : ''}>{r.r.rvol === undefined ? '—' : `${r.r.rvol.toFixed(1)}×`}</td>
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
                <td colSpan={14} className="muted empty">
                  {engine.status === 'starting' ? 'Loading Vest markets…' : 'No markets match this filter right now.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

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
