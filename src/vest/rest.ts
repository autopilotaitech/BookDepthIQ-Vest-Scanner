import { REST_BASE, type SymbolInfo, type TickerData, type TradeData } from './types.js';

// Public, unauthenticated reads only. Nothing in this file can place, modify or cancel an order.

async function getJson<T>(path: string): Promise<T> {
  const r = await fetch(REST_BASE + path, { headers: { Accept: 'application/json' } });
  const body = (await r.json().catch(() => null)) as unknown;
  if (!r.ok) throw new Error(`GET ${path} -> ${r.status} ${JSON.stringify(body)}`);
  // Vest reports some errors as 200 with {code,msg} (e.g. unknown symbol = 1121).
  if (body && typeof body === 'object' && 'code' in body && 'msg' in body) {
    const e = body as { code: unknown; msg: unknown };
    throw new Error(`GET ${path} -> code ${String(e.code)}: ${String(e.msg)}`);
  }
  return body as T;
}

export async function fetchExchangeInfo(): Promise<SymbolInfo[]> {
  // Shape: { symbols: SymbolInfo[], exchange: {...}, system: {...} }
  const r = await getJson<{ symbols: SymbolInfo[] }>('/v3/exchangeInfo');
  return r.symbols;
}

export async function fetchTicker(symbol: string): Promise<TickerData | undefined> {
  const r = await getJson<{ tickers: TickerData[] }>(
    `/v3/ticker/latest?symbols=${encodeURIComponent(symbol)}`,
  );
  return r.tickers[0];
}

/** Up to `limit` (≤ 1000) public trades at or before `endTime`, newest first. */
export function fetchTradesBefore(symbol: string, endTime: number, limit = 1000): Promise<TradeData[]> {
  return getJson<TradeData[]>(`/v3/trades?symbol=${encodeURIComponent(symbol)}&endTime=${Math.floor(endTime)}&limit=${limit}`);
}

export function fetchRecentTrades(symbol: string): Promise<TradeData[]> {
  return getJson<TradeData[]>(`/v3/trades?symbol=${encodeURIComponent(symbol)}`);
}

export interface Ticker24h {
  symbol: string;
  volume: string;
  quoteVolume: string;
  priceChangePercent?: number;
}

/** GET /v3/ticker/24hr — every market's 24 h volume (seen 2026-10-09: {tickers:[…]}). */
export async function fetch24h(): Promise<Ticker24h[]> {
  const r = await getJson<{ tickers: Ticker24h[] }>('/v3/ticker/24hr');
  return r.tickers ?? [];
}

export interface MarketHoursPeriod {
  fromMs: number;
  toMs: number;
  state: { session: string; closure?: string; tradingStatus: string };
}
export interface MarketHoursAsset {
  assetId: number;
  key?: { exchange?: string; assetType?: string };
  periods: MarketHoursPeriod[];
}

/** POST /v4/market-hours — sessions per asset for a time range (public; seen 2026-10-09). */
export async function fetchMarketHours(assetIds: number[], fromMs: number, toMs: number): Promise<MarketHoursAsset[]> {
  const r = await fetch(REST_BASE + '/v4/market-hours', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ assetIds, fromMs, toMs }),
  });
  if (!r.ok) throw new Error(`POST /v4/market-hours -> ${r.status}`);
  return (await r.json()) as MarketHoursAsset[];
}
