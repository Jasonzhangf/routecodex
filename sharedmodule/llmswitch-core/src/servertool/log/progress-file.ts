import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fs } from 'node:fs';

export type ServerToolProgressFileEvent = {
  requestId: string;
  flowId: string;
  tool: string;
  stage: string;
  result: string;
  message: string;
  step: number;
  entryEndpoint?: string;
  providerProtocol?: string;
};

const truthy = new Set(['1', 'true', 'yes', 'on']);
const falsy = new Set(['0', 'false', 'no', 'off']);
const DEFAULT_LOG_PATH = path.join(os.homedir(), '.routecodex', 'logs', 'servertool-events.jsonl');

let cachedEnabled: boolean | null = null;
let cachedLogPath: string | null = null;
let writeQueue: Promise<void> = Promise.resolve();
const ensuredDirs = new Set<string>();

function isDevMode(): boolean {
  const nodeEnv = String(process.env.NODE_ENV || '').trim().toLowerCase();
  if (nodeEnv === 'development') {
    return true;
  }
  const buildMode = String(
    process.env.ROUTECODEX_BUILD_MODE ??
      process.env.RCC_BUILD_MODE ??
      process.env.BUILD_MODE ??
      process.env.LLMSWITCH_BUILD_MODE ??
      ''
  )
    .trim()
    .toLowerCase();
  return buildMode === 'dev' || buildMode === 'development';
}

function resolveEnabled(): boolean {
  if (cachedEnabled !== null) {
    return cachedEnabled;
  }
  const raw = String(
    process.env.ROUTECODEX_SERVERTOOL_FILE_LOG ??
      process.env.RCC_SERVERTOOL_FILE_LOG ??
      process.env.LLMSWITCH_SERVERTOOL_FILE_LOG ??
      ''
  )
    .trim()
    .toLowerCase();
  if (truthy.has(raw)) {
    cachedEnabled = true;
    return true;
  }
  if (falsy.has(raw)) {
    cachedEnabled = false;
    return false;
  }
  cachedEnabled = isDevMode();
  return cachedEnabled;
}

function resolveLogPath(): string {
  if (cachedLogPath) {
    return cachedLogPath;
  }
  const raw = String(
    process.env.ROUTECODEX_SERVERTOOL_FILE_LOG_PATH ??
      process.env.RCC_SERVERTOOL_FILE_LOG_PATH ??
      process.env.LLMSWITCH_SERVERTOOL_FILE_LOG_PATH ??
      ''
  ).trim();
  cachedLogPath = raw || DEFAULT_LOG_PATH;
  return cachedLogPath;
}

async function ensureParentDir(logPath: string): Promise<void> {
  const dir = path.dirname(logPath);
  if (ensuredDirs.has(dir)) {
    return;
  }
  await fs.mkdir(dir, { recursive: true });
  ensuredDirs.add(dir);
}

export function appendServerToolProgressFileEvent(event: ServerToolProgressFileEvent): void {
  if (!resolveEnabled()) {
    return;
  }
  const logPath = resolveLogPath();
  const line = `${JSON.stringify({ ...event, ts: new Date().toISOString() })}\n`;
  writeQueue = writeQueue
    .then(async () => {
      await ensureParentDir(logPath);
      await fs.appendFile(logPath, line, 'utf8');
    })
    .catch(() => {
      // best-effort file logging
    });
}

export function resetServerToolProgressFileLoggerForTests(): void {
  cachedEnabled = null;
  cachedLogPath = null;
  ensuredDirs.clear();
  writeQueue = Promise.resolve();
}

export async function flushServerToolProgressFileLoggerForTests(): Promise<void> {
  await writeQueue;
}

