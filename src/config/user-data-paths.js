import path from 'node:path';
import { homedir } from 'node:os';
const PRIMARY_DIR_NAME = '.rcc';
const LEGACY_DIR_NAME = '.routecodex';
const USER_DIR_ENV_KEYS = ['RCC_HOME', 'ROUTECODEX_USER_DIR', 'ROUTECODEX_HOME'];
const SNAPSHOT_DIR_ENV_KEYS = ['RCC_SNAPSHOT_DIR', 'ROUTECODEX_SNAPSHOT_DIR'];
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
    precommand: 'precommand',
    runtimeLifecycle: 'state/runtime-lifecycle',
    run: 'run',
    tokenStats: 'state/token-manager'
};
function resolveHomeDir(homeDir) {
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
function expandHome(value, homeDir) {
    if (!value.startsWith('~/')) {
        return value;
    }
    return path.join(resolveHomeDir(homeDir), value.slice(2));
}
function isLegacyUserDirPath(value, homeDir) {
    const normalized = path.resolve(expandHome(value, homeDir));
    const legacy = resolveLegacyRouteCodexUserDir(homeDir);
    return normalized === legacy;
}
function resolveLegacySnapshotsDir(homeDir) {
    return path.join(resolveLegacyRouteCodexUserDir(homeDir), RCC_SUBDIRS.snapshots);
}
function isLegacySnapshotsDirPath(value, homeDir) {
    const normalized = path.resolve(expandHome(value, homeDir));
    const legacy = resolveLegacySnapshotsDir(homeDir);
    return normalized === legacy;
}
export function resolveRccUserDir(homeDir) {
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
export function resolveLegacyRouteCodexUserDir(homeDir) {
    return path.join(resolveHomeDir(homeDir), LEGACY_DIR_NAME);
}
export function resolveRccUserDirForRead(homeDir) {
    return resolveRccUserDir(homeDir);
}
export function resolveRccPath(...segments) {
    return path.join(resolveRccUserDir(), ...segments);
}
export function resolveLegacyRouteCodexPath(...segments) {
    return path.join(resolveLegacyRouteCodexUserDir(), ...segments);
}
export function resolveRccPathForRead(...segments) {
    return resolveRccPath(...segments);
}
export function resolveRccSubdir(key, homeDir) {
    return path.join(resolveRccUserDir(homeDir), RCC_SUBDIRS[key]);
}
export function resolveRccSubdirForRead(key, homeDir) {
    return resolveRccSubdir(key, homeDir);
}
export function resolveRccAuthDir(homeDir) {
    return resolveRccSubdir('auth', homeDir);
}
export function resolveRccAuthDirForRead(homeDir) {
    return resolveRccSubdirForRead('auth', homeDir);
}
export function resolveRccTokensDir(homeDir) {
    return resolveRccSubdir('tokens', homeDir);
}
export function resolveRccTokensDirForRead(homeDir) {
    return resolveRccSubdirForRead('tokens', homeDir);
}
export function resolveRccQuotaDir(homeDir) {
    return resolveRccSubdir('quota', homeDir);
}
export function resolveRccQuotaDirForRead(homeDir) {
    return resolveRccSubdirForRead('quota', homeDir);
}
export function resolveRccStateDir(homeDir) {
    return resolveRccSubdir('state', homeDir);
}
export function resolveRccStateDirForRead(homeDir) {
    return resolveRccSubdirForRead('state', homeDir);
}
export function resolveRccLogsDir(homeDir) {
    return resolveRccSubdir('logs', homeDir);
}
export function resolveRccLogsDirForRead(homeDir) {
    return resolveRccSubdirForRead('logs', homeDir);
}
export function resolveRccSessionsDir(homeDir) {
    return resolveRccSubdir('sessions', homeDir);
}
export function resolveRccSessionsDirForRead(homeDir) {
    return resolveRccSubdirForRead('sessions', homeDir);
}
export function resolveRccSnapshotsDir(homeDir) {
    return resolveRccSubdir('snapshots', homeDir);
}
export function resolveRccSnapshotsDirFromEnv(homeDir) {
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
export function resolveRccSnapshotsDirForRead(homeDir) {
    return resolveRccSubdirForRead('snapshots', homeDir);
}
export function resolveRccProviderDir(homeDir) {
    return resolveRccSubdir('provider', homeDir);
}
export function resolveRccProviderDirForRead(homeDir) {
    return resolveRccSubdirForRead('provider', homeDir);
}
export function resolveRccConfigDir(homeDir) {
    return resolveRccSubdir('config', homeDir);
}
export function resolveRccConfigDirForRead(homeDir) {
    return resolveRccSubdirForRead('config', homeDir);
}
export function resolveRccGuardianDir(homeDir) {
    return resolveRccSubdir('guardian', homeDir);
}
export function resolveRccLoginDir(homeDir) {
    return resolveRccSubdir('login', homeDir);
}
export function resolveRccStaticsDir(homeDir) {
    return resolveRccSubdir('statics', homeDir);
}
export function resolveRccErrorsamplesDir(homeDir) {
    return resolveRccSubdir('errorsamples', homeDir);
}
export function resolveRccLlmsShadowDir(homeDir) {
    return resolveRccSubdir('llmsShadow', homeDir);
}
export function resolveRccCamoufoxFingerprintDir(homeDir) {
    return resolveRccSubdir('camoufoxFingerprint', homeDir);
}
export function resolveRccCamoufoxProfilesDir(homeDir) {
    return resolveRccSubdir('camoufoxProfiles', homeDir);
}
export function resolveRccDocsDir(homeDir) {
    return resolveRccSubdir('docs', homeDir);
}
export function resolveRccPrecommandDir(homeDir) {
    return resolveRccSubdir('precommand', homeDir);
}
export function resolveRccRuntimeLifecycleDir(homeDir) {
    return resolveRccSubdir('runtimeLifecycle', homeDir);
}
export function resolveRccRunDir(homeDir) {
    return resolveRccSubdir('run', homeDir);
}
export function resolveRccTokenStatsDir(homeDir) {
    return resolveRccSubdir('tokenStats', homeDir);
}
export function ensureRccUserDirEnvironment(homeDir) {
    const userDir = resolveRccUserDir(homeDir);
    const snapshotsDir = resolveRccSnapshotsDirFromEnv(homeDir);
    const rccHome = String(process.env.RCC_HOME || '').trim();
    if (!rccHome || isLegacyUserDirPath(rccHome, homeDir)) {
        process.env.RCC_HOME = userDir;
    }
    const routeUserDir = String(process.env.ROUTECODEX_USER_DIR || '').trim();
    if (!routeUserDir || isLegacyUserDirPath(routeUserDir, homeDir)) {
        process.env.ROUTECODEX_USER_DIR = userDir;
    }
    const routeHome = String(process.env.ROUTECODEX_HOME || '').trim();
    if (!routeHome || isLegacyUserDirPath(routeHome, homeDir)) {
        process.env.ROUTECODEX_HOME = userDir;
    }
    for (const key of SNAPSHOT_DIR_ENV_KEYS) {
        const raw = String(process.env[key] || '').trim();
        if (!raw || isLegacySnapshotsDirPath(raw, homeDir)) {
            process.env[key] = snapshotsDir;
        }
    }
    return userDir;
}
