// Download recent public Vest trades: node scripts/fetch-trades.mjs <outDir> <days> SYM... → <outDir>/vest_<SYM>.json [ms, price, usd, side]
import { writeFileSync } from 'node:fs';
const [out, days, ...syms] = process.argv.slice(2);
const V = 'https://api-gateway.hz.vestmarkets.com';
const start = Date.now() - Number(days) * 86400_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (const sym of syms) {
  const all = new Map();
  let end = Date.now();
  for (let page = 0; page < 3000; page++) {
    let rows;
    for (let i = 0; ; i++) {
      try { const r = await fetch(`${V}/v3/trades?symbol=${sym}&endTime=${end}&limit=1000`); if (r.status === 429) throw 0; rows = await r.json(); break; }
      catch { if (i > 5) throw new Error('fetch failed'); await sleep(1500 * (i + 1)); }
    }
    if (!rows.length) break;
    for (const t of rows) all.set(t.id, [t.time, Number(t.price), Number(t.quoteQty), t.side === 'buy' ? 1 : -1]);
    const oldest = Math.min(...rows.map((t) => t.time));
    if (oldest < start || oldest >= end) break;
    end = oldest;
    await sleep(100);
  }
  const rows = [...all.values()].filter((r) => r[0] >= start).sort((a, b) => a[0] - b[0]);
  writeFileSync(`${out}/vest_${sym}.json`, JSON.stringify(rows));
  console.log(sym, rows.length, 'trades');
}
