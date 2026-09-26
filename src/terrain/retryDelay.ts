// A leaf module: the settings catalogue reads the default, so it imports nothing.

/** The wait after a failed map download, ms: the first, doubling with each failure in a row, up to the longest. */
export interface RetryDelay {
  min: number;
  max: number;
}

/** `map.retryDelay`'s default: what failed tile downloads backed off by before it was a parameter. */
export const DEFAULT_RETRY_DELAY_MS: RetryDelay = Object.freeze({ min: 2000, max: 30_000 });

/** The wait before the next try after `failures` failures in a row. */
export function retryDelayMs(failures: number, delay: RetryDelay = DEFAULT_RETRY_DELAY_MS): number {
  return Math.min(delay.max, delay.min * 2 ** Math.max(0, failures - 1));
}
