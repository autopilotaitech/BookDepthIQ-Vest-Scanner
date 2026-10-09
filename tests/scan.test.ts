import { describe, expect, it } from 'vitest';
import { MarketStats } from '../src/scan/metrics.js';
import { QUOTED_CAP, categoryOf, crossedUp, liquidityScore, logPos, sessionAt } from '../src/scan/score.js';
import { addHistory, addMinute, avgPerMin, hourIn } from '../src/scan/history.js';

const L = (p: number, q: number): [string, string] => [String(p), String(q)];

describe('MarketStats', () => {
  it('trades: $ and count per minute, range in bps', () => {
    const s = new MarketStats();
    const now = 10 * 60_000;
    s.addTrade(now - 4 * 60_000, 100, 2); // $200
    s.addTrade(now - 60_000, 101, 1); // $101
    s.addTrade(now - 20 * 60_000, 99, 5); // outside a 5-min window
    const r = s.summary(now, 5 * 60_000);
    expect(r.usdPerMin).toBeCloseTo(301 / 5);
    expect(r.tradesPerMin).toBeCloseTo(2 / 5);
    expect(r.rangeBps).toBeCloseTo((1 / 101) * 1e4);
    expect(r.quoted).toBe(false);
  });

  it('depth: spread bps and top-5 $, one sample per second; quoted when the book moves but nothing trades', () => {
    const s = new MarketStats();
    const bids = [L(99.9, 10), L(99.8, 10)];
    const asks = [L(100.1, 5), L(100.2, 5)];
    s.addDepth(1000, bids, asks);
    s.addDepth(1500, bids, asks); // counted as an update, not sampled
    const r = s.summary(60_000, 60_000);
    expect(r.spreadBps).toBeCloseTo((0.2 / 100) * 1e4);
    expect(r.top5Usd).toBeCloseTo(100.1 * 5 + 100.2 * 5);
    expect(r.updPerSec).toBeCloseTo(2 / 60);
    expect(r.quoted).toBe(true);
  });

  it('perMinute buckets for the sparkline', () => {
    const s = new MarketStats();
    const now = 3 * 60_000 + 30_000; // inside minute 3
    s.addTrade(3 * 60_000 + 1, 10, 1);
    s.addTrade(2 * 60_000 + 1, 10, 2);
    const pm = s.perMinute(now, 3);
    expect(pm).toEqual([0, 20, 10]);
  });
});

describe('score', () => {
  it('log anchors', () => {
    expect(logPos(1_000, 1_000, 1_000_000)).toBe(0);
    expect(logPos(1_000_000, 1_000, 1_000_000)).toBe(1);
    expect(logPos(31_623, 1_000, 1_000_000)).toBeCloseTo(0.5, 2);
    expect(logPos(0, 1, 10)).toBe(0);
    expect(logPos(undefined, 1, 10)).toBe(0);
  });

  it('NQ-like market scores high; idle quoted market is capped', () => {
    const nq = liquidityScore({ usdPerMin: 1.6e6, tradesPerMin: 16, spreadBps: 0.32, top5Usd: 555e3, rangeBps: 8, updPerSec: 3.9, quoted: false, ladder: 0.9 });
    expect(nq).toBeGreaterThanOrEqual(85);
    const idle = liquidityScore({ usdPerMin: 0, tradesPerMin: 0, spreadBps: 4.8, top5Usd: 210e3, rangeBps: 0, updPerSec: 0.7, quoted: true, ladder: 1 });
    expect(idle).toBeLessThanOrEqual(QUOTED_CAP);
  });

  it('sessions from /v4/market-hours (shape seen 2026-10-09)', () => {
    const a = {
      assetId: 103,
      key: { exchange: 'CME', assetType: 'INDEX' },
      periods: [
        { fromMs: 0, toMs: 100, state: { session: 'regular', tradingStatus: 'OPEN' } },
        { fromMs: 100, toMs: 200, state: { session: 'unspecified', tradingStatus: 'CLOSE' } },
      ],
    };
    expect(sessionAt(a, 50)).toEqual({ session: 'regular', open: true, untilMs: 100 });
    expect(sessionAt(a, 150)).toMatchObject({ session: 'closed', open: false });
    expect(sessionAt(a, 500)).toEqual({ session: 'unknown', open: true });
    expect(sessionAt(undefined, 1)).toEqual({ session: 'unknown', open: true });
  });

  it('categories', () => {
    expect(categoryOf(['etf'], 'EQUITY')).toBe('etf');
    expect(categoryOf([], 'CRYPTO')).toBe('crypto');
    expect(categoryOf(undefined, 'EQUITY')).toBe('stock');
    expect(categoryOf(['index'], undefined)).toBe('index');
    expect(categoryOf([], undefined)).toBe('other');
  });

  it('alerts fire only on an upward cross', () => {
    expect(crossedUp(60, 72, 70)).toBe(true);
    expect(crossedUp(72, 80, 70)).toBe(false);
    expect(crossedUp(undefined, 75, 70)).toBe(true);
    expect(crossedUp(80, 65, 70)).toBe(false);
  });
});

describe('liquid by hour', () => {
  it('hours in Chicago time and averages', () => {
    const t = Date.UTC(2026, 9, 9, 13, 30); // 08:30 CDT
    expect(hourIn(t, 'America/Chicago')).toBe(8);
    const map = {};
    addMinute(map, 'NQ', t, 1000, 'America/Chicago');
    addMinute(map, 'NQ', t + 60_000, 3000, 'America/Chicago');
    expect(avgPerMin(map, 'NQ', 8)).toBe(2000);
    expect(avgPerMin(map, 'NQ', 9)).toBeUndefined();
  });

  it('history backfill counts quiet minutes as $0', () => {
    const map = {};
    const from = Date.UTC(2026, 9, 9, 13, 0); // 08:00 CDT
    addHistory(map, 'ES', [{ t: from + 5_000, usd: 600 }], from, from + 3 * 60_000, 'America/Chicago');
    expect(avgPerMin(map, 'ES', 8)).toBe(200); // 600 over 3 minutes
  });
});
