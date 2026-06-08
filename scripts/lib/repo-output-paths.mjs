import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = path.resolve(SCRIPT_DIR, '..', '..');

export function resolveRepoRoot(explicitRoot = process.cwd()) {
  return path.resolve(explicitRoot || DEFAULT_REPO_ROOT);
}

export function resolveRepoGeneratedPath(repoRoot, ...segments) {
  const root = resolveRepoRoot(repoRoot);
  return path.join(root, ...segments);
}

export function ensureRepoPackOutputDir(repoRoot = process.cwd(), ...segments) {
  const dir = resolveRepoGeneratedPath(repoRoot, 'artifacts', 'pack', ...segments);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
