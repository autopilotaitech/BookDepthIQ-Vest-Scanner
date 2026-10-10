// Size check: what a typical move and a round trip cost are worth at YOUR size. Pure: no I/O.

export interface SizeCheck {
  /** $ value of one typical 1-minute move (1-min ATR) at this notional. */
  moveUsd: number;
  /** $ cost of a taker round trip: the spread plus the taker fee each way. */
  costUsd: number;
  /** moveUsd ÷ costUsd: how many round-trip costs a typical minute covers. */
  ratio: number;
  /** Your size is bigger than the smaller side of the top 5 levels: a market order walks the book. */
  walks: boolean;
}

/** Ratio at or above this is comfortable; below the second, a minute's move barely pays the cost. */
export const ROOM_GOOD = 3;
export const ROOM_OK = 1.5;

export function sizeCheck(
  sizeUsd: number,
  price: number | undefined,
  atr1m: number | undefined,
  spreadBps: number | undefined,
  takerFee: number,
  top5Usd: number | undefined,
): SizeCheck | undefined {
  if (!(sizeUsd > 0) || !(price! > 0) || atr1m === undefined || spreadBps === undefined) return undefined;
  const moveUsd = (atr1m / price!) * sizeUsd;
  const costUsd = ((spreadBps + 2 * takerFee * 1e4) / 1e4) * sizeUsd;
  return { moveUsd, costUsd, ratio: costUsd > 0 ? moveUsd / costUsd : Infinity, walks: top5Usd !== undefined && sizeUsd > top5Usd };
}
