/**
 * Launcher Utilities
 *
 * General utility functions for launcher operations.
 */

import type fs from 'node:fs';
import type path from 'node:path';
import { spawnSync } from 'node:child_process';

/**
 * Resolve binary path from command name
 */
export function resolveBinary(options: {
  fsImpl: typeof fs;
  pathImpl: typeof path;
  homedir: () => string;
  command: string;
}): string {
  const raw = String(options.command || '').trim();
  if (!raw) {
    return '';
  }
  if (raw.includes('/') || raw.includes('\\')) {
    return raw;
  }

  const candidates: string[] = [];
  try {
    candidates.push(options.pathImpl.join('/opt/homebrew/bin', raw));
  } catch {
    // ignore
  }
  try {
    candidates.push(options.pathImpl.join('/usr/local/bin', raw));
  } catch {
    // ignore
  }
  try {
    candidates.push(options.pathImpl.join(options.homedir(), '.local', 'bin', raw));
  } catch {
    // ignore
  }

  for (const candidate of candidates) {
    try {
      if (candidate && options.fsImpl.existsSync(candidate)) {
        return candidate;
      }
    } catch {
      // ignore
    }
  }

  return raw;
}

/**
 * Parse server URL into components
 */
export function parseServerUrl(
  raw: string
): { protocol: 'http' | 'https'; host: string; port: number | null; basePath: string } {
  const trimmed = String(raw || '').trim();
  if (!trimmed) {
    throw new Error('--url is empty');
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    parsed = new URL(`http://${trimmed}`);
  }
  const protocol = parsed.protocol === 'https:' ? 'https' : 'http';
  const host = parsed.hostname;
  const hasExplicitPort = Boolean(parsed.port && parsed.port.trim());
  const port = hasExplicitPort ? Number(parsed.port) : null;
  const rawPath = typeof parsed.pathname === 'string' ? parsed.pathname : '';
  const basePath = rawPath && rawPath !== '/' ? rawPath.replace(/\/+$/, '') : '';
  return { protocol, host, port: Number.isFinite(port as number) ? (port as number) : null, basePath };
}

/**
 * Resolve boolean from environment variable
 */
export function resolveBoolFromEnv(value: unknown, fallback: boolean): boolean {
  if (typeof value !== 'string') {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }
  return fallback;
}

/**
 * Resolve integer from environment variable with bounds
 */
export function resolveIntFromEnv(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'string') {
    return fallback;
  }
  const parsed = Number.parseInt(value.trim(), 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

/**
 * Resolve Tmux self-heal policy from environment
 */
export function resolveTmuxSelfHealPolicy(env: NodeJS.ProcessEnv): { enabled: boolean; maxRetries: number; retryDelaySec: number } {
  const enabled = resolveBoolFromEnv(
    env.ROUTECODEX_TMUX_SELF_HEAL_ENABLE ?? env.RCC_TMUX_SELF_HEAL_ENABLE,
    true
  );
  const maxRetries = resolveIntFromEnv(
    env.ROUTECODEX_TMUX_SELF_HEAL_MAX_RETRIES ?? env.RCC_TMUX_SELF_HEAL_MAX_RETRIES,
    3,
    0,
    20
  );
  const retryDelayMs = resolveIntFromEnv(
    env.ROUTECODEX_TMUX_SELF_HEAL_RETRY_DELAY_MS ?? env.RCC_TMUX_SELF_HEAL_RETRY_DELAY_MS,
    2000,
    200,
    60_000
  );
  return {
    enabled,
    maxRetries,
    retryDelaySec: Math.max(1, Math.ceil(retryDelayMs / 1000))
  };
}

/**
 * Read API key from config file
 */
export function readConfigApiKey(fsImpl: typeof fs, configPath: string): string | null {
  try {
    if (!configPath || !fsImpl.existsSync(configPath)) {
      return null;
    }
    const txt = fsImpl.readFileSync(configPath, 'utf8');
    const cfg = JSON.parse(txt);
    const direct = cfg?.httpserver?.apikey ?? cfg?.modules?.httpserver?.config?.apikey ?? cfg?.server?.apikey;
    const value = typeof direct === 'string' ? direct.trim() : '';
    return value ? value : null;
  } catch {
    return null;
  }
}

/**
 * Normalize connect host (convert ::, ::1, localhost to 0.0.0.0)
 */
export function normalizeConnectHost(host: string): string {
  const value = String(host || '').toLowerCase();
  if (value === '0.0.0.0') {
    return '0.0.0.0';
  }
  if (value === '::' || value === '::1' || value === 'localhost') {
    return '0.0.0.0';
  }
  return host || '0.0.0.0';
}

/**
 * Convert value to integer port
 */
export function toIntegerPort(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.floor(parsed);
    }
  }
  return null;
}

/**
 * Try to read host/port from config file
 */
export function tryReadConfigHostPort(
  fsImpl: typeof fs,
  configPath: string
): { host: string | null; port: number | null } {
  if (!configPath || !fsImpl.existsSync(configPath)) {
    return { host: null, port: null };
  }
  try {
    const configContent = fsImpl.readFileSync(configPath, 'utf8');
    const config = JSON.parse(configContent);
    const port = toIntegerPort(config?.httpserver?.port ?? config?.server?.port ?? config?.port);
    const hostRaw = config?.httpserver?.host ?? config?.server?.host ?? config?.host;
    const host = typeof hostRaw === 'string' && hostRaw.trim() ? hostRaw.trim() : null;
    return { host, port };
  } catch {
    return { host: null, port: null };
  }
}

/**
 * Rotate log file when it exceeds max size
 */
export function rotateLogFile(fsImpl: typeof fs, filePath: string, maxBytes = 8 * 1024 * 1024, maxBackups = 3): void {
  try {
    if (!fsImpl.existsSync(filePath)) {
      return;
    }
    const stat = fsImpl.statSync(filePath);
    if (!stat.isFile() || stat.size < maxBytes) {
      return;
    }

    for (let index = maxBackups - 1; index >= 1; index--) {
      const from = `${filePath}.${index}`;
      const to = `${filePath}.${index + 1}`;
      try {
        if (fsImpl.existsSync(from)) {
          if (fsImpl.existsSync(to)) {
            fsImpl.unlinkSync(to);
          }
          fsImpl.renameSync(from, to);
        }
      } catch {
        // ignore
      }
    }

    const firstBackup = `${filePath}.1`;
    if (fsImpl.existsSync(firstBackup)) {
      try {
        fsImpl.unlinkSync(firstBackup);
      } catch {
        // ignore
      }
    }
    fsImpl.renameSync(filePath, firstBackup);
  } catch {
    // ignore rotation failures
  }
}

/**
 * Check if tmux is available
 */
export function isTmuxAvailable(spawnSyncImpl: typeof spawnSync = spawnSync): boolean {
  try {
    const result = spawnSyncImpl('tmux', ['-V'], { encoding: 'utf8' });
    return result.status === 0;
  } catch {
    return false;
  }
}

/**
 * Normalize path for comparison
 */
export function normalizePathForComparison(candidate: string, pathImpl?: typeof path): string {
  const raw = String(candidate || '').trim();
  if (!raw) {
    return '';
  }
  try {
    const resolved = (pathImpl ?? require('node:path')).resolve(raw).replace(/[\\/]+$/, '');
    if (process.platform === 'win32') {
      return resolved.toLowerCase();
    }
    return resolved;
  } catch {
    return raw;
  }
}

/**
 * Check if command is an idle shell (reusable)
 */
export function isReusableIdlePaneCommand(command: string): boolean {
  const normalized = String(command || '').trim().toLowerCase();
  if (!normalized) {
    return true;
  }
  return normalized === 'zsh'
    || normalized === 'bash'
    || normalized === 'sh'
    || normalized === 'fish'
    || normalized === 'nu';
}

/**
 * Normalize session token for tmux session name
 */
export function normalizeSessionToken(value: string): string {
  return String(value || '').replace(/[^a-zA-Z0-9_-]+/g, '_') || 'launcher';
}

/**
 * Quote string for shell
 */
export function shellQuote(value: string): string {
  return `'${String(value ?? '').replace(/'/g, `'"'"'`)}'`;
}

/**
 * Build shell command from tokens
 */
export function buildShellCommand(tokens: string[]): string {
  return tokens.map((token) => shellQuote(token)).join(' ');
}

/**
 * Collect environment differences
 */
export function collectChangedEnv(baseEnv: NodeJS.ProcessEnv, nextEnv: NodeJS.ProcessEnv): { set: Array<[string, string]>; unset: string[] } {
  const set: Array<[string, string]> = [];
  const unset: string[] = [];

  for (const [key, value] of Object.entries(nextEnv)) {
    if (typeof value !== 'string') {
      continue;
    }
    if (baseEnv[key] !== value) {
      set.push([key, value]);
    }
  }

  for (const [key, value] of Object.entries(baseEnv)) {
    if (typeof value !== 'string') {
      continue;
    }
    if (typeof nextEnv[key] === 'undefined') {
      unset.push(key);
    }
  }

  return { set, unset };
}

/**
 * Resolve working directory
 */
export function resolveWorkingDirectory(
  cwdFn: (() => string) | undefined,
  fsImpl: typeof fs,
  pathImpl: typeof path,
  requested?: string
): string {
  const getCwd = cwdFn ?? (() => process.cwd());
  try {
    const candidate = requested ? String(requested) : getCwd();
    const resolved = pathImpl.resolve(candidate);
    if (fsImpl.existsSync(resolved)) {
      return resolved;
    }
  } catch {
    return getCwd();
  }
  return getCwd();
}

/**
 * Collect pass-through arguments
 */
export function collectPassThroughArgs(args: {
  rawArgv: string[];
  commandName: string;
  knownOptions: Set<string>;
  requiredValueOptions: Set<string>;
  extraArgsFromCommander: string[];
}): string[] {
  const { rawArgv, commandName, knownOptions, requiredValueOptions, extraArgsFromCommander } = args;

  const indexCommand = rawArgv.findIndex((token) => token === commandName);
  const afterCommand = indexCommand >= 0 ? rawArgv.slice(indexCommand + 1) : [];
  const separatorIndex = afterCommand.indexOf('--');
  const tail = separatorIndex >= 0 ? afterCommand.slice(separatorIndex + 1) : afterCommand;

  const passThrough: string[] = [];
  for (let index = 0; index < tail.length; index++) {
    const token = tail[index];
    if (knownOptions.has(token)) {
      if (requiredValueOptions.has(token)) {
        index += 1;
      }
      continue;
    }
    if (token.startsWith('--')) {
      const equalIndex = token.indexOf('=');
      if (equalIndex > 2) {
        const optionName = token.slice(0, equalIndex);
        if (knownOptions.has(optionName)) {
          continue;
        }
      }
    }
    passThrough.push(token);
  }

  const merged: string[] = [];
  const seen = new Set<string>();
  const appendUnique = (values: string[]) => {
    for (const value of values) {
      if (!seen.has(value)) {
        seen.add(value);
        merged.push(value);
      }
    }
  };

  appendUnique(extraArgsFromCommander);
  appendUnique(passThrough);
  return merged;
}

/**
 * Normalize OpenAI base URL
 */
export function normalizeOpenAiBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  if (trimmed.endsWith('/v1')) {
    return trimmed;
  }
  return `${trimmed}/v1`;
}