import os from 'node:os';
import path from 'node:path';

const PRIMARY_DIR_NAME = '.rcc';
const LEGACY_DIR_NAME = '.routecodex';
const USER_DIR_ENV_KEYS = ['RCC_HOME', 'ROUTECODEX_USER_DIR', 'ROUTECODEX_HOME'] as const;
const SNAPSHOT_DIR_NAME = 'codex-samples';
const SNAPSHOT_DIR_ENV_KEYS = ['RCC_SNAPSHOT_DIR', 'ROUTECODEX_SNAPSHOT_DIR'] as const;

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

function isLegacyUserDirPath(value: string, homeDir?: string): boolean {
  const normalized = path.resolve(expandHome(value, homeDir));
  const legacy = resolveLegacyRouteCodexUserDir(homeDir);
  return normalized === legacy;
}

function resolveLegacySnapshotsDir(homeDir?: string): string {
  return path.join(resolveLegacyRouteCodexUserDir(homeDir), SNAPSHOT_DIR_NAME);
}

function isLegacySnapshotsDirPath(value: string, homeDir?: string): boolean {
  const normalized = path.resolve(expandHome(value, homeDir));
  const legacy = resolveLegacySnapshotsDir(homeDir);
  return normalized === legacy;
}

export function resolveRccUserDir(homeDir?: string): string {
  for (const key of USER_DIR_ENV_KEYS) {
    const raw = String(process.env[key] || '').trim();
    if (raw) {
      if (isLegacyUserDirPath(raw, homeDir)) {
        continue;
      }
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

export function resolveRccSnapshotsDir(homeDir?: string): string {
  return path.join(resolveRccUserDir(homeDir), SNAPSHOT_DIR_NAME);
}

export function resolveRccSnapshotsDirFromEnv(homeDir?: string): string {
  for (const key of SNAPSHOT_DIR_ENV_KEYS) {
    const raw = String(process.env[key] || '').trim();
    if (raw) {
      const candidate = path.resolve(expandHome(raw, homeDir));
      if (isLegacySnapshotsDirPath(candidate, homeDir)) {
        continue;
      }
      return candidate;
    }
  }
  return resolveRccSnapshotsDir(homeDir);
}

export function resolveRccPathForRead(...segments: string[]): string {
  return resolveRccPath(...segments);
}
