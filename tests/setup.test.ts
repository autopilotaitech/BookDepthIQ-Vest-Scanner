import { describe, expect, it } from 'vitest';
import { HtfTracker, findSetup, tradingDay, type Levels } from '../src/scan/setup.js';
import { HORIZONS_MIN, callsCsv, gradeCall, openCall, scorecard } from '../src/scan/scorecard.js';

const lv = (o: Partial<Levels>): Levels => ({ pdh: undefined, pdl: undefined, hod: undefined, lod: undefined, vwap: undefined, ...o });

describe('findSetup', () => {
  it('BREAK: close through a level in the trend direction, previous close not', () => {
    expect(findSetup(1, lv({ pdh: 100 }), 100.5, 99.9, [], 0.1)).toEqual({ kind: 'break', dir: 1, level: 'prior-day high', price: 100 });
    expect(findSetup(-1, lv({ lod: 100 }), 99.5, 100.1, [], 0.1)).toEqual({ kind: 'break', dir: -1, level: "today's low", price: 100 });
  });
  it('no break against the trend, or when already through', () => {
    expect(findSetup(-1, lv({ pdh: 100 }), 100.5, 99.9, [], 0.1)).toBeUndefined();
    expect(findSetup(1, lv({ pdh: 100 }), 100.5, 100.3, [], 0.1)).toBeUndefined();
    expect(findSetup(1, lv({ pdh: 100 }), 100.05, 99.9, [], 0.1)).toBeUndefined(); // within tolerance
  });
  it('PULLBACK: touched the level recently, now moving away with the trend', () => {
    expect(findSetup(1, lv({ vwap: 100 }), 100.3, 100.2, [100.6, 100.05, 100.2], 0.1)).toEqual({ kind: 'pullback', dir: 1, level: 'VWAP', price: 100 });
    expect(findSetup(1, lv({ vwap: 100 }), 100.3, 100.4, [100.05], 0.1)).toBeUndefined(); // falling, not holding
    expect(findSetup(1, lv({ vwap: 100 }), 100.3, 100.2, [100.6, 100.5], 0.1)).toBeUndefined(); // never touched
  });
});

describe('tradingDay', () => {
  it('rolls at 17:00 Chicago', () => {
    expect(tradingDay(Date.UTC(2026, 9, 12, 21, 59))).toBe('2026-10-12'); // 16:59 CDT Mon
    expect(tradingDay(Date.UTC(2026, 9, 12, 22, 0))).toBe('2026-10-13'); // 17:00 CDT → Tue's session
  });
});

describe('HtfTracker', () => {
  it('no call without a warmed-up trend; levels roll at the day boundary', () => {
    const tr = new HtfTracker(0.25);
    const d0 = Date.UTC(2026, 9, 12, 14, 0);
    tr.addTrade(d0, 100, 1, 'buy');
    tr.addTrade(d0 + 1000, 102, 1, 'buy');
    tr.addTrade(d0 + 2000, 99, 1, 'sell');
    expect(tr.trendDir()).toBe('neutral');
    expect(tr.minuteClose(d0 + 60_000, 1)).toBeUndefined();
    tr.addTrade(Date.UTC(2026, 9, 12, 22, 1), 101, 1, 'buy'); // next trading day
    const l = tr.levels();
    expect([l.pdh, l.pdl, l.hod, l.lod, l.vwap]).toEqual([102, 99, 101, 101, 101]);
  });

  it('a sustained uptrend then a break of today\'s high fires one long call', () => {
    const tr = new HtfTracker(0.25);
    const t0 = Date.UTC(2026, 9, 12, 13, 0);
    // 15-min candles stepping up for 4 hours → SuperTrend up
    for (let i = 0; i < 16 * 15; i++) tr.addTrade(t0 + i * 60_000, 100 + i * 0.05 + (i % 3) * 0.02, 1, 'buy');
    expect(tr.trendDir()).toBe('up');
    const tEnd = t0 + 16 * 15 * 60_000;
    // pull back below today's high for a few minutes, then break it
    let fired: unknown;
    const hi = tr.levels().hod!;
    const path = [hi - 0.3, hi - 0.4, hi - 0.35, hi - 0.2, hi + 0.5];
    path.forEach((p, k) => {
      tr.addTrade(tEnd + k * 60_000 + 1000, p, 1, 'buy');
      const s = tr.minuteClose(tEnd + (k + 1) * 60_000, 1);
      if (s) fired = s;
    });
    expect(fired).toMatchObject({ kind: 'break', dir: 1, level: "today's high" });
  });
});

describe('scorecard', () => {
  it('grades a long call net of spread + fees at 15/30/60 min', () => {
    expect(HORIZONS_MIN).toEqual([15, 30, 60]);
    const c = openCall(0, 'NQ-PERP', 'break', 'prior-day high', 1, 100, 1, 0.0001); // cost 3 bps
    expect(gradeCall(c, 14 * 60_000, 101)).toBe(false);
    expect(gradeCall(c, 15 * 60_000, 100.1)).toBe(true);
    expect(c.net[0]).toBeCloseTo(7);
    const late = openCall(0, 'BTC-PERP', 'pullback', 'VWAP', -1, 100, 0, 0);
    gradeCall(late, 30 * 60_000, 99); // 15m read 15 min late → missed; 30m → +100
    expect(late.net[0]).toBeNull();
    expect(late.net[1]).toBeCloseTo(100);
    const rows = scorecard([c, late]);
    expect(rows.map((r) => r.label)).toEqual(['BREAK of a level', 'PULLBACK that held', 'all calls']);
    expect(rows[0]!.grades[0]!.n).toBe(1);
    expect(rows[2]!.grades[1]!.n).toBe(1);
    expect(callsCsv([c]).split('\n')[1]).toContain('NQ-PERP,break,prior-day high,long,100,3.00,7.00,,');
  });
});
