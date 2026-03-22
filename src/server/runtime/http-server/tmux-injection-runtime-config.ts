import fs from 'node:fs';
import path from 'node:path';

import { resolveRccConfigDir, resolveRccLogsDir } from '../../../config/user-data-paths.js';

type UnknownRecord = Record<string, unknown>;

export type TmuxInjectionRuntimeConfig = {
  version: number;
  sourcePath: string;
  sourceExists: boolean;
  clockSourcePath: string;
  clockSourceExists: boolean;
  heartbeatSourcePath: string;
  heartbeatSourceExists: boolean;
  clock: {
    enabled: boolean;
    override?: UnknownRecord;
  };
  heartbeat: {
    enabled: boolean;
    override?: UnknownRecord;
  };
  tmuxInjection: {
    enabled: boolean;
    injectDelayMs?: number;
    logEnabled: boolean;
    logFile: string;
    counterFile: string;
  };
};

const DEFAULT_CONFIG_PATH = path.join(resolveRccConfigDir(), 'tmux-injection.json');
const DEFAULT_CLOCK_CONFIG_PATH = path.join(resolveRccConfigDir(), 'clock.json');
const DEFAULT_HEARTBEAT_CONFIG_PATH = path.join(resolveRccConfigDir(), 'heartbeat.json');
const DEFAULT_LOG_PATH = path.join(resolveRccLogsDir(), 'tmux-injection-events.jsonl');
const CONFIG_ENV_KEYS = ['RCC_TMUX_INJECTION_CONFIG_PATH', 'ROUTECODEX_TMUX_INJECTION_CONFIG_PATH'] as const;
const CLOCK_CONFIG_ENV_KEYS = ['RCC_CLOCK_CONFIG_PATH', 'ROUTECODEX_CLOCK_CONFIG_PATH'] as const;
const HEARTBEAT_CONFIG_ENV_KEYS = ['RCC_HEARTBEAT_CONFIG_PATH', 'ROUTECODEX_HEARTBEAT_CONFIG_PATH'] as const;
const CACHE_TTL_MS = 1_000;

let cachedConfig:
  | {
      cacheKey: string;
      loadedAtMs: number;
      snapshot: TmuxInjectionRuntimeConfig;
    }
  | undefined;

function readString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value === 1) {
      return true;
    }
    if (value === 0) {
      return false;
    }
  }
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') {
    return true;
  }
  if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') {
    return false;
  }
  return undefined;
}

function readPositiveInt(value: unknown): number | undefined {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return undefined;
  }
  const floored = Math.floor(parsed);
  return floored > 0 ? floored : undefined;
}

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function expandHome(value: string): string {
  if (!value.startsWith('~/')) {
    return value;
  }
  const homeDir = String(process.env.HOME || '').trim();
  if (!homeDir) {
    return value;
  }
  return path.join(homeDir, value.slice(2));
}

function resolveConfigPathFromEnv(): string {
  for (const key of CONFIG_ENV_KEYS) {
    const raw = readString(process.env[key]);
    if (raw) {
      return path.resolve(expandHome(raw));
    }
  }
  return DEFAULT_CONFIG_PATH;
}

function resolvePathFromEnv(keys: readonly string[], defaultPath: string): string {
  for (const key of keys) {
    const raw = readString(process.env[key]);
    if (raw) {
      return path.resolve(expandHome(raw));
    }
  }
  return path.resolve(defaultPath);
}

function resolveClockConfigPathFromEnv(): string {
  return resolvePathFromEnv(CLOCK_CONFIG_ENV_KEYS, DEFAULT_CLOCK_CONFIG_PATH);
}

function resolveHeartbeatConfigPathFromEnv(): string {
  return resolvePathFromEnv(HEARTBEAT_CONFIG_ENV_KEYS, DEFAULT_HEARTBEAT_CONFIG_PATH);
}

function toRecordOrUndefined(value: unknown): UnknownRecord | undefined {
  return isRecord(value) ? value : undefined;
}

function resolveLogPath(raw: unknown): string {
  const rawPath = readString(raw);
  if (!rawPath) {
    return DEFAULT_LOG_PATH;
  }
  return path.resolve(expandHome(rawPath));
}

function mergeRecord(base: unknown, override: unknown): unknown {
  if (!isRecord(base) || !isRecord(override)) {
    return override;
  }
  return {
    ...base,
    ...override
  };
}

function buildDefaultSnapshot(sourcePath: string, clockSourcePath: string, heartbeatSourcePath: string): TmuxInjectionRuntimeConfig {
  return {
    version: 1,
    sourcePath,
    sourceExists: false,
    clockSourcePath,
    clockSourceExists: false,
    heartbeatSourcePath,
    heartbeatSourceExists: false,
    clock: { enabled: true },
    heartbeat: { enabled: true },
    tmuxInjection: {
      enabled: true,
      logEnabled: true,
      logFile: DEFAULT_LOG_PATH,
      counterFile: `${DEFAULT_LOG_PATH}.counter.json`
    }
  };
}

function buildSnapshotFromFile(
  sourcePath: string,
  clockSourcePath: string,
  heartbeatSourcePath: string,
  rawPayload: unknown,
  clockPayload: unknown,
  heartbeatPayload: unknown,
  exists: { main: boolean; clock: boolean; heartbeat: boolean }
): TmuxInjectionRuntimeConfig {
  const base = buildDefaultSnapshot(sourcePath, clockSourcePath, heartbeatSourcePath);
  const root = isRecord(rawPayload) ? rawPayload : {};
  const rawClockFromMain = toRecordOrUndefined(root.clock);
  const rawHeartbeatFromMain = toRecordOrUndefined(root.heartbeat);
  const rawClockFromFile = toRecordOrUndefined(clockPayload);
  const rawHeartbeatFromFile = toRecordOrUndefined(heartbeatPayload);
  const rawClock = toRecordOrUndefined(mergeRecord(rawClockFromMain, rawClockFromFile));
  const rawHeartbeat = toRecordOrUndefined(mergeRecord(rawHeartbeatFromMain, rawHeartbeatFromFile));
  const rawTmuxInjection = toRecordOrUndefined(root.tmuxInjection);

  const logPath = resolveLogPath(rawTmuxInjection?.logFile);
  return {
    version: readPositiveInt(root.version) || 1,
    sourcePath,
    sourceExists: exists.main,
    clockSourcePath,
    clockSourceExists: exists.clock,
    heartbeatSourcePath,
    heartbeatSourceExists: exists.heartbeat,
    clock: {
      enabled: readBoolean(rawClock?.enabled) ?? true,
      ...(rawClock ? { override: rawClock } : {})
    },
    heartbeat: {
      enabled: readBoolean(rawHeartbeat?.enabled) ?? true,
      ...(rawHeartbeat ? { override: rawHeartbeat } : {})
    },
    tmuxInjection: {
      enabled: readBoolean(rawTmuxInjection?.enabled) ?? true,
      ...(readPositiveInt(rawTmuxInjection?.injectDelayMs)
        ? { injectDelayMs: readPositiveInt(rawTmuxInjection?.injectDelayMs) }
        : {}),
      logEnabled: readBoolean(rawTmuxInjection?.logEnabled) ?? true,
      logFile: logPath,
      counterFile: `${logPath}.counter.json`
    }
  };
}

function readJsonFileSnapshot(filePath: string): {
  exists: boolean;
  mtimeMs: number;
  payload: unknown;
} {
  try {
    const stat = fs.statSync(filePath);
    const raw = fs.readFileSync(filePath, 'utf8');
    return {
      exists: true,
      mtimeMs: Math.floor(stat.mtimeMs),
      payload: JSON.parse(raw)
    };
  } catch {
    return {
      exists: false,
      mtimeMs: 0,
      payload: undefined
    };
  }
}

function readRuntimeConfigFromDisk(): TmuxInjectionRuntimeConfig {
  const sourcePath = resolveConfigPathFromEnv();
  const clockSourcePath = resolveClockConfigPathFromEnv();
  const heartbeatSourcePath = resolveHeartbeatConfigPathFromEnv();
  const now = Date.now();
  const mainConfig = readJsonFileSnapshot(sourcePath);
  const clockConfig = readJsonFileSnapshot(clockSourcePath);
  const heartbeatConfig = readJsonFileSnapshot(heartbeatSourcePath);
  const cacheKey = [
    `${sourcePath}:${mainConfig.mtimeMs}:${mainConfig.exists ? '1' : '0'}`,
    `${clockSourcePath}:${clockConfig.mtimeMs}:${clockConfig.exists ? '1' : '0'}`,
    `${heartbeatSourcePath}:${heartbeatConfig.mtimeMs}:${heartbeatConfig.exists ? '1' : '0'}`
  ].join('|');
  if (
    cachedConfig &&
    cachedConfig.cacheKey === cacheKey &&
    now - cachedConfig.loadedAtMs <= CACHE_TTL_MS
  ) {
    return cachedConfig.snapshot;
  }
  const snapshot =
    mainConfig.exists || clockConfig.exists || heartbeatConfig.exists
      ? buildSnapshotFromFile(
          sourcePath,
          clockSourcePath,
          heartbeatSourcePath,
          mainConfig.payload,
          clockConfig.payload,
          heartbeatConfig.payload,
          { main: mainConfig.exists, clock: clockConfig.exists, heartbeat: heartbeatConfig.exists }
        )
      : buildDefaultSnapshot(sourcePath, clockSourcePath, heartbeatSourcePath);
  cachedConfig = { cacheKey, loadedAtMs: now, snapshot };
  return snapshot;
}

export function resolveTmuxInjectionRuntimeConfig(): TmuxInjectionRuntimeConfig {
  return readRuntimeConfigFromDisk();
}

export function resolveClockDaemonConfigInput(raw: unknown): {
  enabled: boolean;
  configInput: unknown;
} {
  const runtime = resolveTmuxInjectionRuntimeConfig();
  const enabled = runtime.tmuxInjection.enabled && runtime.clock.enabled;
  const merged = runtime.clock.override ? mergeRecord(raw, runtime.clock.override) : raw;
  return {
    enabled,
    configInput: merged
  };
}

export function resolveHeartbeatDaemonConfigInput(raw: unknown): {
  enabled: boolean;
  configInput: unknown;
} {
  const runtime = resolveTmuxInjectionRuntimeConfig();
  const enabled = runtime.tmuxInjection.enabled && runtime.heartbeat.enabled;
  const merged = runtime.heartbeat.override ? mergeRecord(raw, runtime.heartbeat.override) : raw;
  return {
    enabled,
    configInput: merged
  };
}

export function resolveTmuxInjectDelayMsFromRuntimeConfig(): number | undefined {
  return resolveTmuxInjectionRuntimeConfig().tmuxInjection.injectDelayMs;
}

export function resolveTmuxInjectionLoggingConfig(): {
  enabled: boolean;
  logFile: string;
  counterFile: string;
} {
  const runtime = resolveTmuxInjectionRuntimeConfig();
  return {
    enabled: runtime.tmuxInjection.enabled && runtime.tmuxInjection.logEnabled,
    logFile: runtime.tmuxInjection.logFile,
    counterFile: runtime.tmuxInjection.counterFile
  };
}

export function resetTmuxInjectionRuntimeConfigCacheForTests(): void {
  cachedConfig = undefined;
}
