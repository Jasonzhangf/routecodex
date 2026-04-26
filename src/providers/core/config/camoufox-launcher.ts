import { spawn, spawnSync, type ChildProcess, type SpawnSyncOptions, type SpawnSyncReturns } from 'node:child_process';
import fs from 'node:fs';
import fsAsync from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  resolveRccCamoufoxFingerprintDir,
  resolveRccCamoufoxProfilesDir
} from '../../../config/user-data-paths.js';
import { logOAuthDebug } from '../../auth/oauth-logger.js';
import {
  CAMO_CLICK_TARGETS,
  clickCamoGoogleAccountByHint,
  hasCamoGoogleSignInPrompt,
  clickCamoGoogleSignInBySelector,
  clickCamoTarget,
  ensureCamoProfile,
  getActiveCamoPageUrl,
  gotoCamoUrl,
  startCamoSession,
  setDefaultCamoProfile,
  type CamoActionContext
} from './camoufox-actions.js';

export interface CamoufoxLaunchOptions {
  url: string;
  provider?: string | null;
  alias?: string | null;
  profileId?: string;
}

type LaunchHandle = {
  child: ChildProcess;
};

type PythonLauncher = {
  command: string;
  argsPrefix: string[];
};

type PythonRunResult = {
  launcher: PythonLauncher | null;
  result: SpawnSyncReturns<string | Buffer> | null;
};

const activeLaunchers: Set<LaunchHandle> = new Set();
let lastCamoufoxLaunchFailureReason: string | null = null;

function logCamoufoxLauncherNonBlocking(
  stage: string,
  error: unknown,
  details: Record<string, unknown> = {}
): void {
  const reason = error instanceof Error ? (error.stack || `${error.name}: ${error.message}`) : String(error);
  const detailSuffix = Object.keys(details).length > 0 ? ` details=${JSON.stringify(details)}` : '';
  console.warn(`[camoufox-launcher] ${stage} failed (non-blocking): ${reason}${detailSuffix}`);
}

function setCamoufoxLaunchFailureReason(reason: string | null): void {
  lastCamoufoxLaunchFailureReason = reason && reason.trim().length > 0 ? reason.trim() : null;
}

export function getLastCamoufoxLaunchFailureReason(): string | null {
  return lastCamoufoxLaunchFailureReason;
}

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
      } catch (error) {
        logCamoufoxLauncherNonBlocking('terminate_launcher.sigkill', error);
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
    } catch (error) {
      logCamoufoxLauncherNonBlocking('terminate_launcher.sigterm', error);
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

function resolveGoogleUiLanguage(): string | null {
  const raw = String(
    process.env.ROUTECODEX_OAUTH_GOOGLE_HL ||
      process.env.RCC_OAUTH_GOOGLE_HL ||
      'en'
  )
    .trim();
  if (!raw) {
    return null;
  }
  const lowered = raw.toLowerCase();
  if (lowered === 'auto' || lowered === 'off' || lowered === 'none' || lowered === '0' || lowered === 'false') {
    return null;
  }
  return raw;
}

function normalizeLocaleTag(raw: string): string | null {
  const trimmed = String(raw || '').trim();
  if (!trimmed) {
    return null;
  }
  const normalized = trimmed.replace(/_/g, '-');
  const parts = normalized.split('-').filter(Boolean);
  if (!parts.length) {
    return null;
  }
  const language = parts[0].toLowerCase();
  const region = parts[1] ? parts[1].toUpperCase() : '';
  return region ? `${language}-${region}` : language;
}

function defaultRegionForLanguage(language: string): string {
  const normalized = String(language || '').trim().toLowerCase();
  if (normalized === 'zh') {
    return 'CN';
  }
  if (normalized === 'ja') {
    return 'JP';
  }
  if (normalized === 'ko') {
    return 'KR';
  }
  return 'US';
}

export function resolveCamoufoxLocaleEnv(): Record<string, string> {
  const googleLang = resolveGoogleUiLanguage();
  const localeTag = normalizeLocaleTag(googleLang || 'en');
  if (!localeTag) {
    return {};
  }
  const [languageRaw, regionRaw] = localeTag.split('-');
  const language = (languageRaw || 'en').toLowerCase();
  const region = (regionRaw || defaultRegionForLanguage(language)).toUpperCase();
  const posixLocale = `${language}_${region}.UTF-8`;
  return {
    LANG: posixLocale,
    LC_ALL: posixLocale,
    LANGUAGE: `${language}-${region}`
  };
}

function shouldApplyGoogleLocaleHint(hostnameRaw: string): boolean {
  const hostname = String(hostnameRaw || '').trim().toLowerCase();
  if (!hostname) {
    return false;
  }
  return (
    hostname === 'accounts.google.com' ||
    hostname === 'myaccount.google.com' ||
    hostname === 'support.google.com'
  );
}

export function applyGoogleLocaleHint(rawUrl: string): string {
  if (!rawUrl || typeof rawUrl !== 'string') {
    return rawUrl;
  }
  const lang = resolveGoogleUiLanguage();
  if (!lang) {
    return rawUrl;
  }
  try {
    const parsed = new URL(rawUrl);
    if (!shouldApplyGoogleLocaleHint(parsed.hostname)) {
      return rawUrl;
    }
    parsed.searchParams.set('hl', lang);
    return parsed.toString();
  } catch {
    return rawUrl;
  }
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

function isDisabledFlag(value: string | undefined): boolean {
  const raw = String(value || '').trim().toLowerCase();
  return raw === '0' || raw === 'false' || raw === 'no' || raw === 'off';
}

export function shouldPreferCamoCliForOAuth(provider?: string | null): boolean {
  if (isDisabledFlag(process.env.ROUTECODEX_OAUTH_CAMO_CLI) || isDisabledFlag(process.env.RCC_OAUTH_CAMO_CLI)) {
    return false;
  }
  void provider;
  return true;
}

function resolveCamoCliCommand(): string {
  const configured = String(process.env.ROUTECODEX_CAMO_CLI_PATH || process.env.RCC_CAMO_CLI_PATH || '').trim();
  return configured || 'camo';
}

function runCamoCliCheck(): boolean {
  try {
    const result = spawnSync(resolveCamoCliCommand(), ['--help'], {
      stdio: 'ignore'
    });
    const code = (result.error as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT') {
      return false;
    }
    return result.status === 0;
  } catch (error: unknown) {
    logCamoufoxLauncherNonBlocking('run_camo_cli_check.spawn', error);
    return false;
  }
}

export function shouldRepairCamoufoxFingerprintForOAuth(
  providerFamily: string,
  navigatorPlatform: string,
  hostPlatform: NodeJS.Platform = process.platform
): boolean {
  const family = String(providerFamily || '').trim().toLowerCase();
  const platform = String(navigatorPlatform || '').trim().toLowerCase();
  if (hostPlatform !== 'darwin') {
    return false;
  }
  if (platform !== 'win32') {
    return false;
  }
  return family === 'gemini' || family === 'qwen';
}

export function sanitizeCamouConfigForOAuth(
  provider: string | null | undefined,
  fingerprintEnv: Record<string, string>
): Record<string, string> {
  const env = { ...(fingerprintEnv || {}) };
  const raw = env.CAMOU_CONFIG_1;
  if (!raw || typeof raw !== 'string') {
    return env;
  }
  let parsed: Record<string, unknown> | null = null;
  try {
    const node = JSON.parse(raw);
    if (node && typeof node === 'object' && !Array.isArray(node)) {
      parsed = node as Record<string, unknown>;
    }
  } catch {
    return env;
  }
  if (!parsed) {
    return env;
  }

  return env;
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

const DISABLED_CAMOUFOX_AUTO_MODE = new Set(['0', 'false', 'no', 'off', 'manual', 'none']);
const REMOVED_CAMOUFOX_AUTO_MODE = new Set(['qwen']);

function resolveDefaultCamoufoxAutoMode(provider?: string | null): string {
  const family = getProviderFamily(provider);
  if (family === 'antigravity') {
    return 'antigravity';
  }
  if (family === 'gemini') {
    return 'gemini';
  }
  return '';
}

function resolveEffectiveCamoufoxAutoMode(provider?: string | null): string {
  const raw = String(process.env.ROUTECODEX_CAMOUFOX_AUTO_MODE || '').trim().toLowerCase();
  if (raw) {
    if (DISABLED_CAMOUFOX_AUTO_MODE.has(raw) || REMOVED_CAMOUFOX_AUTO_MODE.has(raw)) {
      return '';
    }
    return raw;
  }
  return resolveDefaultCamoufoxAutoMode(provider);
}

function getProfileRoot(): string {
  return resolveRccCamoufoxProfilesDir();
}

function profileDirExists(profileId: string): boolean {
  const normalized = String(profileId || '').trim();
  if (!normalized) {
    return false;
  }
  try {
    return fs.existsSync(path.join(getProfileRoot(), normalized));
  } catch (error: unknown) {
    logCamoufoxLauncherNonBlocking('profile_dir_exists.stat', error, { profileId: normalized });
    return false;
  }
}

function resolvePreferredOAuthProfileId(
  provider?: string | null,
  alias?: string | null,
  explicitProfileId?: string | null
): string {
  const explicit = String(explicitProfileId || '').trim();
  if (explicit) {
    return explicit;
  }
  const derived = buildProfileId(provider, alias);
  const family = getProviderFamily(provider);
  const normalizedAlias = String(alias || '').trim().toLowerCase();
  if (family === 'qwen' && normalizedAlias) {
    const sharedAuthProfileId = buildProfileId('auth', normalizedAlias);
    if (profileDirExists(sharedAuthProfileId)) {
      return sharedAuthProfileId;
    }
  }
  return derived;
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
  } catch (error) {
    logCamoufoxLauncherNonBlocking('ensure_profile_dir.mkdir', error, { dir });
  }
  return dir;
}

function getFingerprintRoot(): string {
  return resolveRccCamoufoxFingerprintDir();
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
    } catch (error) {
      logCamoufoxLauncherNonBlocking('resolve_script_path.override_probe', error, {
        configured: expanded
      });
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
  } catch (error) {
    logCamoufoxLauncherNonBlocking('resolve_script_path.builtin_probe', error);
  }

  return null;
}

function makeLauncherKey(launcher: PythonLauncher): string {
  return `${launcher.command}\u0000${launcher.argsPrefix.join('\u0000')}`;
}

function pushUniqueLauncher(target: PythonLauncher[], launcher: PythonLauncher): void {
  if (!launcher.command.trim()) {
    return;
  }
  const key = makeLauncherKey(launcher);
  if (target.some((item) => makeLauncherKey(item) === key)) {
    return;
  }
  target.push(launcher);
}

export function resolveCamoufoxPythonLaunchers(
  platform: NodeJS.Platform = process.platform,
  env: Record<string, string | undefined> = process.env
): PythonLauncher[] {
  const launchers: PythonLauncher[] = [];
  const configured = String(env.ROUTECODEX_PYTHON || env.RCC_PYTHON || '').trim();
  if (configured) {
    pushUniqueLauncher(launchers, { command: configured, argsPrefix: [] });
  }
  if (platform === 'win32') {
    pushUniqueLauncher(launchers, { command: 'py', argsPrefix: ['-3'] });
    pushUniqueLauncher(launchers, { command: 'python3', argsPrefix: [] });
    pushUniqueLauncher(launchers, { command: 'python', argsPrefix: [] });
    return launchers;
  }
  pushUniqueLauncher(launchers, { command: 'python3', argsPrefix: [] });
  pushUniqueLauncher(launchers, { command: 'python', argsPrefix: [] });
  return launchers;
}

function runPythonWithLaunchers(
  buildArgs: (launcher: PythonLauncher) => string[],
  options: SpawnSyncOptions
): PythonRunResult {
  const launchers = resolveCamoufoxPythonLaunchers();
  for (const launcher of launchers) {
    try {
      const result = spawnSync(launcher.command, buildArgs(launcher), options);
      const code = (result.error as NodeJS.ErrnoException | undefined)?.code;
      if (code === 'ENOENT') {
        continue;
      }
      return { launcher, result };
    } catch (error) {
      logCamoufoxLauncherNonBlocking('run_python_with_launchers.spawn_sync', error, {
        command: launcher.command
      });
      continue;
    }
  }
  return { launcher: null, result: null };
}

function runCamoufoxPathCheck(): boolean {
  const execution = runPythonWithLaunchers(
    (launcher) => [...launcher.argsPrefix, '-m', 'camoufox', 'path'],
    { stdio: 'ignore' }
  );
  return execution.result?.status === 0;
}

export function isCamoufoxAvailable(): boolean {
  return runCamoCliCheck();
}

function installCamoufox(): boolean {
  const execution = runPythonWithLaunchers(
    (launcher) => [...launcher.argsPrefix, '-m', 'pip', 'install', '--user', '-U', 'camoufox'],
    { stdio: 'inherit' }
  );
  if (!execution.result) {
    return false;
  }
  const launcherPreview = execution.launcher
    ? `${execution.launcher.command} ${execution.launcher.argsPrefix.join(' ')}`.trim()
    : 'python';
  logOAuthDebug(`[OAuth] Camoufox: install attempted via ${launcherPreview}`);
  return execution.result.status === 0;
}

function ensureCamoufoxInstalled(): boolean {
  if (runCamoCliCheck()) {
    return true;
  }
  logOAuthDebug('[OAuth] camo-cli not available');
  return false;
}

export function ensureCamoufoxInstalledForInit(): boolean {
  return ensureCamoufoxInstalled();
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
  } catch (error) {
    logCamoufoxLauncherNonBlocking('resolve_gen_fingerprint_script_path', error);
  }
  return null;
}

function computeOsPolicy(provider?: string | null, alias?: string | null): string | undefined {
  const forced = String(process.env.ROUTECODEX_CAMOUFOX_FORCE_OS || process.env.RCC_CAMOUFOX_FORCE_OS || '')
    .trim()
    .toLowerCase();
  if (forced === 'windows' || forced === 'macos') {
    return forced;
  }
  const family = getProviderFamily(provider);
  const effectiveAlias = alias && alias.trim() ? alias.trim().toLowerCase() : 'default';

  if (!family) {
    return undefined;
  }

  // 根据 (family, alias) 生成稳定的 OS 选择：
  //   - 同一个 alias 始终映射到同一个 OS
  //   - 不同 alias 在 windows/macos 之间分布
  //
  // IMPORTANT: Linux 指纹会导致部分上游 OAuth/风控触发 re-verify（尤其是 Antigravity/Gemini Cloud Code Assist）。
  // 因此这里严格禁止生成 linux 指纹。
  const seed = `${family}:${effectiveAlias}`;
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    const ch = seed.charCodeAt(i);
    hash = (hash * 31 + ch) >>> 0;
  }
  const idx = hash % 2;
  if (idx === 0) {return 'windows';}
  return 'macos';
}

/**
 * Exposed for CLI/tests: report which OS policy will be used for a given (provider, alias).
 * NOTE: This is the policy passed to the fingerprint generator, not necessarily the runtime OS.
 */
export function getCamoufoxOsPolicy(provider?: string | null, alias?: string | null): 'windows' | 'macos' | undefined {
  const osPolicy = computeOsPolicy(provider, alias);
  if (osPolicy === 'windows' || osPolicy === 'macos') {
    return osPolicy;
  }
  return undefined;
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
  } catch (error: unknown) {
    logCamoufoxLauncherNonBlocking('load_fingerprint_env.read_or_parse', error, { fpPath });
  }
  return null;
}

function writeMinimalFingerprintEnv(profileId: string, osPolicy?: string | undefined): Record<string, string> {
  const fpPath = getFingerprintPath(profileId);
  const windows = {
    'navigator.platform': 'Win32',
    'navigator.oscpu': 'Windows NT 10.0; Win64; x64',
    'navigator.appVersion': '5.0 (Windows)',
    'navigator.userAgent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:135.0) Gecko/20100101 Firefox/135.0',
    'timezone': 'America/Los_Angeles',
    'locale:language': 'en',
    'locale:region': 'US',
    'geolocation:latitude': 37.7749,
    'geolocation:longitude': -122.4194
  };
  const macos = {
    'navigator.platform': 'MacIntel',
    'navigator.oscpu': 'Intel Mac OS X 10.15',
    'navigator.appVersion': '5.0 (Macintosh)',
    'navigator.userAgent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:135.0) Gecko/20100101 Firefox/135.0',
    'timezone': 'America/Los_Angeles',
    'locale:language': 'en',
    'locale:region': 'US',
    'geolocation:latitude': 37.7749,
    'geolocation:longitude': -122.4194
  };
  const cfg = osPolicy === 'macos' ? macos : windows;
  const env = { CAMOU_CONFIG_1: JSON.stringify(cfg) };
  // 异步写入，不阻塞启动流程
  void (async () => {
    try {
      await fsAsync.mkdir(path.dirname(fpPath), { recursive: true });
      const payload = { env };
      await fsAsync.writeFile(fpPath, JSON.stringify(payload), { encoding: 'utf-8' });
    } catch (error) {
      logCamoufoxLauncherNonBlocking('write_minimal_fingerprint_env.persist', error, {
        path: fpPath
      });
    }
  })();
  return env;
}

function ensureFingerprintEnv(profileId: string, provider?: string | null, alias?: string | null): Record<string, string> {
  // If we already have a cached fingerprint env for this profile, reuse it.
  const existing = loadFingerprintEnv(profileId);
  if (existing) {
    return existing;
  }

  const scriptPath = resolveGenFingerprintScriptPath();
  if (!scriptPath) {
    logOAuthDebug('[OAuth] Camoufox: fingerprint generator script not found; creating minimal fingerprint env');
    const osPolicy = computeOsPolicy(provider, alias);
    return writeMinimalFingerprintEnv(profileId, osPolicy);
  }

  const osPolicy = computeOsPolicy(provider, alias);
  const fpRoot = getFingerprintRoot();
  try {
    fs.mkdirSync(fpRoot, { recursive: true });
  } catch (error) {
    logCamoufoxLauncherNonBlocking('ensure_fingerprint_env.mkdir', error, {
      root: fpRoot
    });
  }

  const scriptArgs = ['--profile-id', profileId, '--output-dir', fpRoot];
  if (osPolicy) {
    scriptArgs.push('--os', osPolicy);
  }

  logOAuthDebug(
    `[OAuth] Camoufox: generating fingerprint env profileId=${profileId} os=${osPolicy || 'default'} script=${scriptPath}`
  );

  const timeoutMsRaw = String(process.env.ROUTECODEX_CAMOUFOX_FINGERPRINT_TIMEOUT_MS || '').trim();
  const timeoutMs = timeoutMsRaw ? Number(timeoutMsRaw) : NaN;
  const effectiveTimeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.floor(timeoutMs) : 30_000;
  const execution = runPythonWithLaunchers((launcher) => [...launcher.argsPrefix, scriptPath, ...scriptArgs], {
    stdio: 'ignore',
    timeout: effectiveTimeoutMs
  });
  const result = execution.result;

  if (!result) {
    logOAuthDebug('[OAuth] Camoufox: no Python launcher available for fingerprint generation');
    return writeMinimalFingerprintEnv(profileId, osPolicy);
  }
  if (result.error) {
    logOAuthDebug(
      `[OAuth] Camoufox: fingerprint generator failed - ${result.error instanceof Error ? result.error.message : String(
        result.error
      )}`
    );
    return writeMinimalFingerprintEnv(profileId, osPolicy);
  }
  if (result.status !== 0) {
    logOAuthDebug(`[OAuth] Camoufox: fingerprint generator exited with status=${result.status}`);
    return writeMinimalFingerprintEnv(profileId, osPolicy);
  }

  const env = loadFingerprintEnv(profileId);
  if (!env) {
    logOAuthDebug('[OAuth] Camoufox: fingerprint env file not created; falling back to default fingerprint');
    return writeMinimalFingerprintEnv(profileId, osPolicy);
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
  } catch (error) {
    logCamoufoxLauncherNonBlocking('ensure_fingerprint_for_token', error, {
      profileId,
      provider: provider ?? null,
      alias: alias ?? null
    });
  }
}

function isTruthyFlag(value: string | undefined): boolean {
  const raw = String(value || '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

function parsePositiveInt(value: string | undefined, fallbackValue: number): number {
  const parsed = Number.parseInt(String(value || '').trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallbackValue;
}

function isTokenPortalUrl(rawUrl: string): boolean {
  if (!rawUrl || typeof rawUrl !== 'string') {
    return false;
  }
  try {
    const parsed = new URL(rawUrl);
    const pathName = parsed.pathname || '';
    return pathName === '/token-auth/demo' || pathName.startsWith('/token-auth/demo/');
  } catch {
    return rawUrl.includes('/token-auth/demo');
  }
}

function resolvePortalOauthUrl(rawUrl: string): string | null {
  if (!isTokenPortalUrl(rawUrl)) {
    return null;
  }
  try {
    const parsed = new URL(rawUrl);
    const oauthUrl = parsed.searchParams.get('oauthUrl');
    if (!oauthUrl || typeof oauthUrl !== 'string') {
      return null;
    }
    const normalized = oauthUrl.trim();
    return normalized || null;
  } catch (error: unknown) {
    logCamoufoxLauncherNonBlocking('resolve_portal_oauth_url.parse', error, {
      rawUrl: String(rawUrl || '').slice(0, 200)
    });
    return null;
  }
}

async function maybeAdvanceTokenPortal(options: {
  launchUrl: string;
  actionContext: CamoActionContext;
}): Promise<boolean> {
  if (!isTokenPortalUrl(options.launchUrl)) {
    return true;
  }
  const autoMode = String(process.env.ROUTECODEX_CAMOUFOX_AUTO_MODE || '').trim();
  const autoModeEnabled = autoMode.length > 0;
  if (!autoModeEnabled) {
    return true;
  }
  const activeUrl = getActiveCamoPageUrl(options.actionContext);
  if (activeUrl && !isTokenPortalUrl(activeUrl)) {
    logOAuthDebug(`[OAuth] camo-cli portal advance skipped (active page is non-portal): ${activeUrl}`);
    return true;
  }
  if (isTruthyFlag(process.env.ROUTECODEX_CAMOUFOX_OPEN_ONLY) || isTruthyFlag(process.env.RCC_CAMOUFOX_OPEN_ONLY)) {
    logOAuthDebug('[OAuth] camo-cli portal advance skipped (open-only mode)');
    return true;
  }

  const retryCount = parsePositiveInt(
    process.env.ROUTECODEX_CAMOUFOX_PORTAL_CLICK_RETRIES,
    autoModeEnabled ? 8 : 2
  );
  const retryDelayMs = parsePositiveInt(process.env.ROUTECODEX_CAMOUFOX_PORTAL_CLICK_RETRY_DELAY_MS, 350);
  return clickCamoTarget(options.actionContext, CAMO_CLICK_TARGETS.tokenPortalContinue, {
    retries: retryCount,
    retryDelayMs,
    required: autoModeEnabled
  });
}


function isQwenAuthorizeUrl(rawUrl: string): boolean {
  if (!rawUrl || typeof rawUrl !== 'string') {
    return false;
  }
  try {
    const parsed = new URL(rawUrl);
    return /(?:^|\.)chat\.qwen\.ai$/i.test(parsed.hostname) && parsed.pathname.startsWith('/authorize');
  } catch {
    return rawUrl.includes('chat.qwen.ai/authorize');
  }
}

function isQwenLoginUrl(rawUrl: string): boolean {
  if (!rawUrl || typeof rawUrl !== 'string') {
    return false;
  }
  try {
    const parsed = new URL(rawUrl);
    if (!/(?:^|\.)chat\.qwen\.ai$/i.test(parsed.hostname)) {
      return false;
    }
    return parsed.pathname === '/auth' || parsed.pathname.startsWith('/auth/');
  } catch {
    return (
      rawUrl.includes('chat.qwen.ai/auth?') ||
      rawUrl.includes('chat.qwen.ai/auth/') ||
      rawUrl.endsWith('chat.qwen.ai/auth')
    );
  }
}

function isGoogleAuthUrl(rawUrl: string): boolean {
  if (!rawUrl || typeof rawUrl !== 'string') {
    return false;
  }
  try {
    const parsed = new URL(rawUrl);
    if (!/(?:^|\.)accounts\.google\.com$/i.test(parsed.hostname)) {
      return false;
    }
    return parsed.pathname.includes('/signin/') || parsed.pathname.includes('/oauth');
  } catch {
    return rawUrl.includes('accounts.google.com');
  }
}

function isLocalOAuthCallbackUrl(rawUrl: string): boolean {
  if (!rawUrl || typeof rawUrl !== 'string') {
    return false;
  }
  try {
    const parsed = new URL(rawUrl);
    const host = String(parsed.hostname || '').toLowerCase();
    const isLocalHost = host === '127.0.0.1' || host === 'localhost' || host === '::1';
    if (!isLocalHost) {
      return false;
    }
    const pathName = String(parsed.pathname || '').toLowerCase();
    if (
      pathName.includes('oauth2callback') ||
      pathName.includes('oauth/callback') ||
      pathName.includes('oauth_callback')
    ) {
      return true;
    }
    return parsed.searchParams.has('code') || parsed.searchParams.has('state');
  } catch (error: unknown) {
    logCamoufoxLauncherNonBlocking('is_local_oauth_callback_url.parse', error, {
      rawUrl: String(rawUrl || '').slice(0, 200)
    });
    return false;
  }
}

async function waitForOAuthRelatedPage(options: {
  provider?: string | null;
  launchUrl: string;
  actionContext: CamoActionContext;
  settleTimeoutMs: number;
  pollIntervalMs: number;
}): Promise<string | null> {
  const timeoutMs = options.settleTimeoutMs > 0 ? options.settleTimeoutMs : 12000;
  const intervalMs = options.pollIntervalMs > 0 ? options.pollIntervalMs : 300;
  const provider = String(options.provider || '').trim().toLowerCase();
  const deadline = Date.now() + timeoutMs;
  let lastUrl: string | null = null;
  while (Date.now() <= deadline) {
    const activeUrl = getActiveCamoPageUrl(options.actionContext);
    if (activeUrl) {
      lastUrl = activeUrl;
      if (isTokenPortalUrl(activeUrl) || isLocalOAuthCallbackUrl(activeUrl)) {
        return activeUrl;
      }
      if (provider === 'qwen' && (isQwenAuthorizeUrl(activeUrl) || isQwenLoginUrl(activeUrl) || isGoogleAuthUrl(activeUrl))) {
        return activeUrl;
      }
      if ((provider === 'gemini-cli' || provider === 'antigravity') && isGoogleAuthUrl(activeUrl)) {
        return activeUrl;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return lastUrl;
}

async function maybeAdvanceQwenAuthorization(options: {
  provider?: string | null;
  actionContext: CamoActionContext;
}): Promise<boolean> {
  const provider = String(options.provider || '').trim().toLowerCase();
  if (provider !== 'qwen') {
    return true;
  }
  let activeUrl = getActiveCamoPageUrl(options.actionContext);
  const autoMode = String(process.env.ROUTECODEX_CAMOUFOX_AUTO_MODE || '').trim().toLowerCase();
  const autoModeEnabled = autoMode === 'qwen';
  if (!autoModeEnabled) {
    return true;
  }
  const settleTimeoutMs = parsePositiveInt(process.env.ROUTECODEX_CAMOUFOX_QWEN_OAUTH_SETTLE_MS, 8000);
  const pollIntervalMs = parsePositiveInt(process.env.ROUTECODEX_CAMOUFOX_QWEN_OAUTH_POLL_MS, 250);
  const deadline = Date.now() + settleTimeoutMs;
  while (Date.now() <= deadline) {
    const currentUrl = getActiveCamoPageUrl(options.actionContext);
    if (currentUrl) {
      activeUrl = currentUrl;
      if (isQwenAuthorizeUrl(currentUrl) || isGoogleAuthUrl(currentUrl) || isQwenLoginUrl(currentUrl)) {
        break;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  if (!activeUrl) {
    logOAuthDebug('[OAuth] camo-cli qwen oauth page not ready (no active url)');
    return false;
  }
  if (isLocalOAuthCallbackUrl(activeUrl)) {
    logOAuthDebug(`[OAuth] camo-cli qwen oauth callback already reached: ${activeUrl}`);
    return true;
  }
  if (isGoogleAuthUrl(activeUrl)) {
    // Google auth handled in the next stage.
    return true;
  }
  if (isQwenLoginUrl(activeUrl)) {
    logOAuthDebug(`[OAuth] camo-cli qwen login page detected; advancing with Google login: ${activeUrl}`);
    const retryCount = parsePositiveInt(process.env.ROUTECODEX_CAMOUFOX_QWEN_CLICK_RETRIES, autoModeEnabled ? 12 : 2);
    const retryDelayMs = parsePositiveInt(process.env.ROUTECODEX_CAMOUFOX_QWEN_CLICK_RETRY_DELAY_MS, 500);
    return clickCamoTarget(options.actionContext, CAMO_CLICK_TARGETS.qwenGoogleContinue, {
      retries: retryCount,
      retryDelayMs,
      required: true
    });
  }
  if (!isQwenAuthorizeUrl(activeUrl)) {
    // Qwen flow can jump directly to callback/Google/other intermediate pages depending on session state.
    // Do not hard-fail on non-qwen pages here; let subsequent steps/callback waiter continue.
    logOAuthDebug(`[OAuth] camo-cli qwen oauth page not ready; continue without strict qwen click: ${activeUrl}`);
    return true;
  }
  const readyDelayMs = parsePositiveInt(process.env.ROUTECODEX_CAMOUFOX_QWEN_CONFIRM_WAIT_MS, 1200);
  if (readyDelayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, readyDelayMs));
  }
  const retryCount = parsePositiveInt(process.env.ROUTECODEX_CAMOUFOX_QWEN_CLICK_RETRIES, autoModeEnabled ? 12 : 2);
  const retryDelayMs = parsePositiveInt(process.env.ROUTECODEX_CAMOUFOX_QWEN_CLICK_RETRY_DELAY_MS, 500);

  // Try direct confirm first; if not present, fall back to Google entry button.
  const confirmClicked = await clickCamoTarget(options.actionContext, CAMO_CLICK_TARGETS.qwenAuthorizeConfirm, {
    retries: retryCount,
    retryDelayMs,
    required: true
  });
  if (confirmClicked) {
    return true;
  }
  const googleClicked = await clickCamoTarget(options.actionContext, CAMO_CLICK_TARGETS.qwenGoogleContinue, {
    retries: retryCount,
    retryDelayMs,
    required: true
  });
  return googleClicked;
}


async function waitForGoogleAuthPage(options: {
  provider?: string | null;
  actionContext: CamoActionContext;
  settleTimeoutMs: number;
  pollIntervalMs: number;
}): Promise<string | null> {
  const timeoutMs = options.settleTimeoutMs > 0 ? options.settleTimeoutMs : 7000;
  const intervalMs = options.pollIntervalMs > 0 ? options.pollIntervalMs : 250;
  const provider = String(options.provider || '').trim().toLowerCase();
  const deadline = Date.now() + timeoutMs;
  let lastUrl: string | null = null;
  while (Date.now() <= deadline) {
    const activeUrl = getActiveCamoPageUrl(options.actionContext);
    if (activeUrl) {
      lastUrl = activeUrl;
      if (isGoogleAuthUrl(activeUrl)) {
        return activeUrl;
      }
      if (provider === 'qwen' && (isQwenLoginUrl(activeUrl) || isQwenAuthorizeUrl(activeUrl) || isLocalOAuthCallbackUrl(activeUrl))) {
        return activeUrl;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  if (!lastUrl) {
    return null;
  }
  if (isGoogleAuthUrl(lastUrl)) {
    return lastUrl;
  }
  if (provider === 'qwen' && (isQwenLoginUrl(lastUrl) || isQwenAuthorizeUrl(lastUrl) || isLocalOAuthCallbackUrl(lastUrl))) {
    return lastUrl;
  }
  return null;
}

async function waitForGoogleSignInPrompt(options: {
  actionContext: CamoActionContext;
  settleTimeoutMs: number;
  pollIntervalMs: number;
}): Promise<{ activeUrl: string | null; promptDetected: boolean }> {
  const timeoutMs = options.settleTimeoutMs > 0 ? options.settleTimeoutMs : 12_000;
  const intervalMs = options.pollIntervalMs > 0 ? options.pollIntervalMs : 400;
  const deadline = Date.now() + timeoutMs;
  let lastUrl: string | null = null;
  while (Date.now() <= deadline) {
    const activeUrl = getActiveCamoPageUrl(options.actionContext);
    if (activeUrl) {
      lastUrl = activeUrl;
      if (!isGoogleAuthUrl(activeUrl)) {
        return { activeUrl, promptDetected: false };
      }
      if (hasCamoGoogleSignInPrompt(options.actionContext)) {
        return { activeUrl, promptDetected: true };
      }
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return {
    activeUrl: lastUrl,
    promptDetected: !!lastUrl && isGoogleAuthUrl(lastUrl) && hasCamoGoogleSignInPrompt(options.actionContext)
  };
}

async function maybeAdvanceGoogleAuth(options: {
  provider?: string | null;
  alias?: string | null;
  actionContext: CamoActionContext;
}): Promise<boolean> {
  const provider = String(options.provider || '').trim().toLowerCase();
  if (provider !== 'gemini-cli' && provider !== 'antigravity' && provider !== 'qwen') {
    return true;
  }
  const autoMode = String(process.env.ROUTECODEX_CAMOUFOX_AUTO_MODE || '').trim().toLowerCase();
  const autoModeEnabled = autoMode === 'gemini' || autoMode === 'antigravity' || autoMode === 'qwen';
  if (!autoModeEnabled) {
    return true;
  }
  let activeUrl = getActiveCamoPageUrl(options.actionContext);
  const needsGooglePageWait =
    !!activeUrl &&
    !isGoogleAuthUrl(activeUrl) &&
    (isQwenAuthorizeUrl(activeUrl) || isQwenLoginUrl(activeUrl) || isTokenPortalUrl(activeUrl));
  if (needsGooglePageWait) {
    const settleTimeoutMs = parsePositiveInt(process.env.ROUTECODEX_CAMOUFOX_GOOGLE_OAUTH_SETTLE_MS, 7000);
    const pollIntervalMs = parsePositiveInt(process.env.ROUTECODEX_CAMOUFOX_GOOGLE_OAUTH_POLL_MS, 250);
    activeUrl = await waitForGoogleAuthPage({
      provider,
      actionContext: options.actionContext,
      settleTimeoutMs,
      pollIntervalMs
    });
  }
  if (activeUrl && isLocalOAuthCallbackUrl(activeUrl)) {
    logOAuthDebug(`[OAuth] camo-cli google auth stage reached local callback: ${activeUrl}`);
    return true;
  }
  if (provider === 'qwen' && activeUrl && isQwenLoginUrl(activeUrl)) {
    const qwenRetryCount = parsePositiveInt(process.env.ROUTECODEX_CAMOUFOX_QWEN_CLICK_RETRIES, autoModeEnabled ? 12 : 2);
    const qwenRetryDelayMs = parsePositiveInt(process.env.ROUTECODEX_CAMOUFOX_QWEN_CLICK_RETRY_DELAY_MS, 500);
    const qwenLoginClicked = await clickCamoTarget(options.actionContext, CAMO_CLICK_TARGETS.qwenGoogleContinue, {
      retries: qwenRetryCount,
      retryDelayMs: qwenRetryDelayMs,
      required: true
    });
    if (!qwenLoginClicked) {
      return false;
    }
    const settleTimeoutMs = parsePositiveInt(process.env.ROUTECODEX_CAMOUFOX_GOOGLE_OAUTH_SETTLE_MS, 7000);
    const pollIntervalMs = parsePositiveInt(process.env.ROUTECODEX_CAMOUFOX_GOOGLE_OAUTH_POLL_MS, 250);
    activeUrl = await waitForGoogleAuthPage({
      provider,
      actionContext: options.actionContext,
      settleTimeoutMs,
      pollIntervalMs
    });
    if (activeUrl && isLocalOAuthCallbackUrl(activeUrl)) {
      logOAuthDebug(`[OAuth] camo-cli qwen login advance reached local callback: ${activeUrl}`);
      return true;
    }
  }
  if (!activeUrl || !isGoogleAuthUrl(activeUrl)) {
    return true;
  }
  const retryCount = parsePositiveInt(process.env.ROUTECODEX_CAMOUFOX_GOOGLE_CLICK_RETRIES, autoModeEnabled ? 4 : 2);
  const retryDelayMs = parsePositiveInt(process.env.ROUTECODEX_CAMOUFOX_GOOGLE_CLICK_RETRY_DELAY_MS, 350);
  const signInRetryCount = parsePositiveInt(process.env.ROUTECODEX_CAMOUFOX_GOOGLE_SIGNIN_RETRIES, autoModeEnabled ? 12 : retryCount);
  const signInRetryDelayMs = parsePositiveInt(process.env.ROUTECODEX_CAMOUFOX_GOOGLE_SIGNIN_RETRY_DELAY_MS, autoModeEnabled ? 500 : retryDelayMs);
  const accountHint = String(
    process.env.ROUTECODEX_CAMOUFOX_ACCOUNT_TEXT ||
    process.env.RCC_CAMOUFOX_ACCOUNT_TEXT ||
    options.alias ||
    ''
  ).trim();
  const hasEmailHint = accountHint.includes('@');
  if (accountHint) {
    const hintClicked = await clickCamoGoogleAccountByHint(options.actionContext, accountHint, {
      retries: retryCount,
      retryDelayMs,
      required: autoModeEnabled && hasEmailHint
    });
    if (!hintClicked) {
      return false;
    }
  }
  // If we matched a concrete email hint, do not run generic account fallback.
  if (!hasEmailHint) {
    const accountFallbackClicked = await clickCamoTarget(options.actionContext, CAMO_CLICK_TARGETS.googleAccountSelect, {
      retries: retryCount,
      retryDelayMs,
      required: autoModeEnabled
    });
    if (!accountFallbackClicked) {
      return false;
    }
  }
  const signInUrl = getActiveCamoPageUrl(options.actionContext);
  if (!signInUrl) {
    logOAuthDebug('[OAuth] camo-cli google sign-in step failed: active page unavailable (session may be closed)');
    return false;
  }
  if (!isGoogleAuthUrl(signInUrl)) {
    logOAuthDebug(`[OAuth] camo-cli google sign-in step skipped (active page is non-google): ${signInUrl || 'n/a'}`);
    return true;
  }
  const strictRequired = provider === 'gemini-cli' || provider === 'antigravity';
  const signInSettleMs = parsePositiveInt(process.env.ROUTECODEX_CAMOUFOX_GOOGLE_SIGNIN_SETTLE_MS, strictRequired ? 16_000 : 8_000);
  const signInPollMs = parsePositiveInt(process.env.ROUTECODEX_CAMOUFOX_GOOGLE_SIGNIN_POLL_MS, 400);
  const signInProbe = await waitForGoogleSignInPrompt({
    actionContext: options.actionContext,
    settleTimeoutMs: signInSettleMs,
    pollIntervalMs: signInPollMs
  });
  if (signInProbe.promptDetected) {
    const signInClicked = await clickCamoGoogleSignInBySelector(options.actionContext, {
      retries: signInRetryCount,
      retryDelayMs: signInRetryDelayMs,
      required: true
    });
    if (!signInClicked) {
      return false;
    }
  } else if (strictRequired && signInProbe.activeUrl && isGoogleAuthUrl(signInProbe.activeUrl)) {
    logOAuthDebug(
      `[OAuth] camo-cli google sign-in prompt not observed on strict provider=${provider} url=${signInProbe.activeUrl}`
    );
    return false;
  }
  return true;
}

async function waitForTokenPortalPage(options: {
  actionContext: CamoActionContext;
  settleTimeoutMs: number;
  pollIntervalMs: number;
}): Promise<boolean> {
  const timeoutMs = options.settleTimeoutMs > 0 ? options.settleTimeoutMs : 4000;
  const intervalMs = options.pollIntervalMs > 0 ? options.pollIntervalMs : 250;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const activeUrl = getActiveCamoPageUrl(options.actionContext);
    if (activeUrl && isTokenPortalUrl(activeUrl)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}


export async function openAuthInCamoufox(options: CamoufoxLaunchOptions): Promise<boolean> {
  setCamoufoxLaunchFailureReason(null);
  logOAuthDebug(
    `[OAuth] Camoufox: launch requested url=${options.url} provider=${options.provider ?? ''} alias=${options.alias ?? ''
    }`
  );
  const url = options.url;
  if (!url || typeof url !== 'string') {
    logOAuthDebug('[OAuth] Camoufox: invalid or empty URL; falling back to default browser');
    setCamoufoxLaunchFailureReason('invalid_launch_url');
    return false;
  }
  const launchUrl = applyGoogleLocaleHint(url);

  const explicitProfileId = options.profileId && options.profileId.trim().length > 0
    ? options.profileId.trim()
    : '';
  const profileId = resolvePreferredOAuthProfileId(options.provider, options.alias, explicitProfileId);

  // Ensure profile directory exists ahead of launch so that fingerprint/profile data can be persisted per token.
  const profileDir = ensureCamoufoxProfileDir(options.provider, options.alias);
  const profileRoot = getProfileRoot();
  const fingerprintRoot = getFingerprintRoot();

  if (!shouldPreferCamoCliForOAuth(options.provider)) {
    logOAuthDebug('[OAuth] camo-cli launch skipped (provider disabled)');
    setCamoufoxLaunchFailureReason('provider_disabled');
    return false;
  }

  const devMode = String(process.env.ROUTECODEX_CAMOUFOX_DEV_MODE || '').trim().toLowerCase();
  const headless = !(devMode === '1' || devMode === 'true' || devMode === 'yes' || devMode === 'on');
  const camoCommand = resolveCamoCliCommand();
  const effectiveAutoMode = resolveEffectiveCamoufoxAutoMode(options.provider);

  try {
    console.log(
      `[OAuth] Camoufox launcher spawn via camo-cli: profileId=${profileId} headless=${headless ? '1' : '0'}`
    );
    const fingerprintEnvRaw = ensureFingerprintEnv(profileId, options.provider, options.alias);
    const fingerprintEnv = sanitizeCamouConfigForOAuth(options.provider, fingerprintEnvRaw);
    const localeEnv = resolveCamoufoxLocaleEnv();
    const sharedEnv = {
      ...process.env,
      ...(effectiveAutoMode
        ? {
          ROUTECODEX_CAMOUFOX_AUTO_MODE: effectiveAutoMode,
          RCC_CAMOUFOX_AUTO_MODE: effectiveAutoMode
        }
        : {}),
      ...localeEnv,
      ...fingerprintEnv,
      WEBAUTO_PATHS_PROFILES: profileRoot,
      WEBAUTO_PATHS_FINGERPRINTS: fingerprintRoot,
      BROWSER_PROFILE_ID: profileId,
      BROWSER_PROFILE_DIR: profileDir,
      BROWSER_INITIAL_URL: launchUrl
    };
    const actionContext: CamoActionContext = {
      camoCommand,
      profileId,
      env: sharedEnv
    };

    if (!ensureCamoProfile(actionContext)) {
      setCamoufoxLaunchFailureReason('profile_create_failed');
      return false;
    }
    // camo currently resolves session routing by default profile in some paths.
    if (!setDefaultCamoProfile(actionContext)) {
      setCamoufoxLaunchFailureReason('profile_default_set_failed');
      return false;
    }

    if (!startCamoSession(actionContext, headless)) {
      setCamoufoxLaunchFailureReason('session_start_failed');
      return false;
    }

    // Ensure we always navigate to the requested URL even when the session already exists.
    let effectiveLaunchUrl = launchUrl;
    let gotoOk = gotoCamoUrl(actionContext, effectiveLaunchUrl);
    if (!gotoOk) {
      const isPortalLaunch = isTokenPortalUrl(launchUrl);
      const provider = String(options.provider || '').trim().toLowerCase();
      if (!headless) {
        logOAuthDebug(
          '[OAuth] camo-cli goto returned non-zero in headful mode; keep session for manual portal/open-url continuation'
        );
        gotoOk = true;
      }
      if (isPortalLaunch) {
        const settleTimeoutMs = parsePositiveInt(process.env.ROUTECODEX_CAMOUFOX_PORTAL_GOTO_SETTLE_MS, 4000);
        const pollIntervalMs = parsePositiveInt(process.env.ROUTECODEX_CAMOUFOX_PORTAL_GOTO_POLL_MS, 250);
        const portalSettled = await waitForTokenPortalPage({
          actionContext,
          settleTimeoutMs,
          pollIntervalMs
        });
        if (portalSettled) {
          logOAuthDebug(
            '[OAuth] camo-cli portal goto returned non-zero but active page settled to portal; continue with portal flow'
          );
          gotoOk = true;
        }
      }
      if (!gotoOk) {
        const relatedSettled = await waitForOAuthRelatedPage({
          provider,
          launchUrl,
          actionContext,
          settleTimeoutMs: parsePositiveInt(process.env.ROUTECODEX_CAMOUFOX_GOTO_SETTLE_MS, provider === 'qwen' ? 15000 : 8000),
          pollIntervalMs: parsePositiveInt(process.env.ROUTECODEX_CAMOUFOX_GOTO_POLL_MS, 250)
        });
        if (relatedSettled) {
          logOAuthDebug(
            `[OAuth] camo-cli goto returned non-zero but oauth-related page settled to: ${relatedSettled}`
          );
          gotoOk = true;
        }
      }
      if (!gotoOk) {
        const fallbackOauthUrl = resolvePortalOauthUrl(launchUrl);
        if (fallbackOauthUrl && headless) {
          logOAuthDebug(`[OAuth] camo-cli portal goto failed; fallback to direct oauthUrl=${fallbackOauthUrl}`);
          effectiveLaunchUrl = fallbackOauthUrl;
          gotoOk = gotoCamoUrl(actionContext, effectiveLaunchUrl);
        }
      }
    }
    if (!gotoOk) {
      setCamoufoxLaunchFailureReason('goto_failed');
      return false;
    }

    const portalAdvanced = await maybeAdvanceTokenPortal({
      launchUrl,
      actionContext
    });
    if (!portalAdvanced) {
      setCamoufoxLaunchFailureReason('element_not_found:token_portal_continue');
      return false;
    }

    const qwenAdvanced = await maybeAdvanceQwenAuthorization({
      provider: options.provider,
      actionContext
    });
    if (!qwenAdvanced) {
      setCamoufoxLaunchFailureReason('element_not_found:qwen_authorization');
      return false;
    }
    const googleAdvanced = await maybeAdvanceGoogleAuth({
      provider: options.provider,
      alias: options.alias,
      actionContext
    });
    if (!googleAdvanced) {
      setCamoufoxLaunchFailureReason('element_not_found:google_auth_step');
      return false;
    }
    setCamoufoxLaunchFailureReason(null);
    return true;
  } catch (error) {
    setCamoufoxLaunchFailureReason(
      `exception:${error instanceof Error ? error.message : String(error)}`
    );
    logCamoufoxLauncherNonBlocking('open_auth_in_camoufox', error, {
      provider: options.provider ?? null,
      alias: options.alias ?? null
    });
    logOAuthDebug(
      `[OAuth] camo-cli launch failed - ${error instanceof Error ? error.message : String(error)}`
    );
    return false;
  }
}
