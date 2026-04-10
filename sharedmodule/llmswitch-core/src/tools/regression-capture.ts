import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveRccPath } from '../runtime/user-data-paths.js';

type RegressionPayload = Record<string, unknown>;

function resolveErrorsamplesRoot(): string {
  const envOverride =
    process.env.ROUTECODEX_ERRORSAMPLES_DIR ||
    process.env.RCC_ERRORSAMPLES_DIR ||
    process.env.ROUTECODEX_ERROR_SAMPLES_DIR;
  if (typeof envOverride === 'string' && envOverride.trim().length > 0) {
    return path.resolve(envOverride.trim());
  }
  return resolveRccPath('errorsamples');
}

function safeName(value: string): string {
  const normalized = String(value || '').trim();
  return normalized.replace(/[^\w.-]/g, '_') || 'sample';
}

function safeTimestamp(): string {
  return new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').replace('.', '-');
}

export function captureRegressionSample(group: string, kind: string, payload: RegressionPayload): void {
  const record = {
    timestamp: new Date().toISOString(),
    ...payload
  };

  void (async () => {
    try {
      const root = resolveErrorsamplesRoot();
      const dir = path.join(root, safeName(group));
      await fs.mkdir(dir, { recursive: true });
      const file = path.join(
        dir,
        `${safeName(kind)}-${safeTimestamp()}-${Math.random().toString(16).slice(2)}.json`
      );
      await fs.writeFile(file, JSON.stringify(record, null, 2), 'utf8');
    } catch {
      // best-effort only
    }
  })();
}
