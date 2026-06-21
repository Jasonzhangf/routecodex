import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { resolveRccPath } from '../../../runtime/user-data-paths.js';

type StopMessageRecord = Record<string, unknown>;

export type StopMessageRuntimeConfig = {
  sourcePath: string;
  sourceExists: boolean;
  debug?: boolean;
  default?: {
    enabled?: boolean;
    text?: string;
    maxRepeats?: unknown;
  };
};

const DEFAULT_CONFIG_PATH = resolveRccPath('config', 'stop-message.json');
const CONFIG_ENV_KEYS = [
  'RCC_STOPMESSAGE_CONFIG_PATH',
  'ROUTECODEX_STOPMESSAGE_CONFIG_PATH'
] as const;
const CONFIG_CACHE_TTL_MS = 1000;

function resolveModuleDir(): string {
  const importMetaUrl = (() => {
    try {
      return Function('return import.meta.url')() as string | undefined;
    } catch {
      return undefined;
    }
  })();
  try {
    if (typeof importMetaUrl === 'string' && importMetaUrl.startsWith('file:')) {
      return path.dirname(fileURLToPath(importMetaUrl));
    }
  } catch {
    // Jest/CJS transforms may not expose import.meta.
  }
  if (typeof __dirname === 'string' && __dirname.length > 0) {
    return __dirname;
  }
  try {
    const require = createRequire(importMetaUrl || pathToFileURL(path.join(process.cwd(), 'noop.mjs')).href);
    const promptAssetPkg = require.resolve('@jsonstudio/llms/servertool/handlers/stop-message-auto/config.js');
    return path.dirname(promptAssetPkg);
  } catch {
    // ignore: caller will fall back to source/dir lookup
  }
  try {
    const require = createRequire(importMetaUrl || pathToFileURL(path.join(process.cwd(), 'noop.mjs')).href);
    const promptAssetPkg = require.resolve('@jsonstudio/llms/package.json');
    return path.resolve(path.dirname(promptAssetPkg), 'src/servertool/handlers/stop-message-auto');
  } catch {
    // ignore: caller will fall back to source/dir lookup
  }
  return path.resolve(process.cwd(), 'sharedmodule/llmswitch-core/src/servertool/handlers/stop-message-auto');
}

const PROMPT_BUNDLED_PATH = path.resolve(resolveModuleDir(), '../../assets/stop-message-prompts.md');
const PROMPT_SOURCE_PATH = path.resolve(resolveModuleDir(), '../../../../src/servertool/assets/stop-message-prompts.md');
const PROMPT_DIST_FALLBACK_PATH = path.resolve(process.cwd(), 'sharedmodule/llmswitch-core/dist/servertool/assets/stop-message-prompts.md');
const PROMPT_CACHE_TTL_MS = 1000;
let cachedPrompts:
  | {
      cacheKey: string;
      loadedAtMs: number;
      snapshot: { round1: string; round2: string; round3: string };
    }
  | undefined;

function parseStopMessagePromptAsset(raw: string): { round1: string; round2: string; round3: string } {
  const matches = {
    round1: raw.match(/<!-- stop_message_prompt:round1:start -->([\s\S]*?)<!-- stop_message_prompt:round1:end -->/),
    round2: raw.match(/<!-- stop_message_prompt:round2:start -->([\s\S]*?)<!-- stop_message_prompt:round2:end -->/),
    round3: raw.match(/<!-- stop_message_prompt:round3:start -->([\s\S]*?)<!-- stop_message_prompt:round3:end -->/),
  };
  const round1 = matches.round1?.[1]?.trim();
  const round2 = matches.round2?.[1]?.trim();
  const round3 = matches.round3?.[1]?.trim();
  if (!round1 || !round2 || !round3) {
    throw new Error('invalid stop-message prompt asset: missing round1/round2/round3 block');
  }
  return { round1, round2, round3 };
}

function resolveStopMessagePromptAssetPath(): string {
  if (fs.existsSync(PROMPT_BUNDLED_PATH)) {
    return PROMPT_BUNDLED_PATH;
  }
  if (fs.existsSync(PROMPT_DIST_FALLBACK_PATH)) {
    return PROMPT_DIST_FALLBACK_PATH;
  }
  return PROMPT_SOURCE_PATH;
}

function loadStopMessagePromptAsset(): { round1: string; round2: string; round3: string } {
  const sourcePath = resolveStopMessagePromptAssetPath();
  const now = Date.now();
  try {
    const stat = fs.statSync(sourcePath);
    const cacheKey = `${sourcePath}:${Math.floor(stat.mtimeMs)}`;
    if (cachedPrompts && cachedPrompts.cacheKey === cacheKey && now - cachedPrompts.loadedAtMs <= PROMPT_CACHE_TTL_MS) {
      return cachedPrompts.snapshot;
    }
    const raw = fs.readFileSync(sourcePath, 'utf8');
    const snapshot = parseStopMessagePromptAsset(raw);
    cachedPrompts = { cacheKey, loadedAtMs: now, snapshot };
    return snapshot;
  } catch (error) {
    const cacheKey = `${sourcePath}:missing`;
    if (cachedPrompts && cachedPrompts.cacheKey === cacheKey && now - cachedPrompts.loadedAtMs <= PROMPT_CACHE_TTL_MS) {
      return cachedPrompts.snapshot;
    }
    throw new Error(`STOP_MESSAGE_PROMPT_ASSET_FAILED: ${error instanceof Error ? error.message : String(error)}`);
  }
}

let cachedConfig:
  | {
      cacheKey: string;
      loadedAtMs: number;
      snapshot: StopMessageRuntimeConfig;
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

function asRecord(value: unknown): StopMessageRecord | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  return value as StopMessageRecord;
}

function expandHome(value: string): string {
  if (!value.startsWith('~/')) {
    return value;
  }
  const homeDir = readString(process.env.HOME);
  if (!homeDir) {
    return value;
  }
  return path.join(homeDir, value.slice(2));
}

function resolveConfigPath(): string {
  for (const key of CONFIG_ENV_KEYS) {
    const raw = readString(process.env[key]);
    if (raw) {
      return path.resolve(expandHome(raw));
    }
  }
  return path.resolve(DEFAULT_CONFIG_PATH);
}

function loadConfigSnapshot(): StopMessageRuntimeConfig {
  const sourcePath = resolveConfigPath();
  const now = Date.now();
  try {
    const stat = fs.statSync(sourcePath);
    const cacheKey = `${sourcePath}:${Math.floor(stat.mtimeMs)}`;
    if (
      cachedConfig &&
      cachedConfig.cacheKey === cacheKey &&
      now - cachedConfig.loadedAtMs <= CONFIG_CACHE_TTL_MS
    ) {
      return cachedConfig.snapshot;
    }
    const raw = fs.readFileSync(sourcePath, 'utf8');
    const parsed = JSON.parse(raw);
    const root = asRecord(parsed) || {};
    const defaultConfig = asRecord(root.default);
    const snapshot: StopMessageRuntimeConfig = {
      sourcePath,
      sourceExists: true,
      ...(readBoolean(root.debug) !== undefined ? { debug: readBoolean(root.debug) } : {}),
      ...(defaultConfig
        ? {
            default: {
              ...(readBoolean(defaultConfig.enabled) !== undefined
                ? { enabled: readBoolean(defaultConfig.enabled) }
                : {}),
              ...(readString(defaultConfig.text) ? { text: readString(defaultConfig.text) } : {}),
              ...('maxRepeats' in defaultConfig ? { maxRepeats: defaultConfig.maxRepeats } : {})
            }
          }
        : {})
    };
    cachedConfig = { cacheKey, loadedAtMs: now, snapshot };
    return snapshot;
  } catch {
    const cacheKey = `${sourcePath}:missing`;
    if (
      cachedConfig &&
      cachedConfig.cacheKey === cacheKey &&
      now - cachedConfig.loadedAtMs <= CONFIG_CACHE_TTL_MS
    ) {
      return cachedConfig.snapshot;
    }
    const snapshot: StopMessageRuntimeConfig = {
      sourcePath,
      sourceExists: false
    };
    cachedConfig = { cacheKey, loadedAtMs: now, snapshot };
    return snapshot;
  }
}

export function resolveStopMessageRuntimeConfig(): StopMessageRuntimeConfig {
  return loadConfigSnapshot();
}

export function resolveStopMessageDebugEnabled(): boolean | undefined {
  return resolveStopMessageRuntimeConfig().debug;
}

export function resolveStopMessageDefaultEnabled(): boolean | undefined {
  return resolveStopMessageRuntimeConfig().default?.enabled;
}

export function resolveStopMessageDefaultText(): string | undefined {
  return loadStopMessagePromptAsset().round1;
}

export function resolveStopMessageDefaultMaxRepeats(): unknown {
  return resolveStopMessageRuntimeConfig().default?.maxRepeats;
}

export function resetStopMessageRuntimeConfigCacheForTests(): void {
  cachedConfig = undefined;
}

export function resolveStopMessageExecutionPromptForRound(round: number): string | undefined {
  const prompts = loadStopMessagePromptAsset();
  if (round <= 0) return prompts.round1;
  if (round === 1) return prompts.round2;
  return prompts.round3;
}

export function resetStopMessagePromptAssetCacheForTests(): void {
  cachedPrompts = undefined;
}
