import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

function safeStamp() {
  const iso = new Date().toISOString();
  // 2026-01-18T12:34:56.789Z -> 20260118-123456-789Z
  return iso.replace(/[-:]/g, '').replace('T', '-').replace('.', '-');
}

function safeName(name) {
  return String(name || 'sample').replace(/[^\w.-]/g, '_');
}

export async function writeErrorSampleJson({ group, kind, payload }) {
  const root = path.join(os.homedir(), '.routecodex', 'errorsamples');
  const dir = path.join(root, safeName(group));
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${safeName(kind)}-${safeStamp()}-${Math.random().toString(16).slice(2)}.json`);
  await fs.writeFile(file, JSON.stringify(payload, null, 2), 'utf8');
  return file;
}

