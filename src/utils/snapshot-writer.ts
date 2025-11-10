import fsp from 'fs/promises';
import os from 'os';
import path from 'path';

export type ServerSnapshotPhase =
  | 'http-request'
  | 'routing-selected'
  | 'llm-switch-request'
  | 'workflow-request'
  | 'compatibility-request'
  | 'compatibility-response'
  | 'workflow-response'
  | 'llm-switch-response'
  | 'final-response'
  | 'http-response'
  | 'http-response.error'
  | string;

export function isSnapshotsEnabled(): boolean {
  try {
    const g: any = globalThis as any;
    if (typeof g.rccSnapshotsEnabled === 'boolean') return g.rccSnapshotsEnabled;
  } catch { /* ignore */ }
  const env = String(process.env.ROUTECODEX_SNAPSHOTS || process.env.RCC_SNAPSHOTS || '').trim().toLowerCase();
  return env === '1' || env === 'true' || env === 'yes';
}

function mapEndpointToFolder(entryEndpoint?: string): string {
  const ep = String(entryEndpoint || '').toLowerCase();
  if (ep.includes('/v1/responses')) return 'openai-responses';
  if (ep.includes('/v1/messages') || ep.includes('/anthropic')) return 'anthropic-messages';
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
  if (!isSnapshotsEnabled()) return; // default OFF
  try {
    // Prefer system hooks managed snapshot (unified with other modules)
    const importCore = async (subpath: string) => {
      try {
        const pathMod = await import('path');
        const { fileURLToPath, pathToFileURL } = await import('url');
        const __filename = fileURLToPath(import.meta.url);
        const __dirname = pathMod.dirname(__filename);
        const vendor = pathMod.resolve(__dirname, '..', 'vendor', 'rcc-llmswitch-core', 'dist');
        const full = pathMod.join(vendor, subpath.replace(/\.js$/i,'') + '.js');
        return await import(pathToFileURL(full).href);
      } catch {
        return await import('rcc-llmswitch-core/' + subpath.replace(/\\/g,'/').replace(/\.js$/i,''));
      }
    };
    const hooks = await importCore('v2/hooks/hooks-integration');
    const endpoint = options.entryEndpoint || '/v1/chat/completions';
    await (hooks as any).writeSnapshotViaHooks({
      endpoint,
      stage: String(options.phase),
      requestId: options.requestId,
      data: options.data,
      verbosity: 'verbose'
    });
  } catch {
    // Fallback: write to local files (non-blocking)
    try {
      const base = path.join(os.homedir(), '.routecodex', 'codex-samples');
      const folder = mapEndpointToFolder(options.entryEndpoint);
      const dir = path.join(base, folder);
      await ensureDir(dir);
      const file = path.join(dir, `${options.requestId}_${String(options.phase).replace(/[^a-z0-9_.-]/gi,'_')}.json`);
      const payload = {
        meta: {
          stage: options.phase,
          version: String(process.env.ROUTECODEX_VERSION || 'dev'),
          buildTime: String(process.env.ROUTECODEX_BUILD_TIME || new Date().toISOString())
        },
        data: options.data
      };
      await fsp.writeFile(file, JSON.stringify(payload, null, 2), 'utf-8');
    } catch { /* ignore fs errors */ }
  }
}
