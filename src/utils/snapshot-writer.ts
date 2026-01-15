import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import { writeSnapshotViaHooks } from '../modules/llmswitch/bridge.js';
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
  const override = String(process.env.ROUTECODEX_SNAPSHOT_DIR || process.env.RCC_SNAPSHOT_DIR || '').trim();
  if (override) {
    return path.isAbsolute(override) ? override : path.resolve(override);
  }
  return path.join(os.homedir(), '.routecodex', 'codex-samples');
}

function mapEndpointToFolder(entryEndpoint?: string): string {
  const ep = String(entryEndpoint || '').toLowerCase();
  if (ep.includes('/v1/responses')) {
    return 'openai-responses';
  }
  if (ep.includes('/v1/messages') || ep.includes('/anthropic')) {
    return 'anthropic-messages';
  }
  return 'openai-chat';
}

async function ensureDir(dir: string): Promise<void> {
  try { await fsp.mkdir(dir, { recursive: true }); } catch { /* ignore */ }
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

  // 1) 尝试通过 llmswitch-core hooks 写快照（供核心调试使用）
  try {
    await writeSnapshotViaHooks('server', {
      endpoint,
      stage: String(options.phase),
      requestId: options.requestId,
      groupRequestId,
      providerKey,
      data: options.data,
      verbosity: 'verbose'
    });
  } catch {
    // ignore hook errors; always fall through to local file snapshot
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
      data: options.data
    };
    await writeUniqueFile(dir, file, JSON.stringify(payload, null, 2));
  } catch {
    /* ignore fs errors */
  }
}
