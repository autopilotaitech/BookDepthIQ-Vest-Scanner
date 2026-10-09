import { useEffect, useMemo, useRef, useState } from 'react';
import { Engine, type Market } from './engine';
import { crossedUp, liquidityScore, type Category } from '../src/scan/score';
import { avgPerMin } from '../src/scan/history';
import type { Summary } from '../src/scan/metrics';

// Per-viewer settings (window, filter, alerts, sort) in localStorage; guarded, defaults always work.
interface Prefs {
  windowMin: 5 | 15;
  category: 'all' | Category;
  openOnly: boolean;
  alertsOn: boolean;
  alertAt: number;
  sort: 'score' | 'usd' | 'trades' | 'spread' | 'depth' | 'vol24h';
}
const PREFS_KEY = 'scanner.prefs.v1';
const DEFAULT_PREFS: Prefs = { windowMin: 5, category: 'all', openOnly: true, alertsOn: false, alertAt: 70, sort: 'score' };
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
  const prevScores = useRef(new Map<string, number | undefined>());
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
    return { m, s, score: m.session.open ? liquidityScore(s) : undefined, spark: m.stats.perMinute(now, 60) };
  });

  // Alerts: a market crossing up through the threshold (10-minute cooldown per market).
  useEffect(() => {
    for (const r of rows) {
      const sym = r.m.info.symbol;
      const prev = prevScores.current.get(sym);
      if (prefs.alertsOn && engine.warming === 0 && crossedUp(prev, r.score, prefs.alertAt) && now - (lastAlert.current.get(sym) ?? 0) > 10 * 60_000) {
        lastAlert.current.set(sym, now);
        const msg = `${r.m.display} just went liquid: score ${r.score}, ${fmtUsd(r.s.usdPerMin)}/min`;
        setToast(msg);
        const chrome = (globalThis as { chrome?: { notifications?: { create(o: object): void } } }).chrome;
        try {
          chrome?.notifications?.create({ type: 'basic', iconUrl: 'icon128.png', title: 'Vest Liquidity Scanner', message: msg });
        } catch {
          /* in-page toast only */
        }
      }
      prevScores.current.set(sym, r.score);
    }
  });

  const visible = rows
    .filter((r) => prefs.category === 'all' || r.m.category === prefs.category)
    .filter((r) => !prefs.openOnly || r.m.session.open)
    .sort((a, b) => {
      const k = prefs.sort;
      const v = (r: Row) =>
        k === 'score' ? (r.score ?? -1) : k === 'usd' ? r.s.usdPerMin : k === 'trades' ? r.s.tradesPerMin : k === 'spread' ? -(r.s.spreadBps ?? 1e9) : k === 'depth' ? (r.s.top5Usd ?? 0) : r.m.vol24h;
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
          <select value={prefs.windowMin} onChange={(e) => update({ windowMin: Number(e.target.value) as 5 | 15 })}>
            <option value={5}>5 min</option>
            <option value={15}>15 min</option>
          </select>
        </label>
        <label>
          <input type="checkbox" checked={prefs.openOnly} onChange={(e) => update({ openOnly: e.target.checked })} /> open now only
        </label>
        <label title="notify when a market's score crosses up through this">
          <input type="checkbox" checked={prefs.alertsOn} onChange={(e) => update({ alertsOn: e.target.checked })} /> alert at
          <input type="number" min={10} max={100} step={5} value={prefs.alertAt} onChange={(e) => update({ alertAt: Math.max(10, Math.min(100, Number(e.target.value) || 70)) })} />
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
              <th>Session</th>
              {th('usd', '$ / min', 'dollars traded per minute over the window')}
              {th('trades', 'Trades / min', 'prints per minute over the window')}
              {th('spread', 'Spread bps', 'median spread, basis points of mid (lower is cheaper)')}
              {th('depth', 'Top-5 depth', 'median of the smaller side of the top 5 levels, in $')}
              <th title="$ traded per minute, last 60 minutes">Last 60 min</th>
              {th('vol24h', '24 h vol', "Vest's 24 h volume")}
              {th('score', 'Score', 'liquidity score 0–100: $/min 40%, trades/min 20%, cost 20%, depth 10%, room to move 10%')}
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
                <td colSpan={9} className="muted empty">
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

      <footer className="muted">Read-only: public Vest data, no login, no orders. Click a row to open that market on Vest.</footer>
    </div>
  );
}
