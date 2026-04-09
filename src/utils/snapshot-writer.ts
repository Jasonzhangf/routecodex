import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import { resolveRccSnapshotsDirFromEnv } from '../config/user-data-paths.js';
import { runtimeFlags } from '../runtime/runtime-flags.js';
import { shouldCaptureSnapshotStage } from './snapshot-stage-policy.js';
import { canWriteSnapshotToLocalDisk } from './snapshot-local-disk-gate.js';

export type ServerSnapshotPhase =
  | 'http-request'
  | 'routing-selected'
  | 'llm-switch-request'
  | 'compatibility-request'
  | 'compatibility-response'
  | 'llm-switch-response'
  | 'final-response'
  | 'http-response'
  | 'http-response.error'
  | string;

type SnapshotGlobal = {
  rccSnapshotsEnabled?: boolean;
};

type SnapshotHookWriter = (scope: string, payload: Record<string, unknown>) => Promise<void>;

let snapshotHookWriterPromise: Promise<SnapshotHookWriter | null> | null = null;
const DEFAULT_SERVER_SNAPSHOT_PAYLOAD_MAX_BYTES = 256 * 1024;
const DEFAULT_SERVER_SNAPSHOT_KEEP_RECENT_FILES = 10;
const DEFAULT_SERVER_SNAPSHOT_PRUNE_INTERVAL_MS = 15_000;
const DEFAULT_SERVER_SNAPSHOT_PRUNE_MIN_WRITES = 8;
const DEFAULT_SERVER_SNAPSHOT_ESTIMATE_NODE_BUDGET = 4000;

type SnapshotPruneState = {
  pending: boolean;
  lastPruneAt: number;
  writesSinceLastPrune: number;
};

const snapshotPruneStates = new Map<string, SnapshotPruneState>();

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

function shouldForceServerSnapshotDualWrite(): boolean {
  return resolveBoolFromEnv(
    process.env.ROUTECODEX_SERVER_SNAPSHOT_FORCE_DUAL_WRITE
      ?? process.env.RCC_SERVER_SNAPSHOT_FORCE_DUAL_WRITE,
    false
  );
}

function resolveSnapshotFullCapture(): boolean {
  return resolveBoolFromEnv(
    process.env.ROUTECODEX_SNAPSHOT_FULL ?? process.env.RCC_SNAPSHOT_FULL,
    false
  );
}

function resolveServerSnapshotPayloadMaxBytes(): number {
  const raw =
    process.env.ROUTECODEX_SNAPSHOT_PAYLOAD_MAX_BYTES
    ?? process.env.RCC_SNAPSHOT_PAYLOAD_MAX_BYTES
    ?? '';
  const parsed = Number.parseInt(String(raw).trim(), 10);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  return DEFAULT_SERVER_SNAPSHOT_PAYLOAD_MAX_BYTES;
}

function resolveServerSnapshotKeepRecentFiles(): number {
  const raw =
    process.env.ROUTECODEX_SNAPSHOT_KEEP_RECENT_FILES
    ?? process.env.RCC_SNAPSHOT_KEEP_RECENT_FILES
    ?? '';
  const parsed = Number.parseInt(String(raw).trim(), 10);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  return DEFAULT_SERVER_SNAPSHOT_KEEP_RECENT_FILES;
}

function resolveServerSnapshotPruneIntervalMs(): number {
  const raw =
    process.env.ROUTECODEX_SNAPSHOT_PRUNE_INTERVAL_MS
    ?? process.env.RCC_SNAPSHOT_PRUNE_INTERVAL_MS
    ?? '';
  const parsed = Number.parseInt(String(raw).trim(), 10);
  if (Number.isFinite(parsed) && parsed >= 0) {
    return parsed;
  }
  return DEFAULT_SERVER_SNAPSHOT_PRUNE_INTERVAL_MS;
}

function resolveServerSnapshotPruneMinWrites(): number {
  const raw =
    process.env.ROUTECODEX_SNAPSHOT_PRUNE_MIN_WRITES
    ?? process.env.RCC_SNAPSHOT_PRUNE_MIN_WRITES
    ?? '';
  const parsed = Number.parseInt(String(raw).trim(), 10);
  if (Number.isFinite(parsed) && parsed >= 1) {
    return parsed;
  }
  return DEFAULT_SERVER_SNAPSHOT_PRUNE_MIN_WRITES;
}

function estimateSnapshotPayloadBytes(
  value: unknown,
  options?: {
    maxBytes?: number;
    depth?: number;
    seen?: Set<unknown>;
    nodeBudget?: number;
    visitedNodes?: number;
  }
): number {
  const maxBytes = options?.maxBytes ?? Number.POSITIVE_INFINITY;
  const depth = options?.depth ?? 0;
  const seen = options?.seen ?? new Set<unknown>();
  const nodeBudget = options?.nodeBudget ?? DEFAULT_SERVER_SNAPSHOT_ESTIMATE_NODE_BUDGET;
  const visitedNodes = (options?.visitedNodes ?? 0) + 1;

  if (visitedNodes > nodeBudget) {
    return maxBytes + 1;
  }

  if (value === null || value === undefined) {
    return 4;
  }
  const valueType = typeof value;
  if (valueType === 'string') {
    return Math.min(maxBytes + 1, (value as string).length * 2 + 2);
  }
  if (valueType === 'number') {
    return 8;
  }
  if (valueType === 'boolean') {
    return 4;
  }
  if (valueType === 'bigint') {
    return String(value).length + 8;
  }
  if (valueType === 'symbol' || valueType === 'function') {
    return 16;
  }
  if (seen.has(value)) {
    return 8;
  }
  seen.add(value);

  if (depth >= 8) {
    return 64;
  }

  let bytes = 0;
  if (Array.isArray(value)) {
    bytes += 2;
    for (const item of value) {
      bytes += estimateSnapshotPayloadBytes(item, {
        maxBytes: Math.max(0, maxBytes - bytes),
        depth: depth + 1,
        seen,
        nodeBudget,
        visitedNodes
      });
      if (bytes > maxBytes) {
        return maxBytes + 1;
      }
    }
    return bytes;
  }
  if (value && typeof value === 'object') {
    bytes += 2;
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      bytes += key.length * 2 + 4;
      bytes += estimateSnapshotPayloadBytes(child, {
        maxBytes: Math.max(0, maxBytes - bytes),
        depth: depth + 1,
        seen,
        nodeBudget,
        visitedNodes
      });
      if (bytes > maxBytes) {
        return maxBytes + 1;
      }
    }
    return bytes;
  }
  return 16;
}

function summarizeSnapshotPayload(value: unknown): Record<string, unknown> {
  if (Array.isArray(value)) {
    return {
      type: 'array',
      length: value.length,
      sampleTypes: value.slice(0, 8).map((item) => typeof item)
    };
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    return {
      type: 'object',
      keyCount: keys.length,
      keys: keys.slice(0, 24)
    };
  }
  if (typeof value === 'string') {
    return {
      type: 'string',
      length: value.length,
      preview: value.length > 160 ? `${value.slice(0, 160)}…` : value
    };
  }
  return {
    type: typeof value,
    value: value ?? null
  };
}

function coerceServerSnapshotData(stage: string, data: unknown): unknown {
  if (resolveSnapshotFullCapture()) {
    return data;
  }
  const maxBytes = resolveServerSnapshotPayloadMaxBytes();
  const estimatedBytes = estimateSnapshotPayloadBytes(data, { maxBytes: maxBytes + 1 });
  if (estimatedBytes <= maxBytes) {
    return data;
  }
  return {
    __snapshot_truncated: true,
    stage,
    maxBytes,
    estimatedBytes,
    summary: summarizeSnapshotPayload(data)
  };
}

function logServerSnapshotNonBlockingError(operation: string, error: unknown): void {
  const reason = error instanceof Error ? error.message : String(error);
  console.warn(`[server-snapshot] ${operation} failed (non-blocking): ${reason}`);
}

export function isSnapshotsEnabled(): boolean {
  // 优先使用运行时全局覆盖（由服务器根据 virtualRouter config 注入）
  try {
    const globalScope = globalThis as SnapshotGlobal;
    if (typeof globalScope.rccSnapshotsEnabled === 'boolean') {
      return globalScope.rccSnapshotsEnabled;
    }
  } catch {
    /* ignore */
  }
  return runtimeFlags.snapshotsEnabled;
}

function resolveSnapshotRoot(): string {
  return resolveRccSnapshotsDirFromEnv();
}

function mapEndpointToFolder(entryEndpoint?: string): string {
  const ep = String(entryEndpoint || '').trim().toLowerCase();
  if (
    ep.includes('/v1/responses')
    || ep.includes('/responses.submit')
    || ep.includes('openai-responses')
    || ep === 'responses'
  ) {
    return 'openai-responses';
  }
  if (
    ep.includes('/v1/messages')
    || ep.includes('anthropic-messages')
    || ep === 'messages'
    || ep === 'anthropic'
  ) {
    return 'anthropic-messages';
  }
  return 'openai-chat';
}

async function ensureDir(dir: string): Promise<void> {
  try {
    await fsp.mkdir(dir, { recursive: true });
  } catch (error) {
    logServerSnapshotNonBlockingError(`ensureDir:${dir}`, error);
  }
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

async function pruneSnapshotFilesKeepRecent(dir: string, maxFiles: number): Promise<void> {
  if (!Number.isFinite(maxFiles) || maxFiles <= 0) {
    return;
  }
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const candidates = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json') && entry.name !== '__runtime.json')
    .map((entry) => entry.name);
  if (candidates.length <= maxFiles) {
    return;
  }

  const filesWithMtime = await Promise.all(
    candidates.map(async (name) => {
      const fullPath = path.join(dir, name);
      const stat = await fsp.stat(fullPath);
      return {
        name,
        fullPath,
        mtimeMs: Number.isFinite(stat.mtimeMs) ? stat.mtimeMs : 0
      };
    })
  );

  filesWithMtime.sort((a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name));
  const stale = filesWithMtime.slice(maxFiles);
  await Promise.all(
    stale.map(async (file) => {
      try {
        await fsp.unlink(file.fullPath);
      } catch {
        // best-effort prune, never block request path
      }
    })
  );
}

function scheduleSnapshotPrune(dir: string, maxFiles: number): void {
  if (!Number.isFinite(maxFiles) || maxFiles <= 0) {
    return;
  }
  const now = Date.now();
  const state = snapshotPruneStates.get(dir) ?? {
    pending: false,
    lastPruneAt: 0,
    writesSinceLastPrune: 0
  };
  state.writesSinceLastPrune += 1;

  if (state.pending) {
    snapshotPruneStates.set(dir, state);
    return;
  }

  const pruneIntervalMs = resolveServerSnapshotPruneIntervalMs();
  const pruneMinWrites = resolveServerSnapshotPruneMinWrites();
  const shouldPruneByWrites = state.writesSinceLastPrune >= pruneMinWrites;
  const shouldPruneByInterval = pruneIntervalMs <= 0 || now - state.lastPruneAt >= pruneIntervalMs;
  if (!shouldPruneByWrites && !shouldPruneByInterval) {
    snapshotPruneStates.set(dir, state);
    return;
  }

  state.pending = true;
  state.writesSinceLastPrune = 0;
  snapshotPruneStates.set(dir, state);

  void pruneSnapshotFilesKeepRecent(dir, maxFiles)
    .catch((error) => {
      logServerSnapshotNonBlockingError(`pruneSnapshotFilesKeepRecent:${dir}`, error);
    })
    .finally(() => {
      const latest = snapshotPruneStates.get(dir);
      if (!latest) {
        return;
      }
      latest.pending = false;
      latest.lastPruneAt = Date.now();
      snapshotPruneStates.set(dir, latest);
    });
}

async function loadSnapshotHookWriter(): Promise<SnapshotHookWriter | null> {
  if (!snapshotHookWriterPromise) {
    snapshotHookWriterPromise = import('../modules/llmswitch/bridge.js')
      .then((module) => (typeof module.writeSnapshotViaHooks === 'function' ? (module.writeSnapshotViaHooks as SnapshotHookWriter) : null))
      .catch((error) => {
        logServerSnapshotNonBlockingError('loadSnapshotHookWriter', error);
        return null;
      });
  }
  return snapshotHookWriterPromise;
}

export async function writeServerSnapshot(options: {
  phase: ServerSnapshotPhase;
  requestId: string;
  data: unknown;
  entryEndpoint?: string;
  providerKey?: string;
  groupRequestId?: string;
}): Promise<void> {
  if (!isSnapshotsEnabled()) {
    return; // default OFF
  }
  if (!shouldCaptureSnapshotStage(String(options.phase))) {
    return;
  }
  const endpoint = options.entryEndpoint || '/v1/chat/completions';
  const groupRequestId = options.groupRequestId || options.requestId;
  const providerKey = options.providerKey;
  const data = coerceServerSnapshotData(String(options.phase), options.data);

  let hookWritten = false;
  // 1) 优先通过 llmswitch-core hooks 写快照（供核心调试使用）
  try {
    const writeSnapshotViaHooks = await loadSnapshotHookWriter();
    if (writeSnapshotViaHooks) {
      await writeSnapshotViaHooks('server', {
        endpoint,
        stage: String(options.phase),
        requestId: options.requestId,
        groupRequestId,
        providerKey,
        data,
        verbosity: 'verbose'
      });
      hookWritten = true;
    }
  } catch (error) {
    logServerSnapshotNonBlockingError(`writeSnapshotViaHooks:${options.phase}`, error);
  }

  // 默认单写（hook 成功就不再本地重复落盘），避免 snapshot 双写导致 I/O 与内存占用放大。
  // 若需要双写排障，可显式打开 ROUTECODEX_SERVER_SNAPSHOT_FORCE_DUAL_WRITE=1。
  if (hookWritten && !shouldForceServerSnapshotDualWrite()) {
    return;
  }

  // 2) fallback 本地文件快照（hook 不可用/失败时）
  try {
    if (!canWriteSnapshotToLocalDisk(options.requestId, groupRequestId)) {
      return;
    }
    const base = resolveSnapshotRoot();
    const folder = mapEndpointToFolder(options.entryEndpoint);
    const requestToken = String(groupRequestId || `req_${Date.now()}`).replace(/[^A-Za-z0-9_.-]/g, '_');
    const dir = path.join(base, folder, requestToken);
    await ensureDir(dir);
    const stageToken = String(options.phase).replace(/[^a-z0-9_.-]/gi, '_');
    const file = `${stageToken}_server.json`;
    const payload = {
      meta: {
        stage: options.phase,
        version: String(process.env.ROUTECODEX_VERSION || 'dev'),
        buildTime: String(process.env.ROUTECODEX_BUILD_TIME || new Date().toISOString())
      },
      data
    };
    await writeUniqueFile(dir, file, JSON.stringify(payload, null, 2));
    scheduleSnapshotPrune(dir, resolveServerSnapshotKeepRecentFiles());
  } catch (error) {
    logServerSnapshotNonBlockingError(`writeLocalSnapshot:${options.phase}`, error);
  }
}
