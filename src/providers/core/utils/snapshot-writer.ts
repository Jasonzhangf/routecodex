import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import { PassThrough } from 'node:stream';
import { writeSnapshotViaHooks } from '../../../modules/llmswitch/bridge.js';
import { buildInfo } from '../../../build-info.js';
import { runtimeFlags } from '../../../runtime/runtime-flags.js';

type Phase =
  | 'provider-request'
  | 'provider-response'
  | 'provider-error'
  | 'provider-preprocess-debug'
  | 'provider-body-debug';
type ClientPhase = 'client-request';

function resolveSnapshotBase(): string {
  const override = String(process.env.ROUTECODEX_SNAPSHOT_DIR || process.env.RCC_SNAPSHOT_DIR || '').trim();
  if (override) {
    return path.isAbsolute(override) ? override : path.resolve(override);
  }
  return path.join(os.homedir(), '.routecodex', 'codex-samples');
}

async function ensureDir(dir: string): Promise<void> {
  try {
    await fsp.mkdir(dir, { recursive: true });
  } catch {
    // ignore mkdir errors (non-blocking snapshot)
  }
}

function normalizeRequestId(requestId?: string): string {
  if (!requestId || typeof requestId !== 'string') {
    return `req_${Date.now()}`;
  }
  const trimmed = requestId.trim();
  if (!trimmed) {
    return `req_${Date.now()}`;
  }
  const sanitized = trimmed.replace(/[^A-Za-z0-9_.-]/g, '_');
  return sanitized || `req_${Date.now()}`;
}

function normalizeProviderToken(value?: string): string {
  if (!value || typeof value !== 'string') {
    return '';
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return '';
  }
  return trimmed.replace(/[^A-Za-z0-9_.-]/g, '_');
}

function resolveEndpoint(url?: string): { endpoint: string; folder: string } {
  const rawUrl = String(url || '').toLowerCase();
  if (rawUrl.includes('/responses')) {
    return { endpoint: '/v1/responses', folder: 'openai-responses' };
  }
  if (rawUrl.includes('/messages')) {
    return { endpoint: '/v1/messages', folder: 'anthropic-messages' };
  }
  if (rawUrl.includes('/v1/openai')) {
    return { endpoint: '/v1/chat/completions', folder: 'openai-chat' };
  }
  return { endpoint: '/v1/chat/completions', folder: 'openai-chat' };
}

function maskHeaders(headers: Record<string, unknown> | undefined | null): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  if (!headers || typeof headers !== 'object') {
    return result;
  }
  for (const [k, v] of Object.entries(headers)) {
    const lower = k.toLowerCase();
    if (lower === 'authorization' || lower === 'x-api-key' || lower === 'api-key') {
      const raw = String(v ?? '');
      const masked = raw.length > 12 ? `${raw.slice(0, 6)}****${raw.slice(-6)}` : '****';
      result[k] = masked;
    } else {
      result[k] = v;
    }
  }
  return result;
}

function buildSnapshotPayload(options: {
  stage: string;
  data: unknown;
  headers?: Record<string, unknown>;
  url?: string;
  extraMeta?: Record<string, unknown>;
}) {
  return {
    meta: {
      stage: options.stage,
      version: String(process.env.ROUTECODEX_VERSION || 'dev'),
      buildTime: String(process.env.ROUTECODEX_BUILD_TIME || new Date().toISOString()),
      ...(options.extraMeta || {})
    },
    url: options.url,
    headers: maskHeaders(options.headers || {}),
    ...(typeof options.data === 'string' ? { bodyText: options.data } : { body: options.data })
  };
}

function toErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && code.trim() ? code : undefined;
}

async function writeUniqueFile(dir: string, baseName: string, contents: string): Promise<void> {
  const parsed = path.parse(baseName);
  const ext = parsed.ext || '.json';
  const stem = parsed.name || 'snapshot';
  for (let i = 0; i < 64; i += 1) {
    const name = i === 0 ? `${stem}${ext}` : `${stem}_${i}${ext}`;
    try {
      await fsp.writeFile(path.join(dir, name), contents, { encoding: 'utf-8', flag: 'wx' });
      return;
    } catch (error) {
      if (toErrorCode(error) === 'EEXIST') {
        continue;
      }
      throw error;
    }
  }
  const fallback = `${stem}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`;
  await fsp.writeFile(path.join(dir, fallback), contents, 'utf-8');
}

export async function writeProviderSnapshot(options: {
  phase: Phase;
  requestId: string;
  data: unknown;
  headers?: Record<string, unknown>;
  url?: string;
  entryEndpoint?: string;
  clientRequestId?: string;
  providerKey?: string;
  providerId?: string;
}): Promise<void> {
  if (!runtimeFlags.snapshotsEnabled) {
    return;
  }
  const { endpoint, folder } = resolveEndpoint(options.entryEndpoint || options.url);
  const stage = options.phase;
  // const requestId = normalizeRequestId(options.requestId);
  const groupRequestId = normalizeRequestId(options.clientRequestId || options.requestId);
  const providerToken = normalizeProviderToken(options.providerKey || options.providerId || '');
  const payload = buildSnapshotPayload({
    stage,
    data: options.data,
    headers: options.headers,
    url: options.url,
    extraMeta: {
      ...(options.entryEndpoint ? { entryEndpoint: options.entryEndpoint } : {}),
      ...(options.clientRequestId ? { clientRequestId: options.clientRequestId } : {}),
      ...(options.providerKey ? { providerKey: options.providerKey } : {}),
      ...(options.providerId ? { providerId: options.providerId } : {})
    }
  });

  try {
    await writeSnapshotViaHooks({
      endpoint,
      stage,
      requestId,
      groupRequestId,
      providerKey: providerToken || undefined,
      data: payload,
      verbosity: 'verbose'
    });
    return;
  } catch {
    try {
      const dir = path.join(resolveSnapshotBase(), folder, providerToken || '__pending__', groupRequestId);
      await ensureDir(dir);
      const safeStage = stage.replace(/[^\w.-]/g, '_') || 'snapshot';
      await writeUniqueFile(dir, `${safeStage}.json`, JSON.stringify(payload, null, 2));
    } catch {
      // non-blocking fallback failure
    }
  }
}

type StreamSnapshotOptions = {
  requestId: string;
  headers?: Record<string, unknown>;
  url?: string;
  entryEndpoint?: string;
  clientRequestId?: string;
  providerKey?: string;
  providerId?: string;
  extra?: Record<string, unknown>;
};

function toBuffer(chunk: unknown): Buffer {
  if (Buffer.isBuffer(chunk)) {
    return chunk;
  }
  if (chunk instanceof Uint8Array) {
    return Buffer.from(chunk);
  }
  if (typeof chunk === 'string') {
    return Buffer.from(chunk, 'utf8');
  }
  if (chunk === undefined || chunk === null) {
    return Buffer.alloc(0);
  }
  return Buffer.from(String(chunk), 'utf8');
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
  const tee = new PassThrough();
  const capture = new PassThrough();
  stream.pipe(tee);
  stream.pipe(capture);

  const chunks: Buffer[] = [];
  capture.on('data', (chunk) => {
    const buf = toBuffer(chunk);
    if (buf.length) {
      chunks.push(buf);
    }
  });

  let flushed = false;
  const flushSnapshot = (error?: unknown) => {
    if (flushed) {
      return;
    }
    flushed = true;
    try {
      stream.unpipe(capture);
    } catch {
      /* ignore unpipe failures */
    }
    capture.removeAllListeners();
    const raw = chunks.length ? Buffer.concat(chunks).toString('utf8') : '';
    const payload: Record<string, unknown> = { mode: 'sse' };
    if (raw) {
      payload.raw = raw;
    }
    if (options.extra) {
      Object.assign(payload, options.extra);
    }
    if (error) {
      payload.error = error instanceof Error ? error.message : String(error);
    }
    void writeProviderSnapshot({
      phase: 'provider-response',
      requestId: options.requestId,
      data: payload,
      headers: options.headers,
      url: options.url,
      entryEndpoint: options.entryEndpoint,
      clientRequestId: options.clientRequestId,
      providerKey: options.providerKey,
      providerId: options.providerId
    }).catch(() => {
      /* ignore snapshot errors */
    });
  };

  const handleError = (error?: unknown) => {
    flushSnapshot(error);
  };

  capture.on('end', () => flushSnapshot());
  capture.on('close', () => flushSnapshot());
  capture.on('error', handleError);
  stream.on('error', (error) => {
    flushSnapshot(error);
    // 关键：pipe 不会自动把 source error 透传给 PassThrough。
    // 若不显式 destroy，consumer（例如 SSE→JSON converter）会永久挂起等待 chunk。
    try {
      tee.destroy(error as Error);
    } catch {
      tee.destroy();
    }
  });
  tee.on('error', handleError);

  return tee;
}

export async function writeProviderRetrySnapshot(options: {
  type: 'request' | 'response';
  requestId: string;
  data: unknown;
  headers?: Record<string, unknown>;
  url?: string;
  clientRequestId?: string;
  entryEndpoint?: string;
  providerKey?: string;
  providerId?: string;
}): Promise<void> {
  const { endpoint, folder } = resolveEndpoint(options.entryEndpoint || options.url);
  const stage = options.type === 'request' ? 'provider-request.retry' : 'provider-response.retry';
  // const requestId = normalizeRequestId(options.requestId);
  const groupRequestId = normalizeRequestId(options.clientRequestId || options.requestId);
  const providerToken = normalizeProviderToken(options.providerKey || options.providerId || '');
  const payload = buildSnapshotPayload({
    stage,
    data: options.data,
    headers: options.headers,
    url: options.url,
    extraMeta: options.clientRequestId ? { clientRequestId: options.clientRequestId } : undefined
  });

  try {
    await writeSnapshotViaHooks({
      endpoint,
      stage,
      requestId,
      groupRequestId,
      providerKey: providerToken || undefined,
      data: payload,
      verbosity: 'verbose'
    });
    return;
  } catch {
    try {
      const dir = path.join(resolveSnapshotBase(), folder, providerToken || '__pending__', groupRequestId);
      await ensureDir(dir);
      const safeStage = stage.replace(/[^\w.-]/g, '_') || 'snapshot';
      await writeUniqueFile(dir, `${safeStage}.json`, JSON.stringify(payload, null, 2));
    } catch {
      // non-blocking fallback failure
    }
  }
}

export async function writeRepairFeedbackSnapshot(options: {
  requestId: string;
  feedback: unknown;
  entryEndpoint?: string;
  providerKey?: string;
  providerId?: string;
  groupRequestId?: string;
}): Promise<void> {
  try {
    // const requestId = normalizeRequestId(options.requestId);
    const { folder } = resolveEndpoint(options.entryEndpoint);
    const groupRequestId = normalizeRequestId(options.groupRequestId || options.requestId);
    const providerToken = normalizeProviderToken(options.providerKey || options.providerId || '');
    const dir = path.join(resolveSnapshotBase(), folder, providerToken || '__pending__', groupRequestId);
    await ensureDir(dir);
    const payload = {
      meta: {
        stage: 'repair-feedback',
        version: String(process.env.ROUTECODEX_VERSION || 'dev'),
        buildTime: String(process.env.ROUTECODEX_BUILD_TIME || new Date().toISOString())
      },
      feedback: options.feedback
    };
    await writeUniqueFile(dir, 'repair-feedback.json', JSON.stringify(payload, null, 2));
  } catch {
    // non-blocking
  }
}

export async function writeClientSnapshot(options: {
  entryEndpoint: string;
  requestId: string;
  headers?: Record<string, unknown>;
  body: unknown;
  metadata?: Record<string, unknown>;
  providerKey?: string;
}): Promise<void> {
  try {
    const stage: ClientPhase = 'client-request';
    const { endpoint, folder } = resolveEndpoint(options.entryEndpoint);
    // const requestId = normalizeRequestId(options.requestId);
    const groupRequestIdCandidate =
      options.metadata && typeof options.metadata === 'object' && typeof options.metadata.clientRequestId === 'string'
        ? (options.metadata.clientRequestId as string)
        : undefined;
    const groupRequestId = normalizeRequestId(groupRequestIdCandidate || requestId);
    const providerToken = normalizeProviderToken(options.providerKey || '');
    const metadataSnapshot =
      options.metadata && typeof options.metadata === 'object'
        ? JSON.parse(JSON.stringify(options.metadata))
        : undefined;
    const snapshotPayload = {
      body: options.body,
      metadata: metadataSnapshot || {}
    };
    const payload = buildSnapshotPayload({
      stage,
      data: snapshotPayload,
      headers: options.headers,
      url: endpoint,
      extraMeta: {
        entryEndpoint: endpoint,
        stream: options.metadata?.stream,
        userAgent: options.metadata?.userAgent,
        ...(metadataSnapshot ? { requestMetadata: metadataSnapshot } : {})
      }
    });
    try {
      await writeSnapshotViaHooks({
        endpoint,
        stage,
        requestId,
        groupRequestId,
        providerKey: providerToken || undefined,
        data: payload,
        verbosity: 'verbose'
      });
      return;
    } catch {
      const dir = path.join(resolveSnapshotBase(), folder, providerToken || '__pending__', groupRequestId);
      await ensureDir(dir);
      await writeUniqueFile(dir, `${stage}.json`, JSON.stringify(payload, null, 2));
    }
  } catch {
    // non-blocking
  }
}
