import os from 'node:os';
import path from 'node:path';

const PRIMARY_DIR_NAME = '.rcc';
const LEGACY_DIR_NAME = '.routecodex';
const USER_DIR_ENV_KEYS = ['RCC_HOME', 'ROUTECODEX_USER_DIR', 'ROUTECODEX_HOME'] as const;

function resolveHomeDir(homeDir?: string): string {
  const explicit = String(homeDir || '').trim();
  if (explicit) {
    return path.resolve(explicit);
  }
  const envHome = String(process.env.HOME || '').trim();
  if (envHome) {
    return path.resolve(envHome);
  }
  return path.resolve(os.homedir());
}

function expandHome(value: string, homeDir?: string): string {
  if (!value.startsWith('~/')) {
    return value;
  }
  return path.join(resolveHomeDir(homeDir), value.slice(2));
}

export function resolveRccUserDir(homeDir?: string): string {
  for (const key of USER_DIR_ENV_KEYS) {
    const raw = String(process.env[key] || '').trim();
    if (raw) {
      return path.resolve(expandHome(raw, homeDir));
    }
  }
  return path.join(resolveHomeDir(homeDir), PRIMARY_DIR_NAME);
}

export function resolveLegacyRouteCodexUserDir(homeDir?: string): string {
  return path.join(resolveHomeDir(homeDir), LEGACY_DIR_NAME);
}

export function resolveRccPath(...segments: string[]): string {
  return path.join(resolveRccUserDir(), ...segments);
}

export function resolveLegacyRouteCodexPath(...segments: string[]): string {
  return path.join(resolveLegacyRouteCodexUserDir(), ...segments);
}

export function resolveRccPathForRead(...segments: string[]): string {
  return resolveRccPath(...segments);
}
