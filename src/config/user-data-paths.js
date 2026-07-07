import path from 'node:path';
import { homedir } from 'node:os';
import { resolveRccPathNativeSync, resolveRccUserDirNativeSync } from '../modules/llmswitch/bridge/routing-integrations.js';
const LEGACY_DIR_NAME = '.routecodex';
const SNAPSHOT_DIR_ENV_KEYS = ['RCC_SNAPSHOT_DIR', 'ROUTECODEX_SNAPSHOT_DIR'];
export const RCC_SUBDIRS = {
    auth: 'auth',
    tokens: 'tokens',
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
    docs: 'docs',
    precommand: 'precommand',
    runtimeLifecycle: 'state/runtime-lifecycle',
    run: 'run'
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
function resolveRetiredSnapshotsDir(homeDir) {
    return path.join(resolveRetiredRouteCodexUserDir(homeDir), RCC_SUBDIRS.snapshots);
}
function isRetiredSnapshotsDirPath(value, homeDir) {
    const normalized = path.resolve(expandHome(value, homeDir));
    const retired = resolveRetiredSnapshotsDir(homeDir);
    return normalized === retired;
}
function assertNotRetiredSnapshotsDirEnv(key, raw, homeDir) {
    if (isRetiredSnapshotsDirPath(raw, homeDir)) {
        throw new Error(`[config] ${key} points to retired ~/.routecodex/codex-samples root; use ~/.rcc/codex-samples`);
    }
}
export function resolveRccUserDir(homeDir) {
    return resolveRccUserDirNativeSync(homeDir);
}
function resolveRetiredRouteCodexUserDir(homeDir) {
    return path.join(resolveHomeDir(homeDir), LEGACY_DIR_NAME);
}
export function resolveRccPath(...segments) {
    return resolveRccPathNativeSync(segments);
}
export function resolveRccSubdir(key, homeDir) {
    return resolveRccPathNativeSync([RCC_SUBDIRS[key]], homeDir);
}
export function resolveRccAuthDir(homeDir) {
    return resolveRccSubdir('auth', homeDir);
}
export function resolveRccTokensDir(homeDir) {
    return resolveRccSubdir('tokens', homeDir);
}
export function resolveRccStateDir(homeDir) {
    return resolveRccSubdir('state', homeDir);
}
export function resolveRccLogsDir(homeDir) {
    return resolveRccSubdir('logs', homeDir);
}
export function resolveRccSessionsDir(homeDir) {
    return resolveRccSubdir('sessions', homeDir);
}
export function resolveRccSnapshotsDir(homeDir) {
    return resolveRccSubdir('snapshots', homeDir);
}
export function resolveRccSnapshotsDirFromEnv(homeDir) {
    for (const key of SNAPSHOT_DIR_ENV_KEYS) {
        const raw = String(process.env[key] || '').trim();
        if (raw) {
            const candidate = path.resolve(expandHome(raw, homeDir));
            assertNotRetiredSnapshotsDirEnv(key, candidate, homeDir);
            return candidate;
        }
    }
    return resolveRccSnapshotsDir(homeDir);
}
export function resolveRccProviderDir(homeDir) {
    return resolveRccSubdir('provider', homeDir);
}
export function resolveRccConfigDir(homeDir) {
    return resolveRccSubdir('config', homeDir);
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
export function ensureRccUserDirEnvironment(homeDir) {
    const userDir = resolveRccUserDir(homeDir);
    const snapshotsDir = resolveRccSnapshotsDirFromEnv(homeDir);
    const rccHome = String(process.env.RCC_HOME || '').trim();
    if (!rccHome) {
        process.env.RCC_HOME = userDir;
    }
    const routeUserDir = String(process.env.ROUTECODEX_USER_DIR || '').trim();
    if (!routeUserDir) {
        process.env.ROUTECODEX_USER_DIR = userDir;
    }
    const routeHome = String(process.env.ROUTECODEX_HOME || '').trim();
    if (!routeHome) {
        process.env.ROUTECODEX_HOME = userDir;
    }
    for (const key of SNAPSHOT_DIR_ENV_KEYS) {
        const raw = String(process.env[key] || '').trim();
        if (raw) {
            assertNotRetiredSnapshotsDirEnv(key, raw, homeDir);
        }
        else {
            process.env[key] = snapshotsDir;
        }
    }
    return userDir;
}
