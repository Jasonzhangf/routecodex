import { resolveRccPath } from '../../runtime/user-data-paths.js';

export type Unknown = Record<string, unknown>;

export interface ToolGovernanceOptions {
  injectGuidance?: boolean;
  snapshot?: {
    enabled?: boolean;
    endpoint?: string;
    requestId?: string;
    baseDir?: string;
  };
}

export function logToolGovernorNonBlocking(stage: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error ?? 'unknown');
  // eslint-disable-next-line no-console
  console.warn(`[tool-governor][non-blocking] stage=${stage} error=${message}`);
}

export function tryWriteSnapshot(options: ToolGovernanceOptions | undefined, stage: string, data: Unknown): void {
  try {
    const envLevel = String(process.env.RCC_HOOKS_VERBOSITY || process.env.ROUTECODEX_HOOKS_VERBOSITY || '').toLowerCase();
    const isVerbose = envLevel === 'verbose';
    if (!isVerbose) return;
    const snap = options?.snapshot;
    if (!snap || snap.enabled === false) return;
    const fs = require('fs');
    const path = require('path');
    const base = snap.baseDir || resolveRccPath('codex-samples');
    const ep = String(snap.endpoint || 'chat').toLowerCase();
    const group = ep.includes('responses') ? 'openai-responses' : ep.includes('messages') ? 'anthropic-messages' : 'openai-chat';
    const rid = String(snap.requestId || `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
    const dir = path.join(base, group, rid);
    const file = path.join(dir, `govern-${stage}.json`);
    if (fs.existsSync(file)) return;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf-8');
  } catch (error) {
    logToolGovernorNonBlocking(`snapshot_write:${stage}`, error);
  }
}
