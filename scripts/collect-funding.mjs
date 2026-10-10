// Vest funding collector — run by .github/workflows/collect-funding.yml twice an hour, 24/7.
// Vest publishes only the CURRENT funding rate and open interest, so this builds the history.
// Public reads only (no login, no orders). Appends one row per market to <dir>/funding-YYYY-MM.csv:
//   time_utc, symbol, display, funding_per_h, mark, index, premium_bps, long_oi, short_oi
// Usage: node scripts/collect-funding.mjs <output-dir>
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const BASE = 'https://api-gateway.hz.vestmarkets.com';
const outDir = process.argv[2] ?? 'data';

async function get(path) {
  for (let attempt = 1; ; attempt++) {
    try {
      const r = await fetch(BASE + path, { headers: { Accept: 'application/json' } });
      if (!r.ok) throw new Error(`${path} -> ${r.status}`);
      return await r.json();
    } catch (e) {
      if (attempt >= 3) throw e;
      await new Promise((res) => setTimeout(res, 2000 * attempt));
    }
  }
}

const now = new Date();
const info = (await get('/v3/exchangeInfo')).symbols.filter((s) => s.tradingStatus === 'TRADING');
const tickers = new Map();
for (let i = 0; i < info.length; i += 40) {
  const syms = info.slice(i, i + 40).map((s) => encodeURIComponent(s.symbol)).join(',');
  for (const t of (await get(`/v3/ticker/latest?symbols=${syms}`)).tickers ?? []) tickers.set(t.symbol, t);
}
const oi = new Map(((await get('/v3/oi')).ois ?? []).map((o) => [o.symbol, o]));

mkdirSync(outDir, { recursive: true });
const file = join(outDir, `funding-${now.toISOString().slice(0, 7)}.csv`);
const header = 'time_utc,symbol,display,funding_per_h,mark,index,premium_bps,long_oi,short_oi\n';
const rows = info.map((s) => {
  const t = tickers.get(s.symbol) ?? {};
  const o = oi.get(s.symbol) ?? {};
  const mark = Number(t.markPrice);
  const idx = Number(t.indexPrice);
  const prem = mark > 0 && idx > 0 ? (((mark - idx) / idx) * 1e4).toFixed(3) : '';
  return [now.toISOString(), s.symbol, s.displaySymbol ?? s.symbol, t.oneHrFundingRate ?? '', t.markPrice ?? '', t.indexPrice ?? '', prem, o.longOi ?? '', o.shortOi ?? ''].join(',');
});
appendFileSync(file, (existsSync(file) ? '' : header) + rows.join('\n') + '\n');
console.log(`${now.toISOString()}: ${rows.length} markets → ${file}`);
