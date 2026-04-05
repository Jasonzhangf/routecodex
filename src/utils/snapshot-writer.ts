import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import { resolveRccSnapshotsDirFromEnv } from '../config/user-data-paths.js';
import { runtimeFlags } from '../runtime/runtime-flags.js';

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

function estimateSnapshotPayloadBytes(
  value: unknown,
  options?: {
    maxBytes?: number;
    depth?: number;
    seen?: Set<unknown>;
  }
): number {
  const maxBytes = options?.maxBytes ?? Number.POSITIVE_INFINITY;
  const depth = options?.depth ?? 0;
  const seen = options?.seen ?? new Set<unknown>();

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
        seen
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
        seen
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
  if (ep.includes('/v1/responses') || ep.includes('/responses.submit')) {
    return 'openai-responses';
  }
  if (ep.includes('/v1/messages')) {
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
  const endpoint = options.entryEndpoint || '/v1/chat/completions';
  const groupRequestId = options.groupRequestId || options.requestId;
  const providerKey = options.providerKey;
  const data = coerceServerSnapshotData(String(options.phase), options.data);

  // 1) 尝试通过 llmswitch-core hooks 写快照（供核心调试使用）
  try {
    const writeSnapshotViaHooks = await loadSnapshotHookWriter();
    await writeSnapshotViaHooks?.('server', {
      endpoint,
      stage: String(options.phase),
      requestId: options.requestId,
      groupRequestId,
      providerKey,
      data,
      verbosity: 'verbose'
    });
  } catch (error) {
    logServerSnapshotNonBlockingError(`writeSnapshotViaHooks:${options.phase}`, error);
    // always fall through to local file snapshot
  }

  // 2) 本地文件快照（永远写，非阻塞），便于 RouteCodex 侧对比 server/provider/pipeline
  try {
    const base = resolveSnapshotRoot();
    const folder = mapEndpointToFolder(options.entryEndpoint);
    const requestToken = String(groupRequestId || `req_${Date.now()}`).replace(/[^A-Za-z0-9_.-]/g, '_');
    const providerToken =
      typeof providerKey === 'string' && providerKey.trim().length
        ? providerKey.trim().replace(/[^A-Za-z0-9_.-]/g, '_')
        : '__pending__';
    const dir = path.join(base, folder, providerToken, requestToken);
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
    await pruneSnapshotFilesKeepRecent(dir, resolveServerSnapshotKeepRecentFiles());
  } catch (error) {
    logServerSnapshotNonBlockingError(`writeLocalSnapshot:${options.phase}`, error);
  }
}
