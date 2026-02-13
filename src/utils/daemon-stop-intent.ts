import fs from 'node:fs';
import fsAsync from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';

type StopIntentRecord = {
  port: number;
  requestedAtMs: number;
  source: string;
  pid?: number;
};

const DEFAULT_MAX_AGE_MS = 60_000;

function resolveHomeDir(routeCodexHomeDir?: string): string {
  return routeCodexHomeDir || path.join(homedir(), '.routecodex');
}

export function resolveDaemonStopIntentPath(port: number, routeCodexHomeDir?: string): string {
  return path.join(resolveHomeDir(routeCodexHomeDir), `daemon-stop-${Math.floor(port)}.json`);
}

export function writeDaemonStopIntent(
  port: number,
  options: {
    source?: string;
    routeCodexHomeDir?: string;
    requestedAtMs?: number;
    pid?: number;
  } = {}
): void {
  const normalizedPort = Math.floor(Number(port));
  if (!Number.isFinite(normalizedPort) || normalizedPort <= 0) {
    return;
  }
  const routeCodexHome = resolveHomeDir(options.routeCodexHomeDir);
  const filePath = resolveDaemonStopIntentPath(normalizedPort, options.routeCodexHomeDir);
  const record: StopIntentRecord = {
    port: normalizedPort,
    requestedAtMs:
      Number.isFinite(options.requestedAtMs as number)
        ? Math.floor(options.requestedAtMs as number)
        : Date.now(),
    source: typeof options.source === 'string' && options.source.trim() ? options.source.trim() : 'unknown',
    ...(Number.isFinite(options.pid as number) && Number(options.pid) > 0
      ? { pid: Math.floor(Number(options.pid)) }
      : {})
  };
  // 异步写入，不阻塞主流程
  void (async () => {
    try {
      await fsAsync.mkdir(routeCodexHome, { recursive: true });
      await fsAsync.writeFile(filePath, JSON.stringify(record), 'utf8');
    } catch {
      // ignore
    }
  })();
}

export function consumeDaemonStopIntent(
  port: number,
  options: {
    routeCodexHomeDir?: string;
    nowMs?: number;
    maxAgeMs?: number;
  } = {}
): { matched: boolean; source?: string; requestedAtMs?: number } {
  const normalizedPort = Math.floor(Number(port));
  if (!Number.isFinite(normalizedPort) || normalizedPort <= 0) {
    return { matched: false };
  }
  const nowMs = Number.isFinite(options.nowMs as number)
    ? Math.floor(options.nowMs as number)
    : Date.now();
  const maxAgeMs = Number.isFinite(options.maxAgeMs as number) && Number(options.maxAgeMs) > 0
    ? Math.floor(options.maxAgeMs as number)
    : DEFAULT_MAX_AGE_MS;
  const filePath = resolveDaemonStopIntentPath(normalizedPort, options.routeCodexHomeDir);
  let record: StopIntentRecord | null = null;
  try {
    if (!fs.existsSync(filePath)) {
      return { matched: false };
    }
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<StopIntentRecord>;
    if (
      typeof parsed.port !== 'number' ||
      !Number.isFinite(parsed.port) ||
      Math.floor(parsed.port) !== normalizedPort ||
      typeof parsed.requestedAtMs !== 'number' ||
      !Number.isFinite(parsed.requestedAtMs)
    ) {
      return { matched: false };
    }
    record = {
      port: Math.floor(parsed.port),
      requestedAtMs: Math.floor(parsed.requestedAtMs),
      source: typeof parsed.source === 'string' && parsed.source.trim() ? parsed.source.trim() : 'unknown'
    };
  } catch {
    return { matched: false };
  } finally {
    try {
      fs.unlinkSync(filePath);
    } catch {
      // ignore
    }
  }

  if (!record) {
    return { matched: false };
  }
  if (nowMs - record.requestedAtMs > maxAgeMs) {
    return { matched: false };
  }
  return {
    matched: true,
    source: record.source,
    requestedAtMs: record.requestedAtMs
  };
}

export function clearDaemonStopIntent(port: number, routeCodexHomeDir?: string): void {
  const filePath = resolveDaemonStopIntentPath(port, routeCodexHomeDir);
  try {
    fs.unlinkSync(filePath);
  } catch {
    // ignore
  }
}
