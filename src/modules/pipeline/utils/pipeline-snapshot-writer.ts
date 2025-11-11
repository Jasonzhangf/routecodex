import os from 'os';
import path from 'path';
import fsp from 'fs/promises';

export interface PipelineSnapshotOptions {
  stage: string;                // e.g., pipeline.llmswitch.request.pre
  requestId: string;
  pipelineId: string;
  data: unknown;
  entryEndpoint?: string;
  metadata?: Record<string, unknown>;
}

async function writeViaHooks(opts: PipelineSnapshotOptions): Promise<boolean> {
  try {
    const importCore = async (subpath: string) => {
      try {
        const pathMod = await import('path');
        const { fileURLToPath, pathToFileURL } = await import('url');
        const __filename = fileURLToPath(import.meta.url);
        const __dirname = pathMod.dirname(__filename);
        const vendor = pathMod.resolve(__dirname, '..', '..', '..', '..', 'vendor', 'rcc-llmswitch-core', 'dist');
        const full = pathMod.join(vendor, subpath.replace(/\.js$/i,'') + '.js');
        return await import(pathToFileURL(full).href);
      } catch {
        return await import('rcc-llmswitch-core/' + subpath.replace(/\\/g,'/').replace(/\.js$/i,''));
      }
    };
    const hooks = await importCore('v2/hooks/hooks-integration');
    await (hooks as any).writeSnapshotViaHooks({
      endpoint: opts.entryEndpoint || 'pipeline',
      stage: opts.stage,
      requestId: opts.requestId,
      data: { pipelineId: opts.pipelineId, payload: opts.data, ...(opts.metadata || {}) },
      verbosity: 'verbose'
    });
    return true;
  } catch {
    return false;
  }
}

export async function writePipelineSnapshot(opts: PipelineSnapshotOptions): Promise<void> {
  const ok = await writeViaHooks(opts);
  if (ok) return;
  try {
    const base = path.join(os.homedir(), '.routecodex', 'codex-samples', 'pipeline');
    await fsp.mkdir(base, { recursive: true });
    const safeStage = opts.stage.replace(/[^a-z0-9_.-]+/gi, '-');
    const file = path.join(base, `${opts.requestId}_${safeStage}.json`);
    const payload = {
      timestamp: new Date().toISOString(),
      pipelineId: opts.pipelineId,
      stage: opts.stage,
      endpoint: opts.entryEndpoint || 'pipeline',
      metadata: opts.metadata || {},
      data: opts.data
    };
    await fsp.writeFile(file, JSON.stringify(payload, null, 2), 'utf-8');
  } catch {
    // ignore local fallback errors
  }
}

