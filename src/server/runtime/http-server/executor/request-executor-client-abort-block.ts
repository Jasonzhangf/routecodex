import {
  getClientConnectionAbortSignal,
  type ClientConnectionState
} from '../../../utils/client-connection-state.js';
import { createClientDisconnectedAbortError } from './request-executor-abort.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isAbortSignalLike(value: unknown): value is AbortSignal {
  return !!value && typeof value === 'object' && 'aborted' in value;
}

export function resolveClientAbortSignalFromCarrier(source: unknown): AbortSignal | undefined {
  if (!source) {
    return undefined;
  }
  if (isAbortSignalLike(source)) {
    return source;
  }
  if (!isRecord(source)) {
    return undefined;
  }
  const directSignal = source.clientAbortSignal;
  if (isAbortSignalLike(directSignal)) {
    return directSignal;
  }
  return getClientConnectionAbortSignal(source as ClientConnectionState | Record<string, unknown>);
}

export function resolveClientAbortSignalFromCarriers(
  ...sources: unknown[]
): AbortSignal | undefined {
  for (const source of sources) {
    const signal = resolveClientAbortSignalFromCarrier(source);
    if (signal) {
      return signal;
    }
  }
  return undefined;
}

export function throwIfClientCarrierAborted(...sources: unknown[]): void {
  const signal = resolveClientAbortSignalFromCarriers(...sources);
  if (!signal?.aborted) {
    return;
  }
  const reason = (signal as { reason?: unknown }).reason;
  throw reason instanceof Error ? reason : createClientDisconnectedAbortError(reason);
}

export function preserveLiveClientAbortCarriers(args: {
  source?: Record<string, unknown>;
  target?: Record<string, unknown>;
}): void {
  const { source, target } = args;
  if (!source || !target) {
    return;
  }
  if (source.clientConnectionState && typeof source.clientConnectionState === 'object') {
    target.clientConnectionState = source.clientConnectionState;
  }
  if (isAbortSignalLike(source.clientAbortSignal)) {
    target.clientAbortSignal = source.clientAbortSignal;
  }
}
