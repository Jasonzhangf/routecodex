import os from 'os';
import path from 'path';
import fsp from 'fs/promises';
import { writeSnapshotViaHooks } from '../../llmswitch/bridge.js';

export interface ConfigSnapshotOptions {
  phase: 'system-parsed' | 'user-parsed' | 'canonical' | 'assembler' | 'merged';
  requestId?: string;
  data: unknown;
  metadata?: Record<string, unknown>;
}

function genId() { return `cfg_${Date.now()}_${Math.random().toString(36).slice(2,10)}`; }

async function writeViaHooks(opts: ConfigSnapshotOptions): Promise<boolean> {
  try {
    const requestId = opts.requestId || genId();
    await writeSnapshotViaHooks('config-core', {
      endpoint: 'config-core',
      stage: `config-${opts.phase}`,
      requestId,
      data: { ...opts.metadata, payload: opts.data },
      verbosity: 'verbose'
    });
    return true;
  } catch {
    return false;
  }
}

export async function writeConfigSnapshot(opts: ConfigSnapshotOptions): Promise<void> {
  const ok = await writeViaHooks(opts);
  if (ok) return;
  try {
    const base = path.join(os.homedir(), '.routecodex', 'codex-samples', 'config-core');
    await fsp.mkdir(base, { recursive: true });
    const requestId = opts.requestId || genId();
    const file = path.join(base, `${requestId}_config-${opts.phase}.json`);
    const payload = { timestamp: new Date().toISOString(), phase: opts.phase, metadata: opts.metadata || {}, data: opts.data };
    await fsp.writeFile(file, JSON.stringify(payload, null, 2), 'utf-8');
  } catch {
    // ignore
  }
}
