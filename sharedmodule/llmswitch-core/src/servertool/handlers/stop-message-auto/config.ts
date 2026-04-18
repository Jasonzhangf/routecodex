import fs from 'node:fs';
import path from 'node:path';

import { resolveRccPath } from '../../../runtime/user-data-paths.js';

type StopMessageAiBackend = 'codex' | 'iflow';
type StopMessageRecord = Record<string, unknown>;

export type StopMessageRuntimeConfig = {
  sourcePath: string;
  sourceExists: boolean;
  debug?: boolean;
  default?: {
    enabled?: boolean;
    text?: string;
    maxRepeats?: number;
  };
  aiFollowup?: {
    enabled?: boolean;
    backend?: StopMessageAiBackend;
    codexBin?: string;
    iflowBin?: string;
    timeoutMs?: number;
    outputMaxChars?: number;
    trace?: boolean;
    doneMarker?: string;
    approvedMarker?: string;
    requireEvidence?: boolean;
    requireNextTaskAfterDone?: boolean;
    doneNextTaskPrompt?: string;
  };
};

const DEFAULT_CONFIG_PATH = resolveRccPath('config', 'stop-message.json');
const CONFIG_ENV_KEYS = [
  'RCC_STOPMESSAGE_CONFIG_PATH',
  'ROUTECODEX_STOPMESSAGE_CONFIG_PATH'
] as const;
const CONFIG_CACHE_TTL_MS = 1000;

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

function readPositiveInt(value: unknown): number | undefined {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return undefined;
  }
  const floored = Math.floor(parsed);
  return floored > 0 ? floored : undefined;
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

function normalizeBackend(value: unknown): StopMessageAiBackend | undefined {
  const text = readString(value)?.toLowerCase();
  if (text === 'iflow') {
    return text;
  }
  if (text === 'codex') {
    return text;
  }
  return undefined;
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
    const aiFollowup = asRecord(root.aiFollowup);
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
              ...(readPositiveInt(defaultConfig.maxRepeats)
                ? { maxRepeats: readPositiveInt(defaultConfig.maxRepeats) }
                : {})
            }
          }
        : {}),
      ...(aiFollowup
        ? {
            aiFollowup: {
              ...(readBoolean(aiFollowup.enabled) !== undefined
                ? { enabled: readBoolean(aiFollowup.enabled) }
                : {}),
              ...(normalizeBackend(aiFollowup.backend)
                ? { backend: normalizeBackend(aiFollowup.backend) }
                : {}),
              ...(readString(aiFollowup.codexBin) ? { codexBin: readString(aiFollowup.codexBin) } : {}),
              ...(readString(aiFollowup.iflowBin) ? { iflowBin: readString(aiFollowup.iflowBin) } : {}),
              ...(readPositiveInt(aiFollowup.timeoutMs)
                ? { timeoutMs: readPositiveInt(aiFollowup.timeoutMs) }
                : {}),
              ...(readPositiveInt(aiFollowup.outputMaxChars)
                ? { outputMaxChars: readPositiveInt(aiFollowup.outputMaxChars) }
                : {}),
              ...(readBoolean(aiFollowup.trace) !== undefined
                ? { trace: readBoolean(aiFollowup.trace) }
                : {}),
              ...(readString(aiFollowup.doneMarker) ? { doneMarker: readString(aiFollowup.doneMarker) } : {}),
              ...(readString(aiFollowup.approvedMarker)
                ? { approvedMarker: readString(aiFollowup.approvedMarker) }
                : {}),
              ...(readBoolean(aiFollowup.requireEvidence) !== undefined
                ? { requireEvidence: readBoolean(aiFollowup.requireEvidence) }
                : {}),
              ...(readBoolean(aiFollowup.requireNextTaskAfterDone) !== undefined
                ? { requireNextTaskAfterDone: readBoolean(aiFollowup.requireNextTaskAfterDone) }
                : {}),
              ...(readString(aiFollowup.doneNextTaskPrompt)
                ? { doneNextTaskPrompt: readString(aiFollowup.doneNextTaskPrompt) }
                : {})
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
  return resolveStopMessageRuntimeConfig().default?.text;
}

export function resolveStopMessageDefaultMaxRepeats(): number | undefined {
  return resolveStopMessageRuntimeConfig().default?.maxRepeats;
}

export function resolveStopMessageAiFollowupEnabled(): boolean | undefined {
  return resolveStopMessageRuntimeConfig().aiFollowup?.enabled;
}

export function resolveStopMessageAiFollowupBackend(): StopMessageAiBackend | undefined {
  return resolveStopMessageRuntimeConfig().aiFollowup?.backend;
}

export function resolveStopMessageAiFollowupCommand(backend: StopMessageAiBackend): string | undefined {
  const aiFollowup = resolveStopMessageRuntimeConfig().aiFollowup;
  if (!aiFollowup) {
    return undefined;
  }
  if (backend === 'iflow') {
    return aiFollowup.iflowBin;
  }
  return aiFollowup.codexBin;
}

export function resolveStopMessageAiFollowupTimeoutMs(): number | undefined {
  return resolveStopMessageRuntimeConfig().aiFollowup?.timeoutMs;
}

export function resolveStopMessageAiFollowupOutputMaxChars(): number | undefined {
  return resolveStopMessageRuntimeConfig().aiFollowup?.outputMaxChars;
}

export function resolveStopMessageAiTraceEnabled(): boolean | undefined {
  return resolveStopMessageRuntimeConfig().aiFollowup?.trace;
}

export function resolveStopMessageAiDoneMarker(): string | undefined {
  return resolveStopMessageRuntimeConfig().aiFollowup?.doneMarker;
}

export function resolveStopMessageAiApprovedMarker(): string | undefined {
  return resolveStopMessageRuntimeConfig().aiFollowup?.approvedMarker;
}

export function resolveStopMessageAiRequireEvidence(): boolean {
  const configured = resolveStopMessageRuntimeConfig().aiFollowup?.requireEvidence;
  return configured === false ? false : true;
}

export function resolveStopMessageAiRequireNextTaskAfterDone(): boolean {
  const configured = resolveStopMessageRuntimeConfig().aiFollowup?.requireNextTaskAfterDone;
  return configured === false ? false : true;
}

export function resolveStopMessageAiDoneNextTaskPrompt(): string {
  const configured = resolveStopMessageRuntimeConfig().aiFollowup?.doneNextTaskPrompt;
  if (configured && configured.trim()) {
    return configured.trim();
  }
  return '当前任务已完成。请基于已给出的证据，明确并执行下一步最高优先级任务。';
}

export function resetStopMessageRuntimeConfigCacheForTests(): void {
  cachedConfig = undefined;
}
