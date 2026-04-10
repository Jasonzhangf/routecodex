import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export async function collectSSEText(readable) {
  const decoder = new TextDecoder();
  const reader = readable.getReader();
  let buf = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value);
  }
  return buf;
}

export async function saveUnderCodexSamples(subdir, baseName, content) {
  const dir = path.join(os.homedir(), '.routecodex', 'codex-samples', subdir);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, baseName);
  await fs.writeFile(file, content, 'utf-8');
  return file;
}

export function makeReqBase(prefix) {
  const ts = Date.now();
  const rand = Math.random().toString(36).slice(2, 11);
  return `req_${ts}_${rand}_${prefix}`;
}

