// Common utility helpers for repo scripts
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import url from 'node:url';

export function dirnameFromMeta(metaUrl) {
  return path.dirname(url.fileURLToPath(metaUrl));
}

export function repoRootFrom(metaUrl) {
  return path.resolve(dirnameFromMeta(metaUrl), '..');
}

export function resolveFromRepo(metaUrl, p) {
  const root = repoRootFrom(metaUrl);
  if (!p) return root;
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return path.isAbsolute(p) ? p : path.join(root, p);
}

export function readJSON(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

export function writeJSON(filePath, data) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

export async function importModulePreferSrc(metaUrl, relJs, relTs) {
  const root = repoRootFrom(metaUrl);
  // Prefer src (when running via tsx), fallback to dist
  try {
    const p = path.join(root, 'src', relTs);
    const href = url.pathToFileURL(p).href;
    return await import(href);
  } catch {
    const p = path.join(root, 'dist', relJs);
    const href = url.pathToFileURL(p).href;
    return await import(href);
  }
}

export function listFiles(dir, { prefix, suffix } = {}) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter(f => (prefix ? f.startsWith(prefix) : true) && (suffix ? f.endsWith(suffix) : true))
    .map(f => path.join(dir, f))
    .sort();
}

export function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

