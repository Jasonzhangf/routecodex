import { writeClientSnapshot } from '../../../../providers/core/utils/snapshot-writer.js';
import { evaluateSingletonRoutePoolExhaustionNative } from '../../../../modules/llmswitch/bridge/native-exports.js';
import { asRecord } from '../provider-utils.js';
import type { PipelineExecutionInput } from '../../../handlers/types.js';
import { formatUnknownError, isRecord } from '../../../../utils/common-utils.js';


function logRequestExecutorCoreNonBlockingError(
  stage: string,
  error: unknown,
  details?: Record<string, unknown>
): void {
  try {
    const detailSuffix = details && Object.keys(details).length > 0 ? ` details=${JSON.stringify(details)}` : '';
    console.warn(
      `[request-executor-core] ${stage} failed (non-blocking): ${formatUnknownError(error)}${detailSuffix}`
    );
  } catch {
    // Never throw from non-blocking logging.
  }
}

export async function writeInboundClientSnapshot(options: {
  input: PipelineExecutionInput;
  initialMetadata: Record<string, unknown>;
  clientRequestId: string;
}): Promise<void> {
  const { input, initialMetadata, clientRequestId } = options;
  try {
    const headerUa =
      (typeof input.headers?.['user-agent'] === 'string' && input.headers['user-agent']) ||
      (typeof input.headers?.['User-Agent'] === 'string' && input.headers['User-Agent']);
    const headerOriginator =
      (typeof input.headers?.['originator'] === 'string' && input.headers['originator']) ||
      (typeof input.headers?.['Originator'] === 'string' && input.headers['Originator']);
    await writeClientSnapshot({
      entryEndpoint: input.entryEndpoint,
      requestId: input.requestId,
      headers: asRecord(input.headers),
      body: input.body,
      metadata: {
        ...initialMetadata,
        clientRequestId,
        userAgent: headerUa,
        clientOriginator: headerOriginator
      }
    });
  } catch (error) {
    logRequestExecutorCoreNonBlockingError('writeInboundClientSnapshot', error, {
      entryEndpoint: input.entryEndpoint,
      requestId: input.requestId,
      clientRequestId
    });
  }
}

export function isPoolExhaustedPipelineError(pipelineError: unknown): boolean {
  const pipelineErrorCode =
    typeof (pipelineError as { code?: unknown }).code === 'string'
      ? String((pipelineError as { code?: string }).code).trim()
      : '';
  const pipelineErrorMessage =
    pipelineError instanceof Error
      ? pipelineError.message
      : String(pipelineError ?? 'Unknown error');
  return (
    pipelineErrorCode === 'PROVIDER_NOT_AVAILABLE' ||
    pipelineErrorCode === 'HTTP_429' ||
    pipelineErrorCode === 'ERR_NO_PROVIDER_TARGET' ||
    /all providers unavailable/i.test(pipelineErrorMessage) ||
    /virtual router did not produce a provider target/i.test(pipelineErrorMessage)
  );
}

export const POOL_EXHAUSTED_BACKOFF_ATTEMPTS = 3;
const POOL_EXHAUSTED_BACKOFF_STEPS_MS = [1_000, 2_000, 3_000] as const;

export function resolvePoolExhaustedBackoffMs(attemptIndex: number): number {
  return POOL_EXHAUSTED_BACKOFF_STEPS_MS[Math.min(attemptIndex, POOL_EXHAUSTED_BACKOFF_STEPS_MS.length - 1)] ?? 3_000;
}

export function resolvePoolCooldownWaitMs(pipelineError: unknown): number | undefined {
  return evaluateSingletonRoutePoolExhaustionNative({
    pipelineError,
    excludedProviderCount: 0
  }).waitMs;
}

export function shouldBlockSingletonRoutePoolExhaustion(args: {
  pipelineError: unknown;
  initialRoutePool?: string[] | null;
  explicitSingletonPool?: boolean;
  excludedProviderCount: number;
}): boolean {
  return evaluateSingletonRoutePoolExhaustionNative({
    pipelineError: args.pipelineError,
    initialRoutePoolLen: Array.isArray(args.initialRoutePool) ? args.initialRoutePool.length : undefined,
    explicitSingletonPool: args.explicitSingletonPool === true,
    excludedProviderCount: args.excludedProviderCount
  }).shouldBlock;
}

export function mergeMetadataPreservingDefined(
  base: Record<string, unknown>,
  overlay?: Record<string, unknown> | null
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };
  if (!overlay || typeof overlay !== 'object') {
    return merged;
  }
  for (const [key, value] of Object.entries(overlay)) {
    if (value !== undefined) {
      merged[key] = value;
    }
  }
  return merged;
}

// Re-export asFlatRecord from goal-state-persistence for shared use
export { asFlatRecord } from './goal-state-persistence.js';
