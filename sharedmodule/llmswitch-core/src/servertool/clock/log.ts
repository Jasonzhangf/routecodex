export const CLOCK_LOG_GOLD = '\x1b[38;5;220m';
export const CLOCK_LOG_RESET = '\x1b[0m';

export function logClock(message: string, extra?: Record<string, unknown>): void {
  try {
    // eslint-disable-next-line no-console
    console.log(
      `${CLOCK_LOG_GOLD}[servertool][clock] ${message}` +
        (extra ? ` ${JSON.stringify(extra)}` : '') +
        CLOCK_LOG_RESET
    );
  } catch {
    // best-effort logging
  }
}

