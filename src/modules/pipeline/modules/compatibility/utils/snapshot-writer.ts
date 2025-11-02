import fsp from 'fs/promises';
import os from 'os';
import path from 'path';

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
    const base = path.join(os.homedir(), '.routecodex', 'codex-samples');
    const folder = mapEndpointToFolder(options.entryEndpoint);
    const dir = path.join(base, folder);
    await ensureDir(dir);
    const file = path.join(dir, `${options.requestId}_${options.phase}.json`);
    const payload = typeof options.data === 'string' ? options.data : JSON.stringify(options.data, null, 2);
    await fsp.writeFile(file, payload, 'utf-8');
  } catch {
    // snapshot is non-blocking; ignore any fs errors
  }
}

