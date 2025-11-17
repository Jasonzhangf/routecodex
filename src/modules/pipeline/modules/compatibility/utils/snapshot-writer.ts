import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import { writeSnapshotViaHooks } from '../../../../llmswitch/bridge.js';

type Phase = 'compat-pre' | 'compat-post';

function mapEndpointToFolder(entryEndpoint?: string): string {
  const ep = String(entryEndpoint || '').toLowerCase();
  if (ep.includes('/v1/responses')) return 'openai-responses';
  if (ep.includes('/v1/messages') || ep.includes('/anthropic')) return 'anthropic-messages';
  // default to Chat route when unknown
  return 'openai-chat';
}

async function ensureDir(dir: string): Promise<void> {
  try { await fsp.mkdir(dir, { recursive: true }); } catch { /* ignore */ }
}

export async function writeCompatSnapshot(options: {
  phase: Phase;
  requestId: string;
  data: unknown;
  entryEndpoint?: string;
}): Promise<void> {
  try {
    // 统一通过 llmswitch-core hooks 快照通道写入（优先），保持与核心路径一致
    try {
      const endpoint = options.entryEndpoint || '/v1/chat/completions';
      await writeSnapshotViaHooks('compatibility', {
        endpoint,
        stage: String(options.phase),
        requestId: options.requestId,
        data: options.data,
        verbosity: 'verbose'
      });
      return;
    } catch {
      // 回退到本地写盘（非首选）
      const base = path.join(os.homedir(), '.routecodex', 'codex-samples');
      const folder = mapEndpointToFolder(options.entryEndpoint);
      const dir = path.join(base, folder);
      await ensureDir(dir);
      const file = path.join(dir, `${options.requestId}_${options.phase}.json`);
      const meta = {
        stage: options.phase,
        version: String(process.env.ROUTECODEX_VERSION || 'dev'),
        buildTime: String(process.env.ROUTECODEX_BUILD_TIME || new Date().toISOString())
      };
      const wrapped = {
        meta,
        data: options.data
      } as any;
      const payload = typeof wrapped === 'string' ? wrapped : JSON.stringify(wrapped, null, 2);
      await fsp.writeFile(file, payload, 'utf-8');
    }
  } catch {
    // snapshot is non-blocking; ignore any fs errors
  }
}
