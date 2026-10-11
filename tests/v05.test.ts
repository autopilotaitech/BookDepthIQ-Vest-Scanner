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
    expect(rows.map((r) => r.label)).toEqual(['BREAKOUT', 'TRENDING', 'all calls', 'NQ/ES 8:30–10:30 CT']);
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

import { regime, TIMEFRAMES, REGIME } from '../src/scan/regime.js';
import { resolveWatch, watchRate, WATCH_MS, type Watch } from '../src/scan/scorecard.js';
import { sizeCheck } from '../src/scan/size.js';

describe('v0.6 coiling', () => {
  // 60 bars swinging ±1, then the last 4 bars barely moving: fast ATR ≪ slow ATR.
  const bars: Bar[] = [];
  for (let i = 0; i < 70; i++) {
    const c = i < 66 ? 100 + (i % 2 ? 1 : -1) : 100 + (i % 2 ? 0.05 : -0.05);
    bars.push({ t: i * 15_000, o: c, h: c + 0.02, l: c - 0.02, c });
  }
  it('COILING when the range squeezes and trading is at least usual', () => {
    expect(regime(bars, 80, 1000, 900, TIMEFRAMES[1]).state).toBe('coiling');
  });
  it('not COILING without RVOL, or when trading dried up', () => {
    expect(regime(bars, 80, 1000, undefined, TIMEFRAMES[1]).state).not.toBe('coiling');
    expect(regime(bars, 80, 500, 900, TIMEFRAMES[1]).state).not.toBe('coiling');
    expect(REGIME.volCoil).toBeLessThan(1);
  });
});

describe('v0.6 watches', () => {
  it('moved if it enters a moving state within 30 min, else not', () => {
    const a: Watch = { t: 0, sym: 'A', windowMin: 1, from: 'coiling' };
    expect(resolveWatch(a, 60_000, 'quiet')).toBe(false);
    expect(resolveWatch(a, 120_000, 'expanding')).toBe(true);
    expect(a.moved).toBe(true);
    const b: Watch = { t: 0, sym: 'B', windowMin: 1, from: 'quiet' };
    expect(resolveWatch(b, WATCH_MS + 1, undefined)).toBe(true);
    expect(b.moved).toBe(false);
    const c: Watch = { t: 0, sym: 'C', windowMin: 1, from: 'coiling' };
    expect(watchRate([a, b, c], 1, 'coiling')).toEqual({ n: 1, rate: 1 });
    expect(watchRate([a, b, c], 1, 'quiet')).toEqual({ n: 1, rate: 0 });
  });
});

describe('v0.6 size check', () => {
  it('typical move and round-trip cost in $ at your size', () => {
    // $10k at 100: ATR 0.5 → 50 bps → $50; cost 1 bps spread + 2 × 1 bp fee = 3 bps → $3
    const r = sizeCheck(10_000, 100, 0.5, 1, 0.0001, 20_000)!;
    expect(r.moveUsd).toBeCloseTo(50);
    expect(r.costUsd).toBeCloseTo(3);
    expect(r.ratio).toBeCloseTo(50 / 3);
    expect(r.walks).toBe(false);
    expect(sizeCheck(30_000, 100, 0.5, 1, 0.0001, 20_000)!.walks).toBe(true);
    expect(sizeCheck(0, 100, 0.5, 1, 0, 1)).toBeUndefined();
    expect(sizeCheck(1000, undefined, 0.5, 1, 0, 1)).toBeUndefined();
  });
});

import { fadeNet, inOpenDrive } from '../src/scan/scorecard.js';

describe('v0.6.1 fade + open-drive test', () => {
  it('fade pays the same costs on the opposite move', () => {
    const c = openCall(0, 'NQ-PERP', 1, 'breakout', 1, 100, 1, 0.0001); // cost 3
    gradeCall(c, 5 * 60_000, 99.9); // gross −10 → follow −13
    expect(c.net[0]).toBeCloseTo(-13);
    expect(fadeNet(c, 0)).toBeCloseTo(7); // gross +10 − 3
    expect(fadeNet(c, 1)).toBeUndefined();
  });
  it('opening drive = NQ/ES, weekdays 8:30–10:30 Chicago', () => {
    const mon0900 = Date.UTC(2026, 9, 12, 14, 0); // Mon 09:00 CDT
    expect(inOpenDrive({ t: mon0900, sym: 'NQ-PERP' })).toBe(true);
    expect(inOpenDrive({ t: mon0900, sym: 'BTC-PERP' })).toBe(false);
    expect(inOpenDrive({ t: Date.UTC(2026, 9, 12, 16, 0), sym: 'ES-PERP' })).toBe(false); // 11:00
    expect(inOpenDrive({ t: Date.UTC(2026, 9, 11, 14, 0), sym: 'NQ-PERP' })).toBe(false); // Sunday
  });
});
