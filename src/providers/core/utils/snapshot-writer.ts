import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import { PassThrough } from 'node:stream';
import { writeSnapshotViaHooks } from '../../../modules/llmswitch/bridge.js';
import { buildInfo } from '../../../build-info.js';
import { resolveRccSnapshotsDirFromEnv } from '../../../config/user-data-paths.js';
import { runtimeFlags } from '../../../runtime/runtime-flags.js';
import { shouldCaptureSnapshotStage } from '../../../utils/snapshot-stage-policy.js';
import { canWriteSnapshotToLocalDisk } from '../../../utils/snapshot-local-disk-gate.js';
import { writeErrorsampleJson } from '../../../utils/errorsamples.js';
import { redactSensitiveData } from '../../../utils/sensitive-redaction.js';
import { coerceSnapshotPayloadForWrite } from '../../../utils/snapshot-payload-guard.js';
import {
  ensureSnapshotRuntimeMarker,
  pruneSnapshotRequestDirsKeepRecent,
  resolveSnapshotKeepRecentRequestDirs
} from '../../../utils/snapshot-request-retention.js';
import {
  resetProviderSnapshotErrorBufferForTests,
} from './snapshot-writer-buffer.js';
import type { ProviderSnapshotPersistInput } from './snapshot-writer-buffer.js';

type Phase =
  | 'provider-request'
  | 'provider-response'
  | 'provider-error'
  | 'provider-preprocess-debug'
  | 'provider-body-debug';
type ClientPhase = 'client-request';

type ProviderSnapshotWriteOptions = {
  phase: Phase;
  requestId: string;
  data: unknown;
  headers?: Record<string, unknown>;
  url?: string;
  entryEndpoint?: string;
  clientRequestId?: string;
  providerKey?: string;
  providerId?: string;
};

function resolveSnapshotBase(): string {
  return resolveRccSnapshotsDirFromEnv();
}

async function ensureDir(dir: string): Promise<void> {
  try {
    await fsp.mkdir(dir, { recursive: true });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(`[provider-snapshot] ensureDir failed (non-blocking) dir=${dir}: ${reason}`);
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

function resolveEndpoint(entryEndpoint?: string): { endpoint: string; folder: string } {
  // Bucket codex-samples strictly by inbound API entry endpoint.
  // Never infer snapshot folder from upstream provider URL/protocol.
  const ep = String(entryEndpoint || '').trim().toLowerCase();
  if (
    ep.includes('/v1/responses')
    || ep.includes('/responses.submit')
    || ep.includes('openai-responses')
    || ep === 'responses'
  ) {
    return { endpoint: '/v1/responses', folder: 'openai-responses' };
  }
  if (
    ep.includes('/v1/messages')
    || ep.includes('anthropic-messages')
    || ep === 'messages'
    || ep === 'anthropic'
  ) {
    return { endpoint: '/v1/messages', folder: 'anthropic-messages' };
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
  const redactedData = redactSensitiveData(options.data);
  const redactedHeaders = redactSensitiveData(maskHeaders(options.headers || {})) as Record<string, unknown>;
  return {
    meta: {
      stage: options.stage,
      version: String(process.env.ROUTECODEX_VERSION || 'dev'),
      buildTime: String(process.env.ROUTECODEX_BUILD_TIME || new Date().toISOString()),
      ...(options.extraMeta || {})
    },
    url: options.url,
    headers: redactedHeaders,
    ...(typeof redactedData === 'string' ? { bodyText: redactedData } : { body: redactedData })
  };
}

function toErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && code.trim() ? code : undefined;
}

function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }
  return value;
}

function toNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length ? trimmed : undefined;
}

function isRateLimitCode(code: string | undefined): boolean {
  if (!code) {
    return false;
  }
  const upper = code.toUpperCase();
  return (
    upper === 'HTTP_429'
    || upper.includes('RATE_LIMIT')
    || upper.includes('TOO_MANY_REQUEST')
    || upper.includes('429')
  );
}

function read429HintFromSnapshotPayload(value: unknown): boolean {
  const queue: unknown[] = [value];
  const seen = new WeakSet<object>();
  let steps = 0;

  while (queue.length > 0 && steps < 400) {
    steps += 1;
    const current = queue.shift();
    if (!current || typeof current !== 'object') {
      continue;
    }
    if (seen.has(current as object)) {
      continue;
    }
    seen.add(current as object);

    const record = current as Record<string, unknown>;
    const statusCode =
      toFiniteNumber(record.statusCode)
      ?? toFiniteNumber(record.status)
      ?? toFiniteNumber(record.httpStatus)
      ?? toFiniteNumber((record.error as Record<string, unknown> | undefined)?.status)
      ?? toFiniteNumber((record.error as Record<string, unknown> | undefined)?.statusCode);
    if (statusCode === 429) {
      return true;
    }

    const codeCandidates = [
      toNonEmptyString(record.code),
      toNonEmptyString(record.errorCode),
      toNonEmptyString(record.upstreamCode),
      toNonEmptyString((record.error as Record<string, unknown> | undefined)?.code)
    ];
    if (codeCandidates.some((candidate) => isRateLimitCode(candidate))) {
      return true;
    }

    for (const child of Object.values(record)) {
      if (!child || typeof child !== 'object') {
        continue;
      }
      queue.push(child);
    }
  }

  return false;
}

function shouldSuppressSnapshotFor429(stage: string, payload: unknown): boolean {
  const normalizedStage = String(stage || '').trim().toLowerCase();
  if (!normalizedStage) {
    return false;
  }
  if (
    !normalizedStage.includes('provider-error')
    && !normalizedStage.includes('provider-response')
    && !normalizedStage.includes('provider-request.retry')
    && !normalizedStage.includes('provider-response.retry')
  ) {
    return false;
  }
  return read429HintFromSnapshotPayload(payload);
}

async function purge429ProviderSnapshotArtifacts(options: {
  entryEndpoint?: string;
  requestId: string;
  clientRequestId?: string;
  providerKey?: string;
  providerId?: string;
}): Promise<void> {
  const { folder } = resolveEndpoint(options.entryEndpoint);
  const base = resolveSnapshotBase();
  const groupRequestId = normalizeRequestId(options.clientRequestId || options.requestId);
  const providerToken = normalizeProviderToken(options.providerKey || options.providerId || '');

  if (providerToken) {
    const providerDir = path.join(base, folder, providerToken, groupRequestId);
    try {
      await fsp.rm(providerDir, { recursive: true, force: true });
    } catch (error) {
      logSnapshotNonBlockingError(`purge429.providerDir:${providerToken}/${groupRequestId}`, error);
    }
  }

  // Legacy fallback layout: <base>/<folder>/<groupRequestId>/provider-*.json
  const legacyDir = path.join(base, folder, groupRequestId);
  try {
    const entries = await fsp.readdir(legacyDir, { withFileTypes: true });
    const providerFilePattern = /^provider-(request|response|error)(\.retry)?(?:_\d+)?\.json$/;
    await Promise.all(
      entries
        .filter((entry) => entry.isFile() && providerFilePattern.test(entry.name))
        .map((entry) => fsp.rm(path.join(legacyDir, entry.name), { force: true }))
    );
  } catch (error) {
    const code = toErrorCode(error);
    if (code !== 'ENOENT') {
      logSnapshotNonBlockingError(`purge429.legacyDir:${groupRequestId}`, error);
    }
  }
}

function schedule429ProviderSnapshotPurge(options: {
  entryEndpoint?: string;
  requestId: string;
  clientRequestId?: string;
  providerKey?: string;
  providerId?: string;
}): void {
  const recheckDelaysMs = [250, 1000, 3000];
  for (const delayMs of recheckDelaysMs) {
    const timer = setTimeout(() => {
      void purge429ProviderSnapshotArtifacts(options).catch((error) => {
        logSnapshotNonBlockingError(`purge429.schedule:${options.requestId}:${delayMs}`, error);
      });
    }, delayMs);
    if (typeof (timer as { unref?: () => void }).unref === 'function') {
      (timer as { unref: () => void }).unref();
    }
  }
}

function logSnapshotNonBlockingError(operation: string, error: unknown): void {
  const reason = error instanceof Error ? error.message : String(error);
  console.warn(`[provider-snapshot] ${operation} failed (non-blocking): ${reason}`);
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

function resolveSnapshotDir(folder: string, groupRequestId: string, providerToken?: string): string {
  if (providerToken) {
    return path.join(resolveSnapshotBase(), folder, providerToken, groupRequestId);
  }
  return path.join(resolveSnapshotBase(), folder, groupRequestId);
}

async function writeCanonicalSnapshotFileIfMissing(dir: string, baseName: string, contents: string): Promise<void> {
  try {
    await fsp.writeFile(path.join(dir, baseName), contents, { encoding: 'utf-8', flag: 'wx' });
  } catch (error) {
    if (toErrorCode(error) === 'EEXIST') {
      return;
    }
    throw error;
  }
}

async function mirrorSnapshotToLocalDisk(input: ProviderSnapshotPersistInput): Promise<void> {
  if (!canWriteSnapshotToLocalDisk(input.requestId, input.groupRequestId)) {
    return;
  }
  const dir = resolveSnapshotDir(input.folder, input.groupRequestId, input.providerToken || undefined);
  await ensureDir(dir);
  await ensureSnapshotRuntimeMarker(dir, {
    endpoint: input.endpoint,
    requestId: input.requestId,
    groupRequestId: input.groupRequestId,
    providerKey: input.providerToken || undefined
  });
  const safeStage = input.stage.replace(/[^\w.-]/g, '_') || 'snapshot';
  await writeCanonicalSnapshotFileIfMissing(dir, `${safeStage}.json`, JSON.stringify(input.payload, null, 2));
  await pruneSnapshotRequestDirsKeepRecent(path.dirname(dir), resolveSnapshotKeepRecentRequestDirs());
}

async function persistProviderSnapshot(input: ProviderSnapshotPersistInput): Promise<void> {
  try {
    await writeSnapshotViaHooks({
      endpoint: input.endpoint,
      stage: input.stage,
      requestId: input.requestId,
      groupRequestId: input.groupRequestId,
      providerKey: input.providerToken || undefined,
      data: input.payload,
      verbosity: 'verbose'
    });
    await mirrorSnapshotToLocalDisk(input);
    return;
  } catch (error) {
    logSnapshotNonBlockingError(`writeSnapshotViaHooks:${input.stage}`, error);
    try {
      await mirrorSnapshotToLocalDisk(input);
    } catch (fallbackError) {
      logSnapshotNonBlockingError(`fallbackWrite:${input.stage}`, fallbackError);
    }
  }
}

function buildProviderSnapshotPersistInput(options: ProviderSnapshotWriteOptions): ProviderSnapshotPersistInput {
  const { endpoint, folder } = resolveEndpoint(options.entryEndpoint);
  const stage = options.phase;
  const requestId = normalizeRequestId(options.requestId);
  const groupRequestId = normalizeRequestId(options.clientRequestId || options.requestId);
  const providerToken = normalizeProviderToken(options.providerKey || options.providerId || '');
  const payload = coerceSnapshotPayloadForWrite(stage, buildSnapshotPayload({
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
  }));

  return { endpoint, folder, stage, requestId, groupRequestId, providerToken, payload };
}

export function __resetProviderSnapshotErrorBufferForTests(): void {
  resetProviderSnapshotErrorBufferForTests();
}

function isErrorPhase(phase: string): boolean {
  return String(phase || '').trim().toLowerCase().includes('error');
}

async function writeProviderErrorsample(snapshot: ProviderSnapshotPersistInput): Promise<void> {
  await writeErrorsampleJson({
    group: 'provider-error',
    kind: snapshot.stage,
    payload: {
      kind: 'provider_runtime_error',
      timestamp: new Date().toISOString(),
      endpoint: snapshot.endpoint,
      stage: snapshot.stage,
      requestId: snapshot.requestId,
      groupRequestId: snapshot.groupRequestId,
      providerKey: snapshot.providerToken || undefined,
      versions: {
        routecodex: buildInfo.version,
        node: process.version
      },
      observation: snapshot.payload
    }
  });
}

export async function writeProviderSnapshot(options: ProviderSnapshotWriteOptions): Promise<void> {
  const stage = String(options.phase || '').trim();
  if (shouldSuppressSnapshotFor429(stage, options.data)) {
    const purgeInput = {
      entryEndpoint: options.entryEndpoint,
      requestId: options.requestId,
      clientRequestId: options.clientRequestId,
      providerKey: options.providerKey,
      providerId: options.providerId
    };
    await purge429ProviderSnapshotArtifacts(purgeInput);
    schedule429ProviderSnapshotPurge(purgeInput);
    return;
  }
  if (!shouldCaptureSnapshotStage(stage)) {
    return;
  }
  const snapshot = buildProviderSnapshotPersistInput(options);

  if (!runtimeFlags.snapshotsEnabled) {
    if (isErrorPhase(snapshot.stage)) {
      try {
        await writeProviderErrorsample(snapshot);
      } catch (error) {
        logSnapshotNonBlockingError(`writeProviderErrorsample:${snapshot.stage}`, error);
      }
    }
    return;
  }

  await persistProviderSnapshot(snapshot);
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

function resolveProviderStreamSnapshotMaxBytes(): number {
  const raw = String(
    process.env.ROUTECODEX_PROVIDER_STREAM_SNAPSHOT_MAX_BYTES ||
      process.env.RCC_PROVIDER_STREAM_SNAPSHOT_MAX_BYTES ||
      '2000000'
  ).trim();
  const parsed = Number(raw);
  if (!raw) {
    return 2_000_000;
  }
  if (Number.isFinite(parsed) && parsed >= 0) {
    return Math.floor(parsed);
  }
  return 2_000_000;
}

export function attachProviderSseSnapshotStream(
  stream: NodeJS.ReadableStream,
  options: StreamSnapshotOptions
): NodeJS.ReadableStream {
  const maxBytes = resolveProviderStreamSnapshotMaxBytes();
  if (maxBytes <= 0) {
    return stream;
  }

  const tee = new PassThrough();
  const capture = new PassThrough();
  stream.pipe(tee);
  stream.pipe(capture);

  const chunks: Buffer[] = [];
  let size = 0;
  let truncated = false;
  capture.on('data', (chunk) => {
    const buf = toBuffer(chunk);
    if (!buf.length) {
      return;
    }
    if (truncated || size >= maxBytes) {
      truncated = true;
      return;
    }
    const remaining = maxBytes - size;
    if (buf.length <= remaining) {
      chunks.push(buf);
      size += buf.length;
      return;
    }
    if (remaining > 0) {
      chunks.push(buf.slice(0, remaining));
      size += remaining;
    }
    truncated = true;
  });

  let flushed = false;
  const flushSnapshot = (error?: unknown) => {
    if (flushed) {
      return;
    }
    flushed = true;
    try {
      stream.unpipe(capture);
    } catch (unpipeError) {
      logSnapshotNonBlockingError(`stream.unpipe:${options.requestId}`, unpipeError);
    }
    capture.removeAllListeners();
    const raw = chunks.length ? Buffer.concat(chunks).toString('utf8') : '';
    const payload: Record<string, unknown> = { mode: 'sse' };
    if (raw) {
      payload.raw = raw;
    }
    if (truncated) {
      payload.truncated = true;
      payload.maxBytes = maxBytes;
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
    }).catch((snapshotError) => {
      logSnapshotNonBlockingError(`writeProviderSnapshot(sse):${options.requestId}`, snapshotError);
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
  if (shouldSuppressSnapshotFor429(options.type === 'request' ? 'provider-request.retry' : 'provider-response.retry', options.data)) {
    const purgeInput = {
      entryEndpoint: options.entryEndpoint,
      requestId: options.requestId,
      clientRequestId: options.clientRequestId,
      providerKey: options.providerKey,
      providerId: options.providerId
    };
    await purge429ProviderSnapshotArtifacts(purgeInput);
    schedule429ProviderSnapshotPurge(purgeInput);
    return;
  }
  if (!runtimeFlags.snapshotsEnabled) {
    return;
  }
  const { endpoint, folder } = resolveEndpoint(options.entryEndpoint);
  const stage = options.type === 'request' ? 'provider-request.retry' : 'provider-response.retry';
  if (!shouldCaptureSnapshotStage(stage)) {
    return;
  }
  const requestId = normalizeRequestId(options.requestId);
  const groupRequestId = normalizeRequestId(options.clientRequestId || options.requestId);
  const providerToken = normalizeProviderToken(options.providerKey || options.providerId || '');
  const payload = coerceSnapshotPayloadForWrite(stage, buildSnapshotPayload({
    stage,
    data: options.data,
    headers: options.headers,
    url: options.url,
    extraMeta: options.clientRequestId ? { clientRequestId: options.clientRequestId } : undefined
  }));

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
    await mirrorSnapshotToLocalDisk({ endpoint, folder, stage, requestId, groupRequestId, providerToken, payload });
    return;
  } catch (error) {
    logSnapshotNonBlockingError(`writeSnapshotViaHooks(retry):${stage}`, error);
    try {
      await mirrorSnapshotToLocalDisk({ endpoint, folder, stage, requestId, groupRequestId, providerToken, payload });
    } catch (fallbackError) {
      logSnapshotNonBlockingError(`fallbackWrite(retry):${stage}`, fallbackError);
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
  if (!runtimeFlags.snapshotsEnabled) {
    return;
  }
  if (!shouldCaptureSnapshotStage('repair-feedback')) {
    return;
  }
  try {
    // const requestId = normalizeRequestId(options.requestId);
    const { endpoint, folder } = resolveEndpoint(options.entryEndpoint);
    const groupRequestId = normalizeRequestId(options.groupRequestId || options.requestId);
    if (!canWriteSnapshotToLocalDisk(options.requestId, groupRequestId)) {
      return;
    }
    const dir = path.join(resolveSnapshotBase(), folder, groupRequestId);
    await ensureDir(dir);
    await ensureSnapshotRuntimeMarker(dir, {
      entryEndpoint: options.entryEndpoint || endpoint,
      requestId: options.requestId,
      groupRequestId,
      providerKey: options.providerKey || options.providerId || undefined
    });
    const payload = coerceSnapshotPayloadForWrite('repair-feedback', {
      meta: {
        stage: 'repair-feedback',
        version: String(process.env.ROUTECODEX_VERSION || 'dev'),
        buildTime: String(process.env.ROUTECODEX_BUILD_TIME || new Date().toISOString())
      },
      feedback: options.feedback
    });
    await writeUniqueFile(dir, 'repair-feedback.json', JSON.stringify(payload, null, 2));
    await pruneSnapshotRequestDirsKeepRecent(path.dirname(dir), resolveSnapshotKeepRecentRequestDirs());
  } catch (error) {
    logSnapshotNonBlockingError('writeRepairFeedbackSnapshot', error);
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
  if (!runtimeFlags.snapshotsEnabled) {
    return;
  }
  if (!shouldCaptureSnapshotStage('client-request')) {
    return;
  }
  try {
    const stage: ClientPhase = 'client-request';
    const { endpoint, folder } = resolveEndpoint(options.entryEndpoint);
    const requestId = normalizeRequestId(options.requestId);
    const groupRequestIdCandidate =
      options.metadata && typeof options.metadata === 'object' && typeof options.metadata.clientRequestId === 'string'
        ? (options.metadata.clientRequestId as string)
        : undefined;
    const groupRequestId = normalizeRequestId(groupRequestIdCandidate || requestId);
    const providerToken = normalizeProviderToken(options.providerKey || '');
    const metadataSnapshot =
      options.metadata && typeof options.metadata === 'object'
        ? options.metadata
        : undefined;
    const snapshotPayload = {
      body: options.body,
      metadata: metadataSnapshot || {}
    };
    const payload = coerceSnapshotPayloadForWrite(stage, buildSnapshotPayload({
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
    }));
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
      await mirrorSnapshotToLocalDisk({
        endpoint,
        folder,
        stage,
        requestId,
        groupRequestId,
        providerToken,
        payload
      });
      return;
    } catch (error) {
      logSnapshotNonBlockingError(`writeSnapshotViaHooks(client):${requestId}`, error);
      await mirrorSnapshotToLocalDisk({
        endpoint,
        folder,
        stage,
        requestId,
        groupRequestId,
        providerToken,
        payload
      });
    }
  } catch (error) {
    logSnapshotNonBlockingError('writeClientSnapshot', error);
  }
}
