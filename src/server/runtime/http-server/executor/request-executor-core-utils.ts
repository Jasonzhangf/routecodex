import { writeClientSnapshot } from '../../../../providers/core/utils/snapshot-writer.js';
import { asRecord } from '../provider-utils.js';
import type { PipelineExecutionInput } from '../../../handlers/types.js';

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
  } catch {
    // snapshot failure should not block request path
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
    pipelineErrorCode === 'ERR_NO_PROVIDER_TARGET' ||
    /all providers unavailable/i.test(pipelineErrorMessage) ||
    /virtual router did not produce a provider target/i.test(pipelineErrorMessage)
  );
}

const POOL_COOLDOWN_WAIT_MAX_MS = 3 * 60 * 1000;

function coercePositiveMs(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.floor(parsed);
    }
  }
  return undefined;
}

export function resolvePoolCooldownWaitMs(pipelineError: unknown): number | undefined {
  if (!pipelineError || typeof pipelineError !== 'object') {
    return undefined;
  }
  const details = (pipelineError as { details?: unknown }).details;
  if (!details || typeof details !== 'object' || Array.isArray(details)) {
    return undefined;
  }
  const record = details as Record<string, unknown>;
  const direct = coercePositiveMs(record.minRecoverableCooldownMs);
  const hints = Array.isArray(record.recoverableCooldownHints) ? record.recoverableCooldownHints : [];
  const hinted = hints.reduce<number | undefined>((best, item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return best;
    }
    const waitMs = coercePositiveMs((item as Record<string, unknown>).waitMs);
    if (!waitMs) {
      return best;
    }
    if (!best || waitMs < best) {
      return waitMs;
    }
    return best;
  }, undefined);
  const candidate = (() => {
    if (direct && hinted) {
      return Math.min(direct, hinted);
    }
    return direct ?? hinted;
  })();
  if (!candidate || candidate > POOL_COOLDOWN_WAIT_MAX_MS) {
    return undefined;
  }
  return Math.max(50, candidate);
}
