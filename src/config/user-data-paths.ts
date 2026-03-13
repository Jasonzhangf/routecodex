import path from 'node:path';
import { homedir } from 'node:os';

const PRIMARY_DIR_NAME = '.rcc';
const LEGACY_DIR_NAME = '.routecodex';
const USER_DIR_ENV_KEYS = ['RCC_HOME', 'ROUTECODEX_USER_DIR', 'ROUTECODEX_HOME'] as const;
export const RCC_SUBDIRS = {
  auth: 'auth',
  tokens: 'tokens',
  quota: 'quota',
  state: 'state',
  logs: 'logs',
  sessions: 'sessions',
  snapshots: 'codex-samples',
  provider: 'provider',
  config: 'config',
  guardian: 'guardian',
  login: 'login',
  statics: 'statics',
  errorsamples: 'errorsamples',
  llmsShadow: 'llms-shadow',
  camoufoxFingerprint: 'camoufox-fp',
  camoufoxProfiles: 'camoufox-profiles',
  docs: 'docs',
  precommand: 'precommand'
} as const;
export type RccSubdirKey = keyof typeof RCC_SUBDIRS;

function resolveHomeDir(homeDir?: string): string {
  const explicit = String(homeDir || '').trim();
  if (explicit) {
    return path.resolve(explicit);
  }
  const envHome = String(process.env.HOME || '').trim();
  if (envHome) {
    return path.resolve(envHome);
  }
  const resolved = homedir();
  return path.resolve(resolved);
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

export function resolveRccUserDirForRead(homeDir?: string): string {
  return resolveRccUserDir(homeDir);
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

export function resolveRccSubdir(key: RccSubdirKey, homeDir?: string): string {
  return path.join(resolveRccUserDir(homeDir), RCC_SUBDIRS[key]);
}

export function resolveRccSubdirForRead(key: RccSubdirKey, homeDir?: string): string {
  return resolveRccSubdir(key, homeDir);
}

export function resolveRccAuthDir(homeDir?: string): string {
  return resolveRccSubdir('auth', homeDir);
}

export function resolveRccAuthDirForRead(homeDir?: string): string {
  return resolveRccSubdirForRead('auth', homeDir);
}

export function resolveRccTokensDir(homeDir?: string): string {
  return resolveRccSubdir('tokens', homeDir);
}

export function resolveRccTokensDirForRead(homeDir?: string): string {
  return resolveRccSubdirForRead('tokens', homeDir);
}

export function resolveRccQuotaDir(homeDir?: string): string {
  return resolveRccSubdir('quota', homeDir);
}

export function resolveRccQuotaDirForRead(homeDir?: string): string {
  return resolveRccSubdirForRead('quota', homeDir);
}

export function resolveRccStateDir(homeDir?: string): string {
  return resolveRccSubdir('state', homeDir);
}

export function resolveRccStateDirForRead(homeDir?: string): string {
  return resolveRccSubdirForRead('state', homeDir);
}

export function resolveRccLogsDir(homeDir?: string): string {
  return resolveRccSubdir('logs', homeDir);
}

export function resolveRccLogsDirForRead(homeDir?: string): string {
  return resolveRccSubdirForRead('logs', homeDir);
}

export function resolveRccSessionsDir(homeDir?: string): string {
  return resolveRccSubdir('sessions', homeDir);
}

export function resolveRccSessionsDirForRead(homeDir?: string): string {
  return resolveRccSubdirForRead('sessions', homeDir);
}

export function resolveRccSnapshotsDir(homeDir?: string): string {
  return resolveRccSubdir('snapshots', homeDir);
}

export function resolveRccSnapshotsDirForRead(homeDir?: string): string {
  return resolveRccSubdirForRead('snapshots', homeDir);
}

export function resolveRccProviderDir(homeDir?: string): string {
  return resolveRccSubdir('provider', homeDir);
}

export function resolveRccProviderDirForRead(homeDir?: string): string {
  return resolveRccSubdirForRead('provider', homeDir);
}

export function resolveRccConfigDir(homeDir?: string): string {
  return resolveRccSubdir('config', homeDir);
}

export function resolveRccConfigDirForRead(homeDir?: string): string {
  return resolveRccSubdirForRead('config', homeDir);
}

export function resolveRccGuardianDir(homeDir?: string): string {
  return resolveRccSubdir('guardian', homeDir);
}

export function resolveRccLoginDir(homeDir?: string): string {
  return resolveRccSubdir('login', homeDir);
}

export function resolveRccStaticsDir(homeDir?: string): string {
  return resolveRccSubdir('statics', homeDir);
}

export function resolveRccErrorsamplesDir(homeDir?: string): string {
  return resolveRccSubdir('errorsamples', homeDir);
}

export function resolveRccLlmsShadowDir(homeDir?: string): string {
  return resolveRccSubdir('llmsShadow', homeDir);
}

export function resolveRccCamoufoxFingerprintDir(homeDir?: string): string {
  return resolveRccSubdir('camoufoxFingerprint', homeDir);
}

export function resolveRccCamoufoxProfilesDir(homeDir?: string): string {
  return resolveRccSubdir('camoufoxProfiles', homeDir);
}

export function resolveRccDocsDir(homeDir?: string): string {
  return resolveRccSubdir('docs', homeDir);
}

export function resolveRccPrecommandDir(homeDir?: string): string {
  return resolveRccSubdir('precommand', homeDir);
}

export function resolveRccConfigFile(homeDir?: string): string {
  return path.join(resolveRccUserDir(homeDir), 'config.json');
}

export function resolveRccConfigFileForRead(homeDir?: string): string {
  return resolveRccConfigFile(homeDir);
}

export function ensureRccUserDirEnvironment(homeDir?: string): string {
  const userDir = resolveRccUserDir(homeDir);
  if (!String(process.env.RCC_HOME || '').trim()) {
    process.env.RCC_HOME = userDir;
  }
  if (!String(process.env.ROUTECODEX_USER_DIR || '').trim()) {
    process.env.ROUTECODEX_USER_DIR = userDir;
  }
  if (!String(process.env.ROUTECODEX_HOME || '').trim()) {
    process.env.ROUTECODEX_HOME = userDir;
  }
  return userDir;
}
