import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import type { Response } from 'express';
import { isSnapshotsEnabled, writeServerSnapshot } from '../../utils/snapshot-writer.js';
import { shouldCaptureSnapshotStage } from '../../utils/snapshot-stage-policy.js';
import { releaseMetadataCenterForHttpResponse } from '../runtime/http-server/metadata-center/metadata-center.js';
import { getSessionExecutionStateTracker } from '../runtime/http-server/session-execution-state.js';

export { releaseMetadataCenterForHttpResponse };

/**
 * Phase Server-C: assertClientResponseHasNoInternalCarriers.
 * Client response body / SSE payload must NOT contain internal metadata,
 * Meta* carriers, Error* carriers, or Snapshot* carriers.
 * Violations must fail-fast, never silently delete.
 */
const CLIENT_RESPONSE_FORBIDDEN_FIELDS: ReadonlySet<string> = new Set([
  'metaCarrier',
  'runtimeMetadata',
  'errorCarrier',
  'classifiedError',
  '__rt',
  '__internal',
  'snapshot',
  'snapshotId',
  '__raw_request_body',
  'internalDetails',
  'upstreamRequestId',
  'providerStack',
  'sseStream',
]);

const BLOCKED_HEADERS = new Set(['content-length', 'transfer-encoding', 'connection', 'content-encoding']);
const MAX_CARRIER_DEPTH = 20;

const INTERNAL_METADATA_KEYS: ReadonlySet<string> = new Set([
  'routeHint',
  'routeName',
  'providerKey',
  'runtimeKey',
  'poolId',
  'serverToolFollowup',
  'serverToolFollowupMode',
  'stopMessageEnabled',
  'routecodexPortStopMessageEnabled',
  'clientAbortSignal',
  'clientConnectionState',
]);

export type ResponsesRequestContext = {
  payload: Record<string, unknown>;
  context: Record<string, unknown>;
  sessionId?: string;
  conversationId?: string;
  matchedPort?: number;
  routingPolicyGroup?: string;
};

export interface DispatchOptions {
  forceSSE?: boolean;
  entryEndpoint?: string;
  entryPort?: number;
  sseTotalTimeoutMs?: number;
  responsesRequestContext?: ResponsesRequestContext;
}

export type ClientSseSnapshotRecorder = {
  record: (chunk: unknown) => void;
  flush: (error?: unknown) => void;
};

export function resolveSnapshotGroupRequestId(args: {
  explicitGroupRequestId?: string;
  metadata?: Record<string, unknown>;
}): string | undefined {
  const candidates = [
    args.explicitGroupRequestId,
    args.metadata?.clientRequestId,
    args.metadata?.groupRequestId,
  ];
  for (const value of candidates) {
    if (typeof value !== 'string') {
      continue;
    }
    const trimmed = value.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return undefined;
}

export function resolveSnapshotEntryPort(args: {
  explicitEntryPort?: number;
  metadata?: Record<string, unknown>;
  usageEntryPort?: number;
}): number | undefined {
  const candidates = [
    args.explicitEntryPort,
    args.usageEntryPort,
    args.metadata?.entryPort,
    args.metadata?.matchedPort,
    args.metadata?.routecodexLocalPort
  ];
  for (const value of candidates) {
    const numeric = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
    if (Number.isFinite(numeric) && numeric > 0) {
      return Math.floor(numeric);
    }
  }
  return undefined;
}

type PipeCapable = { pipe?: unknown };
type WebReadable = { getReader?: () => unknown };
type AsyncIterableLike = { [Symbol.asyncIterator]?: () => AsyncIterator<unknown> };

function isInternalMetadataCarrier(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key.startsWith('__routecodex') || key.startsWith('__rt') || INTERNAL_METADATA_KEYS.has(key)) {
      return true;
    }
  }
  return false;
}

function isClientVisibleProtocolMetadataContainer(record: Record<string, unknown>): boolean {
  const object = typeof record.object === 'string' ? record.object.trim() : '';
  if (object === 'response') {
    return true;
  }
  const type = typeof record.type === 'string' ? record.type.trim() : '';
  if (type.startsWith('response.')) {
    return true;
  }
  return false;
}

function findForbiddenFieldInResponsePayload(
  payload: unknown,
  seen: WeakSet<object> = new WeakSet(),
  depth = 0
): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  if (seen.has(payload as object)) return undefined;
  seen.add(payload as object);
  if (depth >= MAX_CARRIER_DEPTH) return undefined;
  if (Array.isArray(payload)) {
    for (const item of payload) {
      const found = findForbiddenFieldInResponsePayload(item, seen, depth + 1);
      if (found) return found;
    }
    return undefined;
  }
  const record = payload as Record<string, unknown>;
  for (const [key, value] of Object.entries(record)) {
    if (key === 'metadata') {
      if (!isClientVisibleProtocolMetadataContainer(record)) {
        return key;
      }
      if (isInternalMetadataCarrier(value)) {
        return key;
      }
      const nestedMetadata = findForbiddenFieldInResponsePayload(value, seen, depth + 1);
      if (nestedMetadata) {
        return nestedMetadata === 'metadata' ? key : nestedMetadata;
      }
      continue;
    }
    if (CLIENT_RESPONSE_FORBIDDEN_FIELDS.has(key)) {
      return key;
    }
    const found = findForbiddenFieldInResponsePayload(value, seen, depth + 1);
    if (found) return found;
  }
  return undefined;
}

export function assertClientResponseHasNoInternalCarriers(payload: unknown, requestId: string): void {
  const found = findForbiddenFieldInResponsePayload(payload);
  if (found) {
    throw new Error(
      `[server.response_projection] client response contains internal carrier field "${found}" (requestId=${requestId})`
    );
  }
}

export function logResponseNonBlockingError(operation: string, error: unknown): void {
  const reason = error instanceof Error ? error.message : String(error);
  console.warn(`[handler-response] ${operation} failed (non-blocking): ${reason}`);
}

export function recordSseTransportStreamStart(requestId: string): void {
  getSessionExecutionStateTracker().recordSseStreamStart(requestId);
}

export function recordSseTransportStreamEnd(
  requestId: string,
  options?: { finishReason?: string; terminal?: boolean }
): void {
  getSessionExecutionStateTracker().recordSseStreamEnd(requestId, options);
}

export function recordSseTransportClientClose(
  requestId: string,
  options?: { finishReason?: string; terminal?: boolean; closeBeforeStreamEnd?: boolean }
): void {
  getSessionExecutionStateTracker().recordSseClientClose(requestId, options);
}

export function finalizeSseTransportCloseout(args: {
  metadata?: Record<string, unknown>;
  releaseReason?: string;
  logResponseCompleted?: (details?: Record<string, unknown>) => void;
  completedDetails?: Record<string, unknown>;
}): void {
  if (args.releaseReason) {
    releaseMetadataCenterForHttpResponse(args.metadata, args.releaseReason);
  }
  args.logResponseCompleted?.(args.completedDetails);
}

export function applyHeaders(
  res: Response,
  headers: Record<string, string> | undefined,
  omitContentType: boolean
): void {
  if (!headers) {
    return;
  }
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value !== 'string') {
      continue;
    }
    const normalized = key.toLowerCase();
    if (BLOCKED_HEADERS.has(normalized)) {
      continue;
    }
    if (omitContentType && normalized === 'content-type') {
      continue;
    }
    res.setHeader(key, value);
  }
}

export function toNodeReadable(streamLike: unknown): Readable | null {
  if (!streamLike) {
    return null;
  }
  if (streamLike instanceof Readable) {
    return streamLike;
  }
  const pipeCandidate = streamLike as PipeCapable;
  if (pipeCandidate && typeof pipeCandidate.pipe === 'function') {
    return streamLike as Readable;
  }
  const webCandidate = streamLike as WebReadable;
  if (webCandidate && typeof webCandidate.getReader === 'function') {
    try {
      return Readable.fromWeb(streamLike as NodeReadableStream);
    } catch (error) {
      logResponseNonBlockingError('toNodeReadable.fromWeb', error);
      return null;
    }
  }
  const asyncIterable = streamLike as AsyncIterableLike;
  if (asyncIterable && typeof asyncIterable[Symbol.asyncIterator] === 'function') {
    return Readable.from(streamLike as AsyncIterable<unknown>);
  }
  return null;
}

export function shouldCaptureClientResponseSnapshotStage(stage: 'client-response' | 'client-response.error'): boolean {
  return isSnapshotsEnabled() && shouldCaptureSnapshotStage(stage);
}

export function maybeAttachClientSseSnapshotStream(
  stream: NodeJS.ReadableStream,
  recorder?: ClientSseSnapshotRecorder
): NodeJS.ReadableStream {
  stream.on('data', (chunk: unknown) => recorder?.record(chunk));
  stream.on('error', (error: unknown) => recorder?.flush(error));

  return stream;
}

export function createClientSseSnapshotRecorder(
  stream: NodeJS.ReadableStream,
  res: Response,
  options: {
    requestId: string;
    groupRequestId?: string;
    entryEndpoint?: string;
    entryPort?: number;
    status: number;
    headers?: Record<string, string>;
    metadata?: Record<string, unknown>;
    usageEntryPort?: number;
  }
): ClientSseSnapshotRecorder {
  let flushed = false;
  const chunks: Buffer[] = [];
  let capturedBytes = 0;
  const maxCaptureBytes = 256 * 1024;

  const record = (chunk: unknown) => {
    if (capturedBytes >= maxCaptureBytes) {
      return;
    }
    const buf = Buffer.isBuffer(chunk)
      ? chunk
      : typeof chunk === 'string'
        ? Buffer.from(chunk)
        : chunk instanceof Uint8Array
          ? Buffer.from(chunk)
          : null;
    if (!buf || buf.length === 0) {
      return;
    }
    const remaining = Math.max(0, maxCaptureBytes - capturedBytes);
    const slice = buf.length > remaining ? buf.subarray(0, remaining) : buf;
    chunks.push(slice);
    capturedBytes += slice.length;
  };

  const flush = (error?: unknown) => {
    if (flushed) {
      return;
    }
    flushed = true;
    try {
      res.removeListener('finish', onFinish);
      res.removeListener('close', onClose);
      res.removeListener('end', onEnd);
      stream.removeListener('error', onError);
    } catch (removeError) {
      logResponseNonBlockingError(`client-sse-snapshot.removeListener:${options.requestId}`, removeError);
    }
    const payload: Record<string, unknown> = {
      mode: 'sse',
      status: options.status,
      headers: options.headers,
      bodyText: Buffer.concat(chunks).toString('utf8'),
      truncated: capturedBytes >= maxCaptureBytes
    };
    if (error) {
      payload.error = error instanceof Error ? error.message : String(error);
    }
    void writeServerSnapshot({
      phase: 'client-response',
      requestId: options.requestId,
      groupRequestId: options.groupRequestId,
      entryEndpoint: options.entryEndpoint,
      entryPort: resolveSnapshotEntryPort({
        explicitEntryPort: options.entryPort,
        metadata: options.metadata,
        usageEntryPort: options.usageEntryPort
      }),
      data: payload
    }).catch((snapshotError) => {
      logResponseNonBlockingError(`writeServerSnapshot:sse_payload:${options.requestId}`, snapshotError);
    });
  };

  const onFinish = () => flush();
  const onClose = () => flush();
  const onEnd = () => flush();
  const onError = (error: unknown) => flush(error);

  res.on('finish', onFinish);
  res.on('close', onClose);
  res.on('end', onEnd);
  stream.on('error', onError);

  return { record, flush };
}
