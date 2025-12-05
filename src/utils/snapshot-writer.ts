import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import { writeSnapshotViaHooks } from '../modules/llmswitch/bridge.js';

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
  // 环境变量显式关闭：0/false/no → 禁用；否则默认开启（便于调试与回归）
  const envRaw = String(process.env.ROUTECODEX_SNAPSHOTS || process.env.RCC_SNAPSHOTS || '').trim().toLowerCase();
  if (envRaw === '0' || envRaw === 'false' || envRaw === 'no') {
    return false;
  }
  return true;
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

export async function writeServerSnapshot(options: {
  phase: ServerSnapshotPhase;
  requestId: string;
  data: unknown;
  entryEndpoint?: string;
}): Promise<void> {
  if (!isSnapshotsEnabled()) {
    return; // default OFF
  }
  const endpoint = options.entryEndpoint || '/v1/chat/completions';

  // 1) 尝试通过 llmswitch-core hooks 写快照（供核心调试使用）
  try {
    await writeSnapshotViaHooks('server', {
      endpoint,
      stage: String(options.phase),
      requestId: options.requestId,
      data: options.data,
      verbosity: 'verbose'
    });
  } catch {
    // ignore hook errors; always fall through to local file snapshot
  }

  // 2) 本地文件快照（永远写，非阻塞），便于 RouteCodex 侧对比 server/provider/pipeline
  try {
    const base = path.join(os.homedir(), '.routecodex', 'codex-samples');
    const folder = mapEndpointToFolder(options.entryEndpoint);
    const dir = path.join(base, folder);
    await ensureDir(dir);
    const file = path.join(
      dir,
      `${options.requestId}_${String(options.phase).replace(/[^a-z0-9_.-]/gi, '_')}.json`
    );
    const payload = {
      meta: {
        stage: options.phase,
        version: String(process.env.ROUTECODEX_VERSION || 'dev'),
        buildTime: String(process.env.ROUTECODEX_BUILD_TIME || new Date().toISOString())
      },
      data: options.data
    };
    await fsp.writeFile(file, JSON.stringify(payload, null, 2), 'utf-8');
  } catch {
    /* ignore fs errors */
  }
}
