import fs from 'node:fs';
import path from 'node:path';
import { resolveRccRuntimeLifecycleDir } from '../config/user-data-paths.js';

// feature_id: runtime.lifecycle.stop_intent
// 2026-06-16 runtime lifecycle rebase: stop-intent is a cross-process signal,
// not a long-lived state file. It lives under
// <rccUserDir>/state/runtime-lifecycle/ports/<port>/stop-intent.json and must
// be reaped when older than the TTL.

type StopIntentRecord = {
  port: number;
  requestedAtMs: number;
  source: string;
  pid?: number;
};

const DEFAULT_MAX_AGE_MS = 60_000;

function normalizePort(port: number): number {
  return Math.floor(Number(port));
}

function resolveIntentPath(port: number, routeCodexHomeDir?: string): string {
  if (routeCodexHomeDir && routeCodexHomeDir.trim()) {
    return path.join(path.resolve(routeCodexHomeDir), 'state', 'runtime-lifecycle', 'ports', String(normalizePort(port)), 'stop-intent.json');
  }
  return path.join(resolveRccRuntimeLifecycleDir(), 'ports', String(normalizePort(port)), 'stop-intent.json');
}

export function resolveServerStopIntentPath(port: number, routeCodexHomeDir?: string): string {
  return resolveIntentPath(port, routeCodexHomeDir);
}

export function writeServerStopIntent(
  port: number,
  options: {
    source?: string;
    routeCodexHomeDir?: string;
    requestedAtMs?: number;
    pid?: number;
  } = {}
): void {
  const normalizedPort = normalizePort(port);
  if (!Number.isFinite(normalizedPort) || normalizedPort <= 0) {
    return;
  }
  const filePath = resolveIntentPath(normalizedPort, options.routeCodexHomeDir);
  const baseDir = path.dirname(filePath);
  const record: StopIntentRecord = {
    port: normalizedPort,
    requestedAtMs:
      Number.isFinite(options.requestedAtMs as number)
        ? Math.floor(options.requestedAtMs as number)
        : Date.now(),
    source:
      typeof options.source === 'string' && options.source.trim() ? options.source.trim() : 'unknown',
    ...(Number.isFinite(options.pid as number) && Number(options.pid) > 0
      ? { pid: Math.floor(Number(options.pid)) }
      : {})
  };
  try {
    fs.mkdirSync(baseDir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(record), 'utf8');
  } catch {
    // ignore: stop intent is a best-effort cross-process signal
  }
}

export function consumeServerStopIntent(
  port: number,
  options: {
    routeCodexHomeDir?: string;
    nowMs?: number;
    maxAgeMs?: number;
  } = {}
): { matched: boolean; source?: string; requestedAtMs?: number } {
  const normalizedPort = normalizePort(port);
  if (!Number.isFinite(normalizedPort) || normalizedPort <= 0) {
    return { matched: false };
  }
  const nowMs = Number.isFinite(options.nowMs as number)
    ? Math.floor(options.nowMs as number)
    : Date.now();
  const maxAgeMs = Number.isFinite(options.maxAgeMs as number) && Number(options.maxAgeMs) > 0
    ? Math.floor(options.maxAgeMs as number)
    : DEFAULT_MAX_AGE_MS;
  const filePath = resolveIntentPath(normalizedPort, options.routeCodexHomeDir);
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

export function clearServerStopIntent(port: number, routeCodexHomeDir?: string): void {
  const normalizedPort = normalizePort(port);
  if (!Number.isFinite(normalizedPort) || normalizedPort <= 0) {
    return;
  }
  try {
    fs.unlinkSync(resolveIntentPath(normalizedPort, routeCodexHomeDir));
  } catch {
    // ignore
  }
}
