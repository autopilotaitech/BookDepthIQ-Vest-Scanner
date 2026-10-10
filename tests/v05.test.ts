import { describe, expect, it } from 'vitest';
import { MarketStats } from '../src/scan/metrics.js';
import { benchmarkFor, changeBps, flowDiverges, flowShare, relativeBps } from '../src/scan/relative.js';
import { HORIZONS_MIN, MIN_TRUSTED, callsCsv, gradeCall, openCall, scorecard } from '../src/scan/scorecard.js';
import type { Bar } from '../src/scan/regime.js';

const bar = (t: number, c: number): Bar => ({ t, o: c, h: c, l: c, c });

describe('scorecard', () => {
  it('grades a long call net of spread + fees at each horizon', () => {
    const c = openCall(0, 'NQ-PERP', 1, 'breakout', 1, 100, 1, 0.0001); // cost 1 + 2 = 3 bps
    expect(c.costBps).toBeCloseTo(3);
    expect(gradeCall(c, 4 * 60_000, 101)).toBe(false); // nothing due yet
    expect(gradeCall(c, 5 * 60_000, 100.1)).toBe(true); // +10 bps − 3
    expect(c.net[0]).toBeCloseTo(7);
    expect(c.net[1]).toBeUndefined();
  });

  it('a short call profits when price falls; a late read is missed, not guessed', () => {
    const c = openCall(0, 'BTC-PERP', 5, 'trending', -1, 100, 0, 0);
    gradeCall(c, 15 * 60_000, 99); // 5m is 10 min late → missed; 15m due now → +100 bps
    expect(c.net[0]).toBeNull();
    expect(c.net[1]).toBeCloseTo(100);
  });

  it('summarises per state for one window only, and exports CSV', () => {
    const a = openCall(0, 'A', 1, 'breakout', 1, 100, 0, 0);
    const b = openCall(0, 'B', 1, 'trending', 1, 100, 0, 0);
    const other = openCall(0, 'C', 5, 'breakout', 1, 100, 0, 0);
    gradeCall(a, 5 * 60_000, 101);
    gradeCall(b, 5 * 60_000, 99);
    gradeCall(other, 5 * 60_000, 200);
    const rows = scorecard([a, b, other], 1);
    expect(rows.map((r) => r.label)).toEqual(['BREAKOUT', 'TRENDING', 'all calls']);
    expect(rows[0]!.grades[0]).toEqual({ n: 1, avgBps: expect.closeTo(100, 6), winRate: 1 });
    expect(rows[2]!.grades[0]!.n).toBe(2);
    expect(rows[2]!.grades[0]!.avgBps).toBeCloseTo(0);
    expect(rows[2]!.grades[1]!.n).toBe(0);
    expect(HORIZONS_MIN).toEqual([5, 15, 30]);
    expect(MIN_TRUSTED).toBeGreaterThan(0);
    const csv = callsCsv([a]).split('\n');
    expect(csv[0]).toContain('net_5m_bps');
    expect(csv[1]).toContain('A,1,breakout,long,100,0.00,100.00,,');
  });
});

describe('relative strength', () => {
  it('benchmarks by category', () => {
    expect(benchmarkFor('SOL-PERP', 'crypto')).toBe('BTC-PERP');
    expect(benchmarkFor('BTC-PERP', 'crypto')).toBeUndefined();
    expect(benchmarkFor('NVDA-PERP', 'stock')).toBe('NQ-PERP');
    expect(benchmarkFor('NQ-PERP', 'index')).toBe('ES-PERP');
    expect(benchmarkFor('ES-PERP', 'index')).toBe('NQ-PERP');
    expect(benchmarkFor('GC-PERP', 'commodity')).toBeUndefined();
  });

  it('move minus benchmark move over the last n bars, bps', () => {
    const own = [bar(0, 100), bar(1, 100), bar(2, 101)];
    const bench = [bar(0, 50), bar(1, 50), bar(2, 50.25)];
    expect(changeBps(own, 2)).toBeCloseTo(100);
    expect(relativeBps(own, bench, 2)).toBeCloseTo(50);
    expect(relativeBps(own, bench, 5)).toBeUndefined();
  });
});

describe('flow', () => {
  it('share of aggressive $ and divergence from price direction', () => {
    expect(flowShare(0, 0)).toBeUndefined();
    expect(flowShare(75, 25)).toBeCloseTo(0.5);
    expect(flowDiverges(1, -0.3)).toBe(true); // up on net selling
    expect(flowDiverges(1, 0.3)).toBe(false);
    expect(flowDiverges(-1, 0.25)).toBe(true);
    expect(flowDiverges(0, -0.9)).toBe(false);
  });

  it('MarketStats splits $ by aggressor side', () => {
    const s = new MarketStats();
    s.addTrade(1000, 100, 3, 'buy');
    s.addTrade(2000, 100, 1, 'sell');
    s.addTrade(3000, 100, 5); // unknown side: counted in $/min, not in flow
    const r = s.summary(60_000, 60_000);
    expect(r.buyUsd).toBe(300);
    expect(r.sellUsd).toBe(100);
    expect(r.usdPerMin).toBe(900);
  });
});
