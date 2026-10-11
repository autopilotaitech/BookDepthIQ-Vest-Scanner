import { describe, expect, it } from 'vitest';
import { MarketStats } from '../src/scan/metrics.js';
import { benchmarkFor, changeBps, flowDiverges, flowShare, relativeBps } from '../src/scan/relative.js';
import type { Bar } from '../src/scan/regime.js';

const bar = (t: number, c: number): Bar => ({ t, o: c, h: c, l: c, c });

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
