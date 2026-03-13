import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  resolveRccUserDir
} from '../../runtime/user-data-paths.js';

type CacheEntry = {
  mtimeMs: number;
  size: number;
  content: string;
};

const cache = new Map<string, CacheEntry>();

function resolveStopMessageBaseDir(): string {
  return path.resolve(resolveRccUserDir());
}

function resolveStopMessageFilePath(raw: string): string | null {
  let text = raw.trim();
  if (!text) return null;

  if (text.startsWith('<') && text.endsWith('>') && text.length >= 3) {
    text = text.slice(1, -1).trim();
  }

  if (!/^file:\/\//i.test(text)) {
    return null;
  }

  const relRaw = text.slice('file://'.length).trim();
  if (!relRaw) {
    throw new Error('stopMessage file://: missing relative path');
  }
  if (relRaw.startsWith('/') || relRaw.startsWith('\\') || /^[a-zA-Z]:[\\/]/.test(relRaw)) {
    throw new Error('stopMessage file://: only supports paths relative to ~/.rcc');
  }

  const normalizedRel = path.posix.normalize(relRaw.replace(/\\/g, '/'));
  if (!normalizedRel || normalizedRel === '.' || normalizedRel === '..' || normalizedRel.startsWith('../')) {
    throw new Error('stopMessage file://: invalid relative path');
  }

  const baseDir = resolveStopMessageBaseDir();
  const abs = path.resolve(baseDir, normalizedRel);
  if (abs !== baseDir && !abs.startsWith(`${baseDir}${path.sep}`)) {
    throw new Error('stopMessage file://: path escapes ~/.rcc');
  }
  return abs;
}

export function isStopMessageFileReference(raw: string): boolean {
  let text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) {
    return false;
  }
  if (text.startsWith('<') && text.endsWith('>') && text.length >= 3) {
    text = text.slice(1, -1).trim();
  }
  return /^file:\/\//i.test(text);
}

export function resolveStopMessageText(raw: string): string {
  const abs = resolveStopMessageFilePath(raw);
  if (!abs) {
    return raw;
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(abs);
  } catch (err: any) {
    const message = err && typeof err.message === 'string' ? err.message : String(err || 'unknown error');
    throw new Error(`stopMessage file://: cannot stat ${abs}: ${message}`);
  }

  if (!stat.isFile()) {
    throw new Error(`stopMessage file://: not a file: ${abs}`);
  }

  const existing = cache.get(abs);
  if (existing && existing.mtimeMs === stat.mtimeMs && existing.size === stat.size) {
    return existing.content;
  }

  let content: string;
  try {
    content = fs.readFileSync(abs, 'utf8');
  } catch (err: any) {
    const message = err && typeof err.message === 'string' ? err.message : String(err || 'unknown error');
    throw new Error(`stopMessage file://: cannot read ${abs}: ${message}`);
  }

  cache.set(abs, { mtimeMs: stat.mtimeMs, size: stat.size, content });
  return content;
}
