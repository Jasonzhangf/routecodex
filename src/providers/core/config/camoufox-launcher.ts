import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { logOAuthDebug } from '../../auth/oauth-logger.js';

export interface CamoufoxLaunchOptions {
  url: string;
  provider?: string | null;
  alias?: string | null;
  profileId?: string;
}

type LaunchHandle = {
  child: ChildProcess;
};

const activeLaunchers: Set<LaunchHandle> = new Set();

function registerLauncher(child: ChildProcess): void {
  const handle: LaunchHandle = { child };
  activeLaunchers.add(handle);
  child.once('exit', () => {
    activeLaunchers.delete(handle);
  });
}

function terminateLauncher(handle: LaunchHandle): Promise<void> {
  return new Promise((resolve) => {
    const { child } = handle;
    const onExit = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore escalation failures
      }
      resolve();
    }, 2000);
    if (typeof timer.unref === 'function') {
      timer.unref();
    }
    child.once('exit', onExit);
    try {
      if (child.exitCode !== null || child.killed) {
        clearTimeout(timer);
        resolve();
        return;
      }
      child.kill('SIGTERM');
    } catch {
      clearTimeout(timer);
      resolve();
    }
  });
}

export async function shutdownCamoufoxLaunchers(): Promise<void> {
  if (activeLaunchers.size === 0) {
    return;
  }
  const launchers = Array.from(activeLaunchers);
  await Promise.allSettled(launchers.map((handle) => terminateLauncher(handle)));
  activeLaunchers.clear();
}

function expandHome(p: string): string {
  if (!p) {
    return p;
  }
  if (p.startsWith('~/')) {
    const home = process.env.HOME || '';
    return path.join(home, p.slice(2));
  }
  return p;
}

function getProviderFamily(provider?: string | null): string {
  const rawProvider = provider && provider.trim() ? provider.trim().toLowerCase() : '';

  // Gemini CLI 家族（gemini-cli / antigravity）共享同一组账号指纹：
  // 同一个 alias（例如 geetasamodgeetasamoda）在 gemini-cli 和 antigravity 下使用同一个 profile。
  if (rawProvider === 'gemini-cli' || rawProvider === 'antigravity') {
    return 'gemini';
  }

  return rawProvider;
}

function buildProfileId(provider?: string | null, alias?: string | null): string {
  const parts: string[] = [];
  const rawProvider = getProviderFamily(provider);
  const rawAlias = alias && alias.trim() ? alias.trim().toLowerCase() : '';
  const providerFamily = rawProvider;

  if (providerFamily && providerFamily.length > 0) {
    parts.push(providerFamily);
  }
  if (rawAlias) {
    parts.push(rawAlias);
  }
  const base = parts.length > 0 ? parts.join('.') : 'default';
  const normalized = base.replace(/[^a-z0-9._-]+/gi, '-');
  const prefixed = `rc-${normalized}`;
  return prefixed.length > 64 ? prefixed.slice(0, 64) : prefixed;
}

function getProfileRoot(): string {
  const home = process.env.HOME || os.homedir();
  return path.join(home, '.routecodex', 'camoufox-profiles');
}

export function getCamoufoxProfileDir(provider?: string | null, alias?: string | null): string {
  const profileId = buildProfileId(provider, alias);
  const root = getProfileRoot();
  return path.join(root, profileId);
}

export function ensureCamoufoxProfileDir(provider?: string | null, alias?: string | null): string {
  const dir = getCamoufoxProfileDir(provider, alias);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    // directory creation failures are non-fatal for OAuth; browser can still run with its own defaults
  }
  return dir;
}

function getFingerprintRoot(): string {
  const home = process.env.HOME || os.homedir();
  return path.join(home, '.routecodex', 'camoufox-fp');
}

function getFingerprintPath(profileId: string): string {
  return path.join(getFingerprintRoot(), `${profileId}.json`);
}

function resolveCamoufoxScriptPath(): string | null {
  const raw = (process.env.ROUTECODEX_CAMOUFOX_SCRIPT || '').trim();
  if (raw) {
    const expanded = expandHome(raw);
    try {
      if (fs.existsSync(expanded)) {
        const resolved = path.resolve(expanded);
        logOAuthDebug(`[OAuth] Camoufox: using script override ${resolved}`);
        return resolved;
      }
    } catch {
      // ignore resolution errors for explicit override
    }
  }

  // Fallback: use built-in launcher script shipped with routecodex
  try {
    const here = fileURLToPath(import.meta.url);
    const baseDir = path.dirname(here);
    // BaseDir is usually: <pkgRoot>/dist/providers/core/config
    const candidates = [
      // When packaged, automation scripts are copied to dist/scripts/camoufox.
      path.resolve(baseDir, '../../../scripts/camoufox/launch-auth.mjs'),
      // During local dev we fallback to the source scripts directory.
      path.resolve(baseDir, '../../../../scripts/camoufox/launch-auth.mjs')
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        logOAuthDebug(`[OAuth] Camoufox: using built-in launcher ${candidate}`);
        return candidate;
      }
    }
  } catch {
    // ignore
  }

  return null;
}

function resolveGenFingerprintScriptPath(): string | null {
  try {
    const here = fileURLToPath(import.meta.url);
    const baseDir = path.dirname(here);
    const candidates = [
      path.resolve(baseDir, '../../../scripts/camoufox/gen-fingerprint-env.py'),
      path.resolve(baseDir, '../../../../scripts/camoufox/gen-fingerprint-env.py')
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        logOAuthDebug(`[OAuth] Camoufox: using fingerprint generator ${candidate}`);
        return candidate;
      }
    }
  } catch {
    // ignore
  }
  return null;
}

function computeOsPolicy(provider?: string | null, alias?: string | null): string | undefined {
  const family = getProviderFamily(provider);
  const effectiveAlias = alias && alias.trim() ? alias.trim().toLowerCase() : 'default';

  if (!family) {
    return undefined;
  }

  // 根据 (family, alias) 生成稳定的 OS 选择：
  //   - 同一个 alias 始终映射到同一个 OS
  //   - 不同 alias 在 windows/macos/linux 之间分布
  const seed = `${family}:${effectiveAlias}`;
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    const ch = seed.charCodeAt(i);
    hash = (hash * 31 + ch) >>> 0;
  }
  const idx = hash % 3;
  if (idx === 0) {return 'windows';}
  if (idx === 1) {return 'macos';}
  return 'linux';
}

function loadFingerprintEnv(profileId: string): Record<string, string> | null {
  const fpPath = getFingerprintPath(profileId);
  try {
    const raw = fs.readFileSync(fpPath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && parsed.env && typeof parsed.env === 'object') {
      const env: Record<string, string> = {};
      for (const [key, value] of Object.entries(parsed.env as Record<string, unknown>)) {
        if (typeof key === 'string' && typeof value === 'string') {
          env[key] = value;
        }
      }
      return env;
    }
  } catch {
    // Missing or invalid file – caller will re-generate.
  }
  return null;
}

function ensureFingerprintEnv(profileId: string, provider?: string | null, alias?: string | null): Record<string, string> {
  // If we already have a cached fingerprint env for this profile, reuse it.
  const existing = loadFingerprintEnv(profileId);
  if (existing) {
    return existing;
  }

  const scriptPath = resolveGenFingerprintScriptPath();
  if (!scriptPath) {
    logOAuthDebug('[OAuth] Camoufox: fingerprint generator script not found; falling back to default fingerprint');
    return {};
  }

  const osPolicy = computeOsPolicy(provider, alias);
  const fpRoot = getFingerprintRoot();
  try {
    fs.mkdirSync(fpRoot, { recursive: true });
  } catch {
    // non-fatal
  }

  const args = [scriptPath, '--profile-id', profileId, '--output-dir', fpRoot];
  if (osPolicy) {
    args.push('--os', osPolicy);
  }

  logOAuthDebug(
    `[OAuth] Camoufox: generating fingerprint env profileId=${profileId} os=${osPolicy || 'default'} script=${scriptPath}`
  );

  const result = spawnSync('python3', args, {
    stdio: 'ignore'
  });

  if (result.error) {
    logOAuthDebug(
      `[OAuth] Camoufox: fingerprint generator failed - ${result.error instanceof Error ? result.error.message : String(
        result.error
      )}`
    );
    return {};
  }

  const env = loadFingerprintEnv(profileId);
  if (!env) {
    logOAuthDebug('[OAuth] Camoufox: fingerprint env file not created; falling back to default fingerprint');
    return {};
  }

  return env;
}

/**
 * Ensure that a Camoufox fingerprint env exists for the given token (provider + alias).
 * This is a lightweight wrapper used by the token daemon to pre-generate fingerprints
 * for existing browser profiles.
 */
export function ensureCamoufoxFingerprintForToken(
  provider?: string | null,
  alias?: string | null
): void {
  const profileId = buildProfileId(provider, alias);
  try {
    void ensureFingerprintEnv(profileId, provider, alias);
  } catch {
    // fingerprint generation failures are non-fatal for token scanning
  }
}

export async function openAuthInCamoufox(options: CamoufoxLaunchOptions): Promise<boolean> {
  logOAuthDebug(
    `[OAuth] Camoufox: launch requested url=${options.url} provider=${options.provider ?? ''} alias=${options.alias ?? ''
    }`
  );
  const scriptPath = resolveCamoufoxScriptPath();
  if (!scriptPath) {
    logOAuthDebug('[OAuth] Camoufox: launcher script not resolved; falling back to default browser');
    return false;
  }

  const url = options.url;
  if (!url || typeof url !== 'string') {
    logOAuthDebug('[OAuth] Camoufox: invalid or empty URL; falling back to default browser');
    return false;
  }

  const profileId = options.profileId && options.profileId.trim().length > 0
    ? options.profileId.trim()
    : buildProfileId(options.provider, options.alias);

  // Ensure profile directory exists ahead of launch so that fingerprint/profile data can be persisted per token.
  ensureCamoufoxProfileDir(options.provider, options.alias);

  const fingerprintEnv = ensureFingerprintEnv(profileId, options.provider, options.alias);

  try {
    logOAuthDebug(`[OAuth] Camoufox: spawning launcher script=${scriptPath} profileId=${profileId}`);
    const autoMode = (process.env.ROUTECODEX_CAMOUFOX_AUTO_MODE || '').trim();
    const args = [scriptPath, '--profile', profileId, '--url', url];
    if (autoMode) {
      args.push('--auto-mode', autoMode);
    }
    const child = spawn(process.execPath, args, {
      detached: false,
      stdio: 'inherit',
      env: {
        ...process.env,
        ...fingerprintEnv,
        BROWSER_PROFILE_ID: profileId,
        BROWSER_INITIAL_URL: url
      }
    });
    registerLauncher(child);

    // If the launcher exits immediately with a non-zero code (missing python/camoufox/etc),
    // report failure so the caller can fall back to the system browser.
    const quickCheckMs = 800;
    const ok = await new Promise<boolean>((resolve) => {
      let settled = false;
      const settle = (value: boolean) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => settle(true), quickCheckMs);
      if (typeof timer.unref === 'function') {
        timer.unref();
      }
      child.once('error', () => settle(false));
      child.once('exit', (code) => {
        if (typeof code === 'number' && code !== 0) {
          settle(false);
        } else {
          settle(true);
        }
      });
    });

    // Do not keep the parent process alive solely for the launcher; interactive flows
    // will keep running due to the callback server anyway. Cleanup will terminate it.
    child.unref();
    return ok;
  } catch (error) {
    logOAuthDebug(
      `[OAuth] Camoufox: failed to spawn launcher - ${error instanceof Error ? error.message : String(error)}`
    );
    return false;
  }
}
