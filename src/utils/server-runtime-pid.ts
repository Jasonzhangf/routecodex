import fs from 'node:fs';
import path from 'node:path';
import { resolveRccRuntimeLifecycleDir, resolveRccUserDir } from '../config/user-data-paths.js';
import {
  planRuntimePidCacheReadResult,
  planRuntimePidCacheWrite,
  type RuntimePidCacheRecord as ServerPidCacheRecord
} from '../modules/llmswitch/bridge/runtime-lifecycle-host.js';

// feature_id: runtime.lifecycle.pid_cache
// 2026-06-16 runtime lifecycle rebase: pid file is a transient cache, not the
// authoritative runtime state. The authoritative state comes from the HTTP
// `/health` endpoint plus listener identity (port + trusted RouteCodex
// command). See docs/design/server-runtime-lifecycle-ssot.md.
//
// Layout:
//   <rccUserDir>/state/runtime-lifecycle/ports/<port>/pid.cache
//   <rccUserDir>/state/runtime-lifecycle/ports/<port>/instance.json
//   <rccUserDir>/state/runtime-lifecycle/ports/<port>/stop-intent.json
//
// The old `server-<port>.pid` and `daemon-stop-<port>.json` files that lived
// directly under `<rccUserDir>/` are stale and must not be written again.

function normalizePort(port: number): number {
  return Math.floor(Number(port));
}

function resolvePortsDir(routeCodexHomeDir?: string): string {
  if (routeCodexHomeDir && routeCodexHomeDir.trim()) {
    return path.join(path.resolve(routeCodexHomeDir), 'state', 'runtime-lifecycle', 'ports');
  }
  return path.join(resolveRccRuntimeLifecycleDir(), 'ports');
}

export function resolveServerPidCachePath(port: number, routeCodexHomeDir?: string): string {
  return path.join(resolvePortsDir(routeCodexHomeDir), String(normalizePort(port)), 'pid.cache');
}

export function resolveServerInstancePath(port: number, routeCodexHomeDir?: string): string {
  return path.join(resolvePortsDir(routeCodexHomeDir), String(normalizePort(port)), 'instance.json');
}

export type { ServerPidCacheRecord };

export function writeServerPidCache(args: {
  port: number;
  pid: number;
  origin?: ServerPidCacheRecord['origin'];
  routeCodexHomeDir?: string;
}): void {
  const plan = planRuntimePidCacheWrite({
    port: args.port,
    pid: args.pid,
    origin: args.origin ?? 'start',
    nowMs: Date.now()
  });
  if (plan.action !== 'write' || plan.resourceId !== 'runtime.pid_cache') {
    throw new Error(`writeServerPidCache: invalid native plan action=${plan.action}`);
  }
  const record: ServerPidCacheRecord = {
    ...plan.record,
    origin: plan.record.origin as ServerPidCacheRecord['origin']
  };
  const filePath = resolveServerPidCachePath(record.port, args.routeCodexHomeDir);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(record), 'utf8');
}

export function unlinkServerPidCacheBestEffort(args: {
  port: number;
  routeCodexHomeDir?: string;
}): void {
  const port = normalizePort(args.port);
  if (!Number.isFinite(port) || port <= 0) {
    return;
  }
  try {
    fs.unlinkSync(resolveServerPidCachePath(port, args.routeCodexHomeDir));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code && code !== 'ENOENT') {
      // eslint-disable-next-line no-console
      console.warn(`[server-runtime-pid] unlink failed: ${(error as Error).message}`);
    }
  }
}

export function readServerPidCache(args: {
  port: number;
  routeCodexHomeDir?: string;
}): ServerPidCacheRecord | null {
  const port = normalizePort(args.port);
  if (!Number.isFinite(port) || port <= 0) {
    return null;
  }
  const filePath = resolveServerPidCachePath(port, args.routeCodexHomeDir);
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    const plan = planRuntimePidCacheReadResult({ port, record: parsed });
    if (plan.shouldDelete) {
      try {
        fs.unlinkSync(filePath);
      } catch {
        // cache cleanup is best-effort; the read result still remains invalid.
      }
    }
    return plan.matched && plan.record ? plan.record : null;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code && code !== 'ENOENT') {
      return null;
    }
    return null;
  }
}

export function resolveRccUserDirFromLegacy(input: string | undefined, homeDir?: string): string {
  if (input && input.trim()) {
    return path.resolve(input);
  }
  return resolveRccUserDir(homeDir);
}
