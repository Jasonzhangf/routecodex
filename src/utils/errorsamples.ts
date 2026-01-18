import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

function resolveErrorsamplesRoot(): string {
  const envOverride =
    process.env.ROUTECODEX_ERRORSAMPLES_DIR ||
    process.env.ROUTECODEX_ERROR_SAMPLES_DIR;
  if (envOverride && String(envOverride).trim()) {
    return path.resolve(String(envOverride).trim());
  }
  return path.join(os.homedir(), '.routecodex', 'errorsamples');
}

function safeName(name: string): string {
  return String(name || 'sample').replace(/[^\w.-]/g, '_');
}

function safeStamp(): string {
  const iso = new Date().toISOString();
  return iso.replace(/[-:]/g, '').replace('T', '-').replace('.', '-');
}

export async function writeErrorsampleJson(options: {
  group: string;
  kind: string;
  payload: unknown;
}): Promise<string> {
  const root = resolveErrorsamplesRoot();
  const dir = path.join(root, safeName(options.group));
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(
    dir,
    `${safeName(options.kind)}-${safeStamp()}-${Math.random().toString(16).slice(2)}.json`
  );
  await fs.writeFile(file, JSON.stringify(options.payload, null, 2), 'utf8');
  return file;
}

