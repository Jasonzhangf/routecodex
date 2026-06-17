import fs from 'node:fs';
import path from 'node:path';
import { resolveRccRuntimeLifecycleDir } from '../config/user-data-paths.js';

// feature_id: runtime.lifecycle.instance_registry
// 2026-06-16 runtime lifecycle rebase: each managed server instance is
// declared via instance.json. This file describes the intended runtime
// (port, host, command, config path, startedAt) and the current
// observable status (declared, bind, ready, healthy, degraded,
// shutdown-intent, stop, released, released-cleaned). It is the
// authoritative description of the instance, not the pid cache.

export type InstanceLifecycleStatus =
  | 'declared'
  | 'bind'
  | 'ready'
  | 'healthy'
  | 'degraded'
  | 'shutdown-intent'
  | 'stop'
  | 'released'
  | 'released-cleaned';

export type RuntimeInstance = {
  port: number;
  host: string;
  command: string;
  configPath: string;
  ownerScope: string;
  startedAtMs: number;
  status: InstanceLifecycleStatus;
  statusUpdatedAtMs: number;
  notes?: Record<string, string | number | boolean | null>;
};

function normalizePort(port: number): number {
  return Math.floor(Number(port));
}

function resolveInstancePath(port: number, routeCodexHomeDir?: string): string {
  if (routeCodexHomeDir && routeCodexHomeDir.trim()) {
    return path.join(path.resolve(routeCodexHomeDir), 'state', 'runtime-lifecycle', 'ports', String(normalizePort(port)), 'instance.json');
  }
  return path.join(resolveRccRuntimeLifecycleDir(), 'ports', String(normalizePort(port)), 'instance.json');
}

export function resolveRuntimeInstancePath(port: number, routeCodexHomeDir?: string): string {
  return resolveInstancePath(port, routeCodexHomeDir);
}

export function writeRuntimeInstance(args: {
  port: number;
  host: string;
  command: string;
  configPath: string;
  ownerScope: string;
  startedAtMs?: number;
  status?: InstanceLifecycleStatus;
  notes?: RuntimeInstance['notes'];
  routeCodexHomeDir?: string;
}): RuntimeInstance {
  const port = normalizePort(args.port);
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error(`writeRuntimeInstance: invalid port ${args.port}`);
  }
  const now = Date.now();
  const record: RuntimeInstance = {
    port,
    host: String(args.host || '').trim() || '127.0.0.1',
    command: String(args.command || '').trim(),
    configPath: String(args.configPath || '').trim(),
    ownerScope: String(args.ownerScope || '').trim() || 'unknown',
    startedAtMs: Number.isFinite(args.startedAtMs as number) ? Math.floor(args.startedAtMs as number) : now,
    status: args.status ?? 'declared',
    statusUpdatedAtMs: now,
    notes: args.notes
  };
  const filePath = resolveInstancePath(port, args.routeCodexHomeDir);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  // write to a sibling temp file then rename, so observers never see a half-written instance.json
  const tmpPath = `${filePath}.tmp-${process.pid}-${now}`;
  fs.writeFileSync(tmpPath, JSON.stringify(record, null, 2), 'utf8');
  fs.renameSync(tmpPath, filePath);
  return record;
}

export function readRuntimeInstance(
  port: number,
  routeCodexHomeDir?: string
): RuntimeInstance | null {
  const filePath = resolveInstancePath(port, routeCodexHomeDir);
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<RuntimeInstance>;
    if (typeof parsed.port !== 'number' || Math.floor(parsed.port) !== normalizePort(port)) {
      return null;
    }
    return parsed as RuntimeInstance;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code && code !== 'ENOENT') {
      return null;
    }
    return null;
  }
}

export function updateRuntimeInstanceStatus(args: {
  port: number;
  status: InstanceLifecycleStatus;
  notes?: RuntimeInstance['notes'];
  routeCodexHomeDir?: string;
}): RuntimeInstance | null {
  const existing = readRuntimeInstance(args.port, args.routeCodexHomeDir);
  if (!existing) {
    return null;
  }
  const now = Date.now();
  const next: RuntimeInstance = {
    ...existing,
    status: args.status,
    statusUpdatedAtMs: now,
    notes: args.notes ?? existing.notes
  };
  const filePath = resolveInstancePath(args.port, args.routeCodexHomeDir);
  const tmpPath = `${filePath}.tmp-${process.pid}-${now}`;
  fs.writeFileSync(tmpPath, JSON.stringify(next, null, 2), 'utf8');
  fs.renameSync(tmpPath, filePath);
  return next;
}

export function removeRuntimeInstance(port: number, routeCodexHomeDir?: string): boolean {
  const filePath = resolveInstancePath(port, routeCodexHomeDir);
  try {
    fs.unlinkSync(filePath);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}
