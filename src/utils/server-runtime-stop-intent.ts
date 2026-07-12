import fs from 'node:fs';
import path from 'node:path';
import { resolveRccRuntimeLifecycleDir } from '../config/user-data-paths.js';
import {
  planRuntimeStopIntentConsume,
  planRuntimeStopIntentWrite,
  type RuntimeStopIntentRecord as StopIntentRecord
} from '../modules/llmswitch/bridge/runtime-lifecycle-host.js';

// feature_id: runtime.lifecycle.stop_intent
// 2026-06-16 runtime lifecycle rebase: stop-intent is a cross-process signal,
// not a long-lived state file. It lives under
// <rccUserDir>/state/runtime-lifecycle/ports/<port>/stop-intent.json and must
// be reaped when older than the TTL.

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
  const plan = planRuntimeStopIntentWrite({
    port: normalizedPort,
    source: options.source,
    requestedAtMs: Number.isFinite(options.requestedAtMs as number)
      ? Number(options.requestedAtMs)
      : Date.now(),
    ...(Number.isFinite(options.pid as number) ? { pid: Number(options.pid) } : {})
  });
  if (plan.action !== 'write' || plan.resourceId !== 'runtime.stop_intent') {
    throw new Error(`writeServerStopIntent: invalid native plan action=${plan.action}`);
  }
  try {
    fs.mkdirSync(baseDir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(plan.record), 'utf8');
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
    ignorePid?: number;
    preserveMatched?: boolean;
  } = {}
): { matched: boolean; source?: string; requestedAtMs?: number; pid?: number } {
  const normalizedPort = normalizePort(port);
  if (!Number.isFinite(normalizedPort) || normalizedPort <= 0) {
    return { matched: false };
  }
  const nowMs = Number.isFinite(options.nowMs as number)
    ? Math.floor(options.nowMs as number)
    : Date.now();
  const maxAgeMs = Number.isFinite(options.maxAgeMs as number) && Number(options.maxAgeMs) > 0
    ? Math.floor(options.maxAgeMs as number)
    : undefined;
  const ignorePid = Number.isFinite(options.ignorePid as number) && Number(options.ignorePid) > 0
    ? Math.floor(Number(options.ignorePid))
    : null;
  const filePath = resolveIntentPath(normalizedPort, options.routeCodexHomeDir);
  let record: StopIntentRecord | null = null;
  try {
    if (!fs.existsSync(filePath)) {
      return { matched: false };
    }
    const raw = fs.readFileSync(filePath, 'utf8');
    record = JSON.parse(raw) as StopIntentRecord;
  } catch {
    return { matched: false };
  }

  if (!record) {
    return { matched: false };
  }
  const plan = planRuntimeStopIntentConsume({
    port: normalizedPort,
    record,
    nowMs,
    ...(maxAgeMs ? { maxAgeMs } : {}),
    ...(ignorePid ? { ignorePid } : {}),
    preserveMatched: options.preserveMatched === true
  });
  if (plan.shouldDelete) {
    try {
      fs.unlinkSync(filePath);
    } catch {
      // ignore
    }
  }
  if (!plan.matched) {
    return { matched: false };
  }
  return {
    matched: true,
    source: plan.source,
    requestedAtMs: plan.requestedAtMs,
    ...(plan.pid ? { pid: plan.pid } : {})
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
