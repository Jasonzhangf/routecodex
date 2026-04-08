import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import { PassThrough } from 'node:stream';
import { writeSnapshotViaHooks } from '../../../modules/llmswitch/bridge.js';
import { buildInfo } from '../../../build-info.js';
import { resolveRccSnapshotsDirFromEnv } from '../../../config/user-data-paths.js';
import { runtimeFlags } from '../../../runtime/runtime-flags.js';
import { shouldCaptureSnapshotStage } from '../../../utils/snapshot-stage-policy.js';
import { writeErrorsampleJson } from '../../../utils/errorsamples.js';
import { redactSensitiveData } from '../../../utils/sensitive-redaction.js';
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

const SNAPSHOT_SUMMARY_MAX_DEPTH = 2;
const SNAPSHOT_SUMMARY_MAX_KEYS = 24;
const SNAPSHOT_SUMMARY_MAX_ARRAY_SAMPLE = 2;
const SNAPSHOT_SUMMARY_MAX_STRING_PREVIEW = 240;
const SNAPSHOT_SUMMARY_MAX_NODES = 800;
const LARGE_HISTORY_KEYS = new Set([
  'messages',
  'input',
  'history',
  'conversation',
  'contents',
  'events',
  'items'
]);

type SnapshotSummaryState = {
  visitedNodes: number;
};

function resolveBoolFromEnv(value: string | undefined, fallback: boolean): boolean {
  if (!value) {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') {
    return true;
  }
  if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') {
    return false;
  }
  return fallback;
}

function isLargeHistoryPath(pathSegments: string[]): boolean {
  if (!pathSegments.length) {
    return false;
  }
  const last = pathSegments[pathSegments.length - 1];
  return LARGE_HISTORY_KEYS.has(last.toLowerCase());
}

function resolveSnapshotFullCapture(): boolean {
  return resolveBoolFromEnv(
    process.env.ROUTECODEX_SNAPSHOT_FULL ?? process.env.RCC_SNAPSHOT_FULL,
    runtimeFlags.snapshotsEnabled
  );
}

function summarizeStringPreview(value: string): string | Record<string, unknown> {
  if (value.length <= SNAPSHOT_SUMMARY_MAX_STRING_PREVIEW) {
    return value;
  }
  return {
    __truncated: true,
    length: value.length,
    preview: `${value.slice(0, SNAPSHOT_SUMMARY_MAX_STRING_PREVIEW)}…`
  };
}

function summarizeSnapshotValue(
  value: unknown,
  depth: number,
  pathSegments: string[],
  state: SnapshotSummaryState
): unknown {
  state.visitedNodes += 1;
  if (state.visitedNodes > SNAPSHOT_SUMMARY_MAX_NODES) {
    return {
      __storage: 'mmap-hint',
      reason: 'node_budget_exceeded',
      maxNodes: SNAPSHOT_SUMMARY_MAX_NODES
    };
  }
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'string') {
    return summarizeStringPreview(value);
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }

  if (Array.isArray(value)) {
    const length = value.length;
    if (depth >= SNAPSHOT_SUMMARY_MAX_DEPTH || isLargeHistoryPath(pathSegments)) {
      return {
        __storage: 'mmap-hint',
        type: 'array',
        length,
        sampled: value
          .slice(0, SNAPSHOT_SUMMARY_MAX_ARRAY_SAMPLE)
          .map((item) => summarizeSnapshotValue(item, depth + 1, pathSegments, state))
      };
    }
    return value
      .slice(0, SNAPSHOT_SUMMARY_MAX_ARRAY_SAMPLE)
      .map((item) => summarizeSnapshotValue(item, depth + 1, pathSegments, state));
  }

  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    if (depth >= SNAPSHOT_SUMMARY_MAX_DEPTH) {
      return {
        __storage: 'mmap-hint',
        type: 'object',
        keyCount: keys.length,
        keys: keys.slice(0, SNAPSHOT_SUMMARY_MAX_KEYS)
      };
    }
    const out: Record<string, unknown> = {};
    let count = 0;
    for (const [key, child] of Object.entries(record)) {
      if (count >= SNAPSHOT_SUMMARY_MAX_KEYS) {
        out.__truncated = true;
        out.__omittedKeys = Math.max(0, keys.length - SNAPSHOT_SUMMARY_MAX_KEYS);
        break;
      }
      out[key] = summarizeSnapshotValue(child, depth + 1, [...pathSegments, key], state);
      count += 1;
    }
    return out;
  }

  return String(value);
}

function buildMmapHintedSnapshotData(value: unknown): unknown {
  return summarizeSnapshotValue(value, 0, [], { visitedNodes: 0 });
}

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
  const rawData = resolveSnapshotFullCapture()
    ? options.data
    : buildMmapHintedSnapshotData(options.data);
  const redactedData = redactSensitiveData(rawData);
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
    return;
  } catch (error) {
    logSnapshotNonBlockingError(`writeSnapshotViaHooks:${input.stage}`, error);
    try {
      const dir = path.join(resolveSnapshotBase(), input.folder, input.groupRequestId);
      await ensureDir(dir);
      const safeStage = input.stage.replace(/[^\w.-]/g, '_') || 'snapshot';
      await writeUniqueFile(dir, safeStage + '.json', JSON.stringify(input.payload, null, 2));
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
  } catch (error) {
    logSnapshotNonBlockingError(`writeSnapshotViaHooks(retry):${stage}`, error);
    try {
      const dir = path.join(resolveSnapshotBase(), folder, groupRequestId);
      await ensureDir(dir);
      const safeStage = stage.replace(/[^\w.-]/g, '_') || 'snapshot';
      await writeUniqueFile(dir, `${safeStage}.json`, JSON.stringify(payload, null, 2));
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
    const { folder } = resolveEndpoint(options.entryEndpoint);
    const groupRequestId = normalizeRequestId(options.groupRequestId || options.requestId);
    const dir = path.join(resolveSnapshotBase(), folder, groupRequestId);
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
    const fullCapture = resolveSnapshotFullCapture();
    const metadataSnapshot =
      options.metadata && typeof options.metadata === 'object'
        ? (fullCapture ? options.metadata : buildMmapHintedSnapshotData(options.metadata))
        : undefined;
    const snapshotPayload = {
      body: fullCapture ? options.body : buildMmapHintedSnapshotData(options.body),
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
    } catch (error) {
      logSnapshotNonBlockingError(`writeSnapshotViaHooks(client):${requestId}`, error);
      const dir = path.join(resolveSnapshotBase(), folder, groupRequestId);
      await ensureDir(dir);
      await writeUniqueFile(dir, `${stage}.json`, JSON.stringify(payload, null, 2));
    }
  } catch (error) {
    logSnapshotNonBlockingError('writeClientSnapshot', error);
  }
}
