import { spawn, spawnSync, type ChildProcess, type SpawnSyncOptions, type SpawnSyncReturns } from 'node:child_process';
import fs from 'node:fs';
import fsAsync from 'node:fs/promises';
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

type PythonLauncher = {
  command: string;
  argsPrefix: string[];
};

type PythonRunResult = {
  launcher: PythonLauncher | null;
  result: SpawnSyncReturns<string | Buffer> | null;
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
  } catch {
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
  return family === 'gemini' || family === 'iflow' || family === 'qwen';
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

  const family = getProviderFamily(provider);
  if (family === 'iflow') {
    // iFlow OAuth 页面在部分指纹下会因 header 覆盖导致页面乱码；OAuth 场景统一移除该覆盖。
    delete parsed['headers.Accept-Encoding'];
    if (Object.prototype.hasOwnProperty.call(parsed, 'timezone')) {
      delete parsed.timezone;
    }
    env.CAMOU_CONFIG_1 = JSON.stringify(parsed);
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
    } catch {
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
  } catch {
    // ignore
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
  } catch {
    // Missing or invalid file – caller will re-generate.
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
    } catch {
      // best-effort
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
  } catch {
    // fingerprint generation failures are non-fatal for token scanning
  }
}

export async function openAuthInCamoufox(options: CamoufoxLaunchOptions): Promise<boolean> {
  logOAuthDebug(
    `[OAuth] Camoufox: launch requested url=${options.url} provider=${options.provider ?? ''} alias=${options.alias ?? ''
    }`
  );
  const url = options.url;
  if (!url || typeof url !== 'string') {
    logOAuthDebug('[OAuth] Camoufox: invalid or empty URL; falling back to default browser');
    return false;
  }
  const launchUrl = applyGoogleLocaleHint(url);

  const profileId = options.profileId && options.profileId.trim().length > 0
    ? options.profileId.trim()
    : buildProfileId(options.provider, options.alias);

  // Ensure profile directory exists ahead of launch so that fingerprint/profile data can be persisted per token.
  ensureCamoufoxProfileDir(options.provider, options.alias);

  if (!shouldPreferCamoCliForOAuth(options.provider)) {
    logOAuthDebug('[OAuth] camo-cli launch skipped (provider disabled)');
    return false;
  }

  const devMode = String(process.env.ROUTECODEX_CAMOUFOX_DEV_MODE || '').trim().toLowerCase();
  const headless = !(devMode === '1' || devMode === 'true' || devMode === 'yes' || devMode === 'on');
  const camoCommand = resolveCamoCliCommand();

  try {
    console.log(
      `[OAuth] Camoufox launcher spawn via camo-cli: profileId=${profileId} headless=${headless ? '1' : '0'}`
    );
    const startArgs = ['start', profileId];
    if (headless) {
      startArgs.push('--headless');
    }
    const sharedEnv = {
      ...process.env,
      BROWSER_PROFILE_ID: profileId,
      BROWSER_INITIAL_URL: launchUrl
    };

    const start = spawnSync(camoCommand, startArgs, {
      stdio: 'inherit',
      env: sharedEnv
    });
    if (start.status !== 0 || start.error) {
      logOAuthDebug(
        `[OAuth] camo-cli start failed - status=${start.status ?? 'n/a'} error=${
          start.error instanceof Error ? start.error.message : String(start.error || '')
        }`
      );
      return false;
    }

    // Ensure we always navigate to the requested URL even when the session already exists.
    const goto = spawnSync(camoCommand, ['goto', profileId, launchUrl], {
      stdio: 'inherit',
      env: sharedEnv
    });
    if (goto.status !== 0 || goto.error) {
      logOAuthDebug(
        `[OAuth] camo-cli goto failed - status=${goto.status ?? 'n/a'} error=${
          goto.error instanceof Error ? goto.error.message : String(goto.error || '')
        }`
      );
      return false;
    }
    return true;
  } catch (error) {
    logOAuthDebug(
      `[OAuth] camo-cli launch failed - ${error instanceof Error ? error.message : String(error)}`
    );
    return false;
  }
}
