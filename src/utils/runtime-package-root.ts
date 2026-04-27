import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const INSTALL_ROOT_ENV_KEYS = [
  'ROUTECODEX_INSTALL_ROOT',
  'RCC_INSTALL_ROOT',
  'ROUTECODEX_BASEDIR',
  'RCC_BASEDIR'
] as const;

function isPackageRoot(candidate: string): boolean {
  return fs.existsSync(path.join(candidate, 'package.json'));
}

function resolveFirstExistingEnvRoot(): string | null {
  for (const key of INSTALL_ROOT_ENV_KEYS) {
    const raw = String(process.env[key] || '').trim();
    if (!raw) {
      continue;
    }
    const resolved = path.resolve(raw);
    if (isPackageRoot(resolved)) {
      return resolved;
    }
  }
  return null;
}

export function resolvePackageRootFromModuleUrl(moduleUrl: string): string {
  const envRoot = resolveFirstExistingEnvRoot();
  if (envRoot) {
    return envRoot;
  }
  let current = path.dirname(fileURLToPath(moduleUrl));
  while (true) {
    if (isPackageRoot(current)) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return path.resolve(path.dirname(fileURLToPath(moduleUrl)), '..');
}

export function resolveRuntimePathFromModuleUrl(moduleUrl: string, ...segments: string[]): string {
  return path.join(resolvePackageRootFromModuleUrl(moduleUrl), ...segments);
}
