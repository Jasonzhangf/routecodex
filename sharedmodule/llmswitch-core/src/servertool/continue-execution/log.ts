export const CONTINUE_EXECUTION_LOG_GOLD = '\x1b[38;5;220m';
export const CONTINUE_EXECUTION_LOG_RESET = '\x1b[0m';

export function logContinueExecution(message: string, extra?: Record<string, unknown>): void {
  try {
    // eslint-disable-next-line no-console
    console.log(
      `${CONTINUE_EXECUTION_LOG_GOLD}[servertool][continue_execution] ${message}` +
        (extra ? ` ${JSON.stringify(extra)}` : '') +
        CONTINUE_EXECUTION_LOG_RESET
    );
  } catch {
    // best-effort logging
  }
}
