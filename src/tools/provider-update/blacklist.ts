import fs from 'fs';
import path from 'path';
import type { BlacklistFile } from './types.js';

export function readBlacklist(file: string): BlacklistFile {
  try {
    if (fs.existsSync(file)) {
      const txt = fs.readFileSync(file, 'utf-8');
      const j = JSON.parse(txt);
      const models = Array.isArray(j?.models) ? j.models.map((x: any) => String(x)) : [];
      return { models, updatedAt: Number(j?.updatedAt || Date.now()) };
    }
  } catch { /* ignore */ }
  return { models: [], updatedAt: Date.now() };
}

export function writeBlacklist(file: string, data: BlacklistFile): void {
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); } catch { /* ignore */ }
  const out: BlacklistFile = { models: Array.from(new Set(data.models)).sort(), updatedAt: Date.now() };
  fs.writeFileSync(file, JSON.stringify(out, null, 2), 'utf-8');
}
