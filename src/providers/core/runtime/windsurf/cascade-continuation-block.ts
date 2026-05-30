import {
  assignErrorFields,
  getUnknownErrorMessage,
  getUnknownErrorRecord,
  resolveBackoffDelayMs,
} from './cascade-continuation-utils.js';

export type WindsurfCascadeBusyRetryArgs = {
  cascadeId: string;
  sessionId: string;
  attempt: number;
  delayMs: number;
};

export type WindsurfCascadeIdlePollResult = {
  idle: boolean;
};

export type WindsurfCascadeIdlePollFn = () => Promise<WindsurfCascadeIdlePollResult>;

export type WindsurfCascadeBusyRetryConfig = {
  maxRetries: number;
  backoffsMs: number[];
  busyPattern?: RegExp;
  totalWaitMs?: number;
  perAttemptWaitMs?: number;
  pollIntervalMs?: number;
};

export const WINDSURF_CASCADE_BUSY_DEFAULT_CONFIG: WindsurfCascadeBusyRetryConfig = {
  maxRetries: 3,
  backoffsMs: [1000, 2000, 4000],
  busyPattern: /CASCADE_RUN_STATUS_RUNNING|executor is not idle/i,
  totalWaitMs: 120_000,
  perAttemptWaitMs: 120_000,
  pollIntervalMs: 1_000,
};

export function isWindsurfCascadeBusyError(error: unknown, config: WindsurfCascadeBusyRetryConfig = WINDSURF_CASCADE_BUSY_DEFAULT_CONFIG): boolean {
  const record = getUnknownErrorRecord(error);
  const message = getUnknownErrorMessage(error);
  return record?.code === 'WINDSURF_CASCADE_BUSY' || (config.busyPattern ?? WINDSURF_CASCADE_BUSY_DEFAULT_CONFIG.busyPattern!).test(message);
}

export function buildWindsurfCascadeBusyError(error: unknown): Error {
  const source = error instanceof Error ? error : new Error(String(error ?? 'windsurf cascade busy'));
  return assignErrorFields(source, {
    code: 'WINDSURF_CASCADE_BUSY',
    status: 429,
    retryable: true,
    rateLimitKind: 'short_lived',
  });
}

export function resolveWindsurfCascadeBusyDelayMs(attempt: number, config: WindsurfCascadeBusyRetryConfig = WINDSURF_CASCADE_BUSY_DEFAULT_CONFIG): number {
  return resolveBackoffDelayMs(attempt, config.backoffsMs);
}


export type WindsurfCascadeSendFn = () => Promise<void>;
export type WindsurfCascadeSleepFn = (delayMs: number) => Promise<void>;
export type WindsurfCascadeLogFn = (stage: string, details: Record<string, unknown>) => void;

export type WindsurfCascadeBusyRetryContext = {
  cascadeId: string;
  sessionId: string;
};

export async function executeWindsurfCascadeBusyRetry(ctx: WindsurfCascadeBusyRetryContext, args: {
  sendMessage: WindsurfCascadeSendFn;
  sleep: WindsurfCascadeSleepFn;
  log: WindsurfCascadeLogFn;
  config?: WindsurfCascadeBusyRetryConfig;
  pollIdle?: WindsurfCascadeIdlePollFn;
}): Promise<void> {
  const config = args.config ?? WINDSURF_CASCADE_BUSY_DEFAULT_CONFIG;
  const perAttemptWaitMs = config.perAttemptWaitMs ?? config.totalWaitMs ?? 120_000;
  const pollIntervalMs = config.pollIntervalMs ?? 1_000;
  const pollIdle = args.pollIdle;
  let lastBusy: unknown = null;

  for (let attempt = 0; attempt <= config.maxRetries; attempt += 1) {
    try {
      await args.sendMessage();
      return;
    } catch (error) {
      if (!isWindsurfCascadeBusyError(error, config)) {
        throw error;
      }
      lastBusy = error;

      if (pollIdle) {
        let idle = false;
        let attemptElapsedMs = 0;
        while (!idle && attemptElapsedMs < perAttemptWaitMs) {
          const pollResult = await pollIdle();
          idle = pollResult.idle;
          if (!idle) {
            const remainingMs = Math.max(0, perAttemptWaitMs - attemptElapsedMs);
            const sleepMs = Math.min(pollIntervalMs, remainingMs);
            args.log('cascade.busy.wait_idle', {
              cascadeId: ctx.cascadeId,
              sessionId: ctx.sessionId,
              attempt: attempt + 1,
              elapsedMs: attemptElapsedMs,
              remainingMs,
              status: 'running',
            });
            await args.sleep(sleepMs);
            attemptElapsedMs += sleepMs;
          }
        }
        if (!idle) {
          args.log('cascade.busy.attempt_timeout', {
            cascadeId: ctx.cascadeId,
            sessionId: ctx.sessionId,
            attempt: attempt + 1,
            timeoutMs: perAttemptWaitMs,
            elapsedMs: attemptElapsedMs,
          });
          if (attempt >= config.maxRetries) {
            args.log('cascade.busy.final_timeout', {
              cascadeId: ctx.cascadeId,
              sessionId: ctx.sessionId,
              attempts: attempt + 1,
              timeoutMs: perAttemptWaitMs,
              elapsedMs: attemptElapsedMs,
            });
            throw buildWindsurfCascadeBusyError(error);
          }
          continue;
        }
        args.log('cascade.busy.wait_idle', {
          cascadeId: ctx.cascadeId,
          sessionId: ctx.sessionId,
          attempt: attempt + 1,
          elapsedMs: attemptElapsedMs,
          status: 'idle',
        });
      } else {
        if (attempt >= config.maxRetries) {
          throw buildWindsurfCascadeBusyError(error);
        }
        const delayMs = resolveWindsurfCascadeBusyDelayMs(attempt, config);
        args.log('cascade.busy.retry', { cascadeId: ctx.cascadeId, sessionId: ctx.sessionId, attempt: attempt + 1, delayMs });
        await args.sleep(delayMs);
      }
    }
  }
  throw buildWindsurfCascadeBusyError(lastBusy);
}
