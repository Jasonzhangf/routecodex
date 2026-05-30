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

export type WindsurfCascadeBusyRetryConfig = {
  maxRetries: number;
  backoffsMs: number[];
  busyPattern?: RegExp;
};

export const WINDSURF_CASCADE_BUSY_DEFAULT_CONFIG: WindsurfCascadeBusyRetryConfig = {
  maxRetries: 4,
  backoffsMs: [1000, 2000, 4000, 8000],
  busyPattern: /CASCADE_RUN_STATUS_RUNNING|executor is not idle/i,
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
}): Promise<void> {
  const config = args.config ?? WINDSURF_CASCADE_BUSY_DEFAULT_CONFIG;
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
      if (attempt >= config.maxRetries) {
        throw buildWindsurfCascadeBusyError(error);
      }
      const delayMs = resolveWindsurfCascadeBusyDelayMs(attempt, config);
      args.log('cascade.busy.retry', { cascadeId: ctx.cascadeId, sessionId: ctx.sessionId, attempt: attempt + 1, delayMs });
      await args.sleep(delayMs);
    }
  }
  throw buildWindsurfCascadeBusyError(lastBusy);
}
