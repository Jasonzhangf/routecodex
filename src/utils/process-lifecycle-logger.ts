import fs from 'fs/promises';
import fsSync from 'fs';
import os from 'os';
import path from 'path';

type JsonScalar = string | number | boolean | null;
type JsonLike = JsonScalar | JsonLike[] | { [key: string]: JsonLike };

export interface ProcessLifecycleEvent {
  event: string;
  source: string;
  details?: Record<string, unknown>;
}

interface ProcessLifecycleRecord {
  ts: string;
  pid: number;
  ppid: number;
  event: string;
  source: string;
  details?: JsonLike;
}

const DEFAULT_LOG_DIR = path.join(os.homedir(), '.routecodex', 'logs');
const DEFAULT_LOG_PATH = path.join(DEFAULT_LOG_DIR, 'process-lifecycle.jsonl');

let writeQueue: Promise<void> = Promise.resolve();

function parseBool(value: string | undefined, defaultValue: boolean): boolean {
  if (typeof value !== 'string') {
    return defaultValue;
  }
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return defaultValue;
  }
  if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') {
    return true;
  }
  if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') {
    return false;
  }
  return defaultValue;
}

function resolveLogPath(): string {
  const envPath = process.env.ROUTECODEX_PROCESS_LIFECYCLE_LOG || process.env.RCC_PROCESS_LIFECYCLE_LOG;
  if (typeof envPath === 'string' && envPath.trim()) {
    return envPath.trim();
  }
  return DEFAULT_LOG_PATH;
}

function shouldConsoleLog(): boolean {
  return parseBool(process.env.ROUTECODEX_PROCESS_LIFECYCLE_CONSOLE || process.env.RCC_PROCESS_LIFECYCLE_CONSOLE, true);
}

function serializeUnknown(value: unknown): JsonLike {
  if (value === null || value === undefined) {
    return null;
  }
  const primitiveType = typeof value;
  if (primitiveType === 'string' || primitiveType === 'number' || primitiveType === 'boolean') {
    return value as JsonScalar;
  }
  if (Array.isArray(value)) {
    return value.map((item) => serializeUnknown(item));
  }
  if (value instanceof Error) {
    const out: Record<string, JsonLike> = {
      name: value.name,
      message: value.message
    };
    if (value.stack) {
      out.stack = value.stack;
    }
    return out;
  }
  try {
    return JSON.parse(JSON.stringify(value)) as JsonLike;
  } catch {
    return String(value);
  }
}

function buildRecord(event: ProcessLifecycleEvent): ProcessLifecycleRecord {
  return {
    ts: new Date().toISOString(),
    pid: process.pid,
    ppid: process.ppid,
    event: event.event,
    source: event.source,
    ...(event.details ? { details: serializeUnknown(event.details) } : {})
  };
}

function formatConsoleLine(record: ProcessLifecycleRecord): string {
  const details = record.details && typeof record.details === 'object' && !Array.isArray(record.details)
    ? (record.details as Record<string, JsonLike>)
    : null;
  const parts: string[] = [];
  if (details) {
    for (const key of ['signal', 'targetPid', 'port', 'result', 'reason']) {
      const value = details[key];
      if (value !== undefined && value !== null && value !== '') {
        parts.push(`${key}=${String(value)}`);
      }
    }
  }
  const suffix = parts.length ? ` ${parts.join(' ')}` : '';
  return `[routecodex.lifecycle][${record.ts}] ${record.event} source=${record.source}${suffix}`;
}

function printBlue(line: string): void {
  const canColor = Boolean(process.stdout?.isTTY);
  if (canColor) {
    console.log(`\x1b[94m${line}\x1b[0m`);
    return;
  }
  console.log(line);
}

async function appendRecord(record: ProcessLifecycleRecord): Promise<void> {
  const logPath = resolveLogPath();
  const dir = path.dirname(logPath);
  if (!fsSync.existsSync(dir)) {
    await fs.mkdir(dir, { recursive: true });
  }
  await fs.appendFile(logPath, `${JSON.stringify(record)}\n`, 'utf8');
}

function appendRecordSync(record: ProcessLifecycleRecord): void {
  try {
    const logPath = resolveLogPath();
    const dir = path.dirname(logPath);
    if (!fsSync.existsSync(dir)) {
      fsSync.mkdirSync(dir, { recursive: true });
    }
    fsSync.appendFileSync(logPath, `${JSON.stringify(record)}\n`, 'utf8');
  } catch {
    // Never throw from lifecycle logging.
  }
}

function enqueueWrite(task: () => Promise<void>): void {
  writeQueue = writeQueue.then(async () => {
    try {
      await task();
    } catch {
      // Never throw from lifecycle logging.
    }
  });
}

export function logProcessLifecycle(event: ProcessLifecycleEvent): void {
  const record = buildRecord(event);
  if (shouldConsoleLog()) {
    printBlue(formatConsoleLine(record));
  }
  enqueueWrite(async () => {
    await appendRecord(record);
  });
}

export function logProcessLifecycleSync(event: ProcessLifecycleEvent): void {
  const record = buildRecord(event);
  if (shouldConsoleLog()) {
    printBlue(formatConsoleLine(record));
  }
  appendRecordSync(record);
}

export async function flushProcessLifecycleLogQueue(): Promise<void> {
  try {
    await writeQueue;
  } catch {
    // Never throw from lifecycle logging.
  }
}

