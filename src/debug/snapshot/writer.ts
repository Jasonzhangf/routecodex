// feature_id: snapshot.stage_contract — calls shouldCaptureSnapshotStage for stage gating
import fsp from 'node:fs/promises';
import path from 'node:path';
import { resolveRccSnapshotsDirFromEnv } from '../../config/user-data-paths.js';
import { runtimeFlags } from '../../runtime/runtime-flags.js';
import { shouldCaptureSnapshotStage } from '../../utils/snapshot-stage-policy.js';
import { canWriteSnapshotToLocalDisk } from '../../utils/snapshot-local-disk-gate.js';
import { coerceSnapshotPayloadForWrite } from '../../utils/snapshot-payload-guard.js';
import {
  ensureSnapshotRuntimeMarker,
  pruneSnapshotRequestDirsKeepRecent,
  resolveSnapshotKeepRecentRequestDirs,
} from '../../utils/snapshot-request-retention.js';
import { redactSensitiveData } from '../../utils/sensitive-redaction.js';
import { MetadataCenter } from '../../server/runtime/http-server/metadata-center/metadata-center.js';
import {
  readRuntimeControlProjection,
  readRuntimeRequestTruthIdentifiers
} from '../../server/runtime/http-server/metadata-center/request-truth-readers.js';
type SnapshotHookWriter = (payload: Record<string, unknown>) => Promise<void>;
let snapshotHookWriterPromise: Promise<SnapshotHookWriter | null> | null = null;

async function loadSnapshotHookWriter(): Promise<SnapshotHookWriter | null> {
  if (!snapshotHookWriterPromise) {
    snapshotHookWriterPromise = import('../../modules/llmswitch/bridge.js')
      .then((module) => (typeof module.writeSnapshotViaHooks === 'function' ? (module.writeSnapshotViaHooks as SnapshotHookWriter) : null))
      .catch(() => null);
  }
  return snapshotHookWriterPromise;
}

function logHookNonBlockingError(operation: string, error: unknown): void {
  const reason = error instanceof Error ? error.message : String(error);
  console.warn(`[snapshot-writer] ${operation} failed (non-blocking): ${reason}`);
}

// --- types ---

export type SnapshotScope = 'server' | 'provider' | 'client';

export interface SnapshotWriteInput {
  scope: SnapshotScope;
  stage: string;
  requestId: string;
  groupRequestId?: string;
  providerKey?: string;
  entryEndpoint?: string;
  entryPort?: number;
  data: unknown;
  verbosity?: 'default' | 'verbose';
  flush?: 'immediate' | 'queue';
  headers?: Record<string, unknown>;
  url?: string;
  extraMeta?: Record<string, unknown>;
  rawPayload?: unknown;
  runtimeMetadata?: Record<string, unknown>;
  forceLocalDiskWriteWhenDisabled?: boolean;
}

function isExplicitOversizeSnapshotArtifact(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return false;
  }
  const record = payload as Record<string, unknown>;
  const oversize = record.oversize;
  if (!oversize || typeof oversize !== 'object' || Array.isArray(oversize)) {
    return false;
  }
  return (oversize as Record<string, unknown>).kind === 'snapshot_payload_oversize';
}

// --- internal helpers ---

const DEFAULT_KEEP_RECENT_REQUEST_DIRS = 64;

type SnapshotGlobal = {
  rccSnapshotsEnabled?: boolean;
};

function isSnapshotsEnabled(): boolean {
  try {
    const globalScope = globalThis as SnapshotGlobal;
    if (typeof globalScope.rccSnapshotsEnabled === 'boolean') {
      return globalScope.rccSnapshotsEnabled;
    }
  } catch {
    // ignore
  }
  return runtimeFlags.snapshotsEnabled;
}

function resolveSnapshotRoot(): string {
  return resolveRccSnapshotsDirFromEnv();
}

function mapEndpointToFolder(entryEndpoint?: string): string {
  const ep = String(entryEndpoint || '').trim().toLowerCase();
  if (
    ep.includes('/v1/responses') ||
    ep.includes('/responses.submit') ||
    ep.includes('openai-responses') ||
    ep === 'responses'
  ) {
    return 'openai-responses';
  }
  if (
    ep.includes('/v1/messages') ||
    ep.includes('anthropic-messages') ||
    ep === 'messages' ||
    ep === 'anthropic'
  ) {
    return 'anthropic-messages';
  }
  return 'openai-chat';
}

function normalizeRequestId(raw?: string): string {
  if (!raw || typeof raw !== 'string') return `req_${Date.now()}`;
  const trimmed = raw.trim();
  if (!trimmed) return `req_${Date.now()}`;
  return trimmed.replace(/[^A-Za-z0-9_.-]/g, '_') || `req_${Date.now()}`;
}

function requiresPortScopedSnapshotDir(stage: string): boolean {
  const normalized = String(stage || '').trim().toLowerCase();
  return normalized.startsWith('client-')
    || normalized.startsWith('provider-');
}

function resolveRequiredEntryPort(stage: string, entryPort?: number): number | undefined {
  const numeric = typeof entryPort === 'number' && Number.isFinite(entryPort) && entryPort > 0
    ? Math.floor(entryPort)
    : undefined;
  if (numeric !== undefined) {
    return numeric;
  }
  if (requiresPortScopedSnapshotDir(stage)) {
    throw new Error(`[snapshot-writer] entryPort required for stage=${stage}`);
  }
  return undefined;
}

function toErrorCode(err: unknown): string | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' && code.trim() ? code : undefined;
}

async function ensureDir(dir: string): Promise<void> {
  try {
    await fsp.mkdir(dir, { recursive: true });
  } catch {
    // non-blocking
  }
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
      if (toErrorCode(error) === 'EEXIST') continue;
      throw error;
    }
  }
  const fallback = `${stem}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`;
  await fsp.writeFile(path.join(dir, fallback), contents, 'utf-8');
}

function logSnapshotNonBlockingError(operation: string, error: unknown): void {
  const reason = error instanceof Error ? error.message : String(error);
  console.warn(`[snapshot-writer] ${operation} failed (non-blocking): ${reason}`);
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

function buildSnapshotPayload(input: SnapshotWriteInput): unknown {
  const data = redactSensitiveData(input.data);
  const meta: Record<string, unknown> = {
    stage: input.stage,
    scope: input.scope,
    version: String(process.env.ROUTECODEX_VERSION || 'dev'),
    buildTime: String(process.env.ROUTECODEX_BUILD_TIME || new Date().toISOString()),
  };
  if (input.entryEndpoint) meta.entryEndpoint = input.entryEndpoint;
  if (typeof input.entryPort === 'number') {
    meta.entryPort = input.entryPort;
    meta.matchedPort = input.entryPort;
  }
  if (input.extraMeta) Object.assign(meta, input.extraMeta);
  const result: Record<string, unknown> = { meta };
  if (input.url) result.url = input.url;
  if (input.headers) result.headers = redactSensitiveData(maskHeaders(input.headers));
  if (typeof data === 'string') {
    result.bodyText = data;
  } else {
    result.body = data;
  }
  return result;
}

function buildSnapshotRuntimeMetadata(
  metadata: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (!metadata || typeof metadata !== 'object') {
    return undefined;
  }
  const projected: Record<string, unknown> = { ...metadata };
  const requestTruth = readRuntimeRequestTruthIdentifiers(metadata);
  const continuation = MetadataCenter.read(metadata)?.readContinuationContext();
  const runtimeControl = readRuntimeControlProjection(metadata);

  if (requestTruth.sessionId) {
    projected.sessionId = requestTruth.sessionId;
  }
  if (requestTruth.conversationId) {
    projected.conversationId = requestTruth.conversationId;
  }
  if (typeof continuation?.continuationOwner === 'string' && continuation.continuationOwner.trim()) {
    projected.continuationOwner = continuation.continuationOwner.trim();
  }
  if (typeof continuation?.responseId === 'string' && continuation.responseId.trim()) {
    projected.responseId = continuation.responseId.trim();
  }
  if (typeof continuation?.previousResponseId === 'string' && continuation.previousResponseId.trim()) {
    projected.previousResponseId = continuation.previousResponseId.trim();
  }
  if (continuation?.responsesResume && typeof continuation.responsesResume === 'object') {
    projected.responsesResume = continuation.responsesResume;
  }
  if (continuation?.responsesRequestContext && typeof continuation.responsesRequestContext === 'object') {
    projected.responsesRequestContext = continuation.responsesRequestContext;
  }
  if (runtimeControl.routeHint) {
    projected.routeHint = runtimeControl.routeHint;
  }

  const runtimeControlSummary: Record<string, unknown> = {};
  for (const key of [
    'serverToolFollowup',
    'serverToolFollowupSource',
    'stopless',
    'stoplessGoalStatus'
  ] as const) {
    if (runtimeControl[key] !== undefined) {
      runtimeControlSummary[key] = runtimeControl[key];
    }
  }
  if (Object.keys(runtimeControlSummary).length > 0) {
    projected.runtime_control = runtimeControlSummary;
  }

  return projected;
}

function resolveSnapshotDir(folder: string, groupRequestId: string, entryPort?: number): string {
  const base = resolveSnapshotRoot();
  const portSegment = entryPort !== undefined
    ? path.join('ports', String(entryPort))
    : '';
  return portSegment
    ? path.join(base, folder, portSegment, groupRequestId)
    : path.join(base, folder, groupRequestId);
}

// --- write ---

export async function writeUnifiedSnapshot(input: SnapshotWriteInput): Promise<void> {
  const snapshotsEnabled = isSnapshotsEnabled();
  if (!snapshotsEnabled && !input.forceLocalDiskWriteWhenDisabled) return;
  if (!shouldCaptureSnapshotStage(input.stage)) return;

  const groupRequestId = normalizeRequestId(input.groupRequestId || input.requestId);
  const folder = mapEndpointToFolder(input.entryEndpoint);
  const stageSafe = input.stage.replace(/[^\w.-]/g, '_') || 'snapshot';
  const entryPort = resolveRequiredEntryPort(input.stage, input.entryPort);
  if (input.rawPayload === undefined && input.data === undefined) {
    throw new Error(`[snapshot-writer] payload required for stage=${input.stage}`);
  }
  const builtPayload = input.rawPayload ?? buildSnapshotPayload(input);
  const payload = isExplicitOversizeSnapshotArtifact(builtPayload)
    ? builtPayload
    : coerceSnapshotPayloadForWrite(input.stage, builtPayload);
  if (payload === undefined) return;
  const runtimeMetadata = buildSnapshotRuntimeMetadata(input.runtimeMetadata);

  if (snapshotsEnabled) {
    try {
      const hookWriter = await loadSnapshotHookWriter();
      if (hookWriter) {
        await hookWriter({
          endpoint: input.entryEndpoint || '/v1/chat/completions',
          stage: input.stage,
          requestId: input.requestId,
          groupRequestId,
          providerKey: input.providerKey,
          entryPort,
          data: payload,
          runtimeMetadata,
          verbosity: input.verbosity || 'verbose',
        });
      }
    } catch (error) {
      logHookNonBlockingError(`hook:${input.stage}`, error);
    }
  }

  if (!canWriteSnapshotToLocalDisk(input.requestId, groupRequestId)) return;

  const dir = resolveSnapshotDir(folder, groupRequestId, entryPort);
  await ensureDir(dir);
  await ensureSnapshotRuntimeMarker(dir, {
    endpoint: input.entryEndpoint || '/v1/chat/completions',
    requestId: input.requestId,
    groupRequestId,
    providerKey: input.providerKey,
    ...(typeof entryPort === 'number' ? { entryPort, matchedPort: entryPort } : {}),
  });

  try {
    await writeUniqueFile(dir, `${stageSafe}.json`, JSON.stringify(payload, null, 2));
    await pruneSnapshotRequestDirsKeepRecent(path.dirname(dir), resolveSnapshotKeepRecentRequestDirs());
  } catch (error) {
    logHookNonBlockingError(`write:${input.stage}`, error);
  }
}

export function createSnapshotWriter() {
  return {
    write: writeUnifiedSnapshot,
    isEnabled: isSnapshotsEnabled,
  };
}

export { isSnapshotsEnabled };
