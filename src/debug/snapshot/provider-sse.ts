// SSE stream capture and snapshot for provider responses
// feature_id: snapshot.stage_contract

import { buildInfo } from '../../build-info.js';
import { runtimeFlags } from '../../runtime/runtime-flags.js';
import { logSnapshotNonBlockingError } from './provider-utils.js';
import type { ProviderSnapshotWriteOptions } from './provider-writer.js';

type StreamSnapshotOptions = {
  requestId: string;
  headers?: Record<string, unknown>;
  url?: string;
  entryEndpoint?: string;
  clientRequestId?: string;
  providerKey?: string;
  providerId?: string;
  extra?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
};

let writeProviderSnapshotFn: ((opts: ProviderSnapshotWriteOptions) => Promise<void>) | null = null;

export function setWriteProviderSnapshot(fn: (opts: ProviderSnapshotWriteOptions) => Promise<void>): void {
  writeProviderSnapshotFn = fn;
}

export function shouldCaptureProviderStreamSnapshots(): boolean {
  const flag = (process.env.ROUTECODEX_CAPTURE_STREAM_SNAPSHOTS || '').trim().toLowerCase();
  if (flag === '1' || flag === 'true') {
    return true;
  }
  if (flag === '0' || flag === 'false') {
    return false;
  }
  return runtimeFlags.snapshotsEnabled && buildInfo.mode !== 'release';
}

export function attachProviderSseSnapshotStream(
  stream: NodeJS.ReadableStream,
  options: StreamSnapshotOptions
): NodeJS.ReadableStream {
  if (!writeProviderSnapshotFn) {
    return stream;
  }
  let flushed = false;
  const chunks: Buffer[] = [];
  let capturedBytes = 0;
  const maxCaptureBytes = 256 * 1024;
  const onData = (chunk: unknown) => {
    try {
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
      const remaining = maxCaptureBytes - capturedBytes;
      const slice = buf.length > remaining ? buf.subarray(0, remaining) : buf;
      chunks.push(slice);
      capturedBytes += slice.length;
    } catch (captureError) {
      logSnapshotNonBlockingError(`stream.captureData:${options.requestId}`, captureError);
    }
  };
  const flushSnapshot = (error?: unknown) => {
    if (flushed) {
      return;
    }
    flushed = true;
    try {
      stream.removeListener('data', onData);
      stream.removeListener('end', onEnd);
      stream.removeListener('close', onClose);
      stream.removeListener('error', onError);
    } catch (removeListenerError) {
      logSnapshotNonBlockingError(`stream.removeListener:${options.requestId}`, removeListenerError);
    }
    const payload: Record<string, unknown> = { mode: 'sse' };
    if (options.extra) {
      Object.assign(payload, options.extra);
    }
    if (chunks.length > 0) {
      payload.bodyText = Buffer.concat(chunks).toString('utf8');
      payload.captureBytes = capturedBytes;
      payload.captureTruncated = capturedBytes >= maxCaptureBytes;
    }
    if (error) {
      payload.error = error instanceof Error ? error.message : String(error);
    }
    void writeProviderSnapshotFn!({
      phase: 'provider-response',
      requestId: options.requestId,
      data: payload,
      headers: options.headers,
      url: options.url,
      entryEndpoint: options.entryEndpoint,
      clientRequestId: options.clientRequestId,
      providerKey: options.providerKey,
      providerId: options.providerId,
      metadata: options.metadata
    }).catch((snapshotError) => {
      logSnapshotNonBlockingError(`writeProviderSnapshot(sse):${options.requestId}`, snapshotError);
    });
  };

  const handleError = (error?: unknown) => {
    flushSnapshot(error);
  };

  const onEnd = () => flushSnapshot();
  const onClose = () => flushSnapshot();
  const onError = (error?: unknown) => handleError(error);

  stream.on('data', onData);
  stream.on('end', onEnd);
  stream.on('close', onClose);
  stream.on('error', onError);

  return stream;
}
