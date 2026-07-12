import fsp from 'fs/promises';
import path from 'path';
import { randomUUID } from 'node:crypto';
import type { FileHandle } from 'node:fs/promises';
import { formatUnknownError, isRecord } from './common-utils.js';

const DEFAULT_SNAPSHOT_KEEP_RECENT_REQUEST_DIRS = 50;
const SNAPSHOT_RETENTION_NON_BLOCKING_LOG_THROTTLE_MS = 60_000;
const snapshotRetentionNonBlockingLogState = new Map<string, number>();


function logSnapshotRequestRetentionNonBlockingError(
  stage: string,
  error: unknown,
  details?: Record<string, unknown>
): void {
  const now = Date.now();
  const last = snapshotRetentionNonBlockingLogState.get(stage) ?? 0;
  if (now - last < SNAPSHOT_RETENTION_NON_BLOCKING_LOG_THROTTLE_MS) {
    return;
  }
  snapshotRetentionNonBlockingLogState.set(stage, now);
  try {
    const detailSuffix = details && Object.keys(details).length > 0 ? ` details=${JSON.stringify(details)}` : '';
    console.warn(`[snapshot-retention] ${stage} failed (non-blocking): ${formatUnknownError(error)}${detailSuffix}`);
  } catch {
    // never throw from non-blocking logging
  }
}

function resolvePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(String(value || '').trim(), 10);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  return fallback;
}

export function resolveSnapshotKeepRecentRequestDirs(): number {
  return resolvePositiveInt(
    process.env.ROUTECODEX_SNAPSHOT_KEEP_RECENT_REQUEST_DIRS
      ?? process.env.RCC_SNAPSHOT_KEEP_RECENT_REQUEST_DIRS,
    DEFAULT_SNAPSHOT_KEEP_RECENT_REQUEST_DIRS
  );
}

function isRequestLikeDirectoryName(name: string): boolean {
  const normalized = String(name || '').trim().toLowerCase();
  return normalized.startsWith('req_') || normalized.startsWith('req-');
}

async function hasRuntimeMarker(dir: string): Promise<boolean> {
  try {
    const stat = await fsp.stat(path.join(dir, '__runtime.json'));
    return stat.isFile();
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT') {
      logSnapshotRequestRetentionNonBlockingError('hasRuntimeMarker.stat', error, { dir });
    }
    return false;
  }
}

function buildSnapshotRuntimeMarkerPayload(payload?: Record<string, unknown>): Record<string, unknown> {
  return {
    timestamp: new Date().toISOString(),
    versions: {
      routecodex: process.env.ROUTECODEX_VERSION || undefined,
      routecodexBuildTime: process.env.ROUTECODEX_BUILD_TIME || undefined,
      llmswitchCore: process.env.ROUTECODEX_LLMSWITCH_CORE_VERSION || undefined,
      node: process.env.NODE_VERSION || undefined
    },
    ...(payload || {})
  };
}

export async function ensureSnapshotRuntimeMarker(
  dir: string,
  payload?: Record<string, unknown>
): Promise<void> {
  const target = path.join(dir, '__runtime.json');
  const body = buildSnapshotRuntimeMarkerPayload(payload);
  const contents = JSON.stringify(body, null, 2);
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const tmp = path.join(
      dir,
      `.__runtime.json.tmp-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`
    );
    let handle: FileHandle | undefined;
    try {
      handle = await fsp.open(tmp, 'wx');
      await handle.writeFile(contents, { encoding: 'utf-8' });
      await handle.sync();
      await handle.close();
      handle = undefined;
      await fsp.link(tmp, target);
      await fsp.unlink(tmp).catch(() => undefined);
      return;
    } catch (error: unknown) {
      if (handle) {
        await handle.close().catch(() => undefined);
      }
      await fsp.unlink(tmp).catch(() => undefined);
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code === 'EEXIST') {
        const targetExists = await fsp.stat(target)
          .then((stat) => stat.isFile())
          .catch(() => false);
        if (targetExists) {
          return;
        }
        continue;
      }
      throw error;
    }
  }
  throw new Error(`[snapshot-retention] unable to allocate runtime marker temp file for ${target}`);
}

export async function pruneSnapshotRequestDirsKeepRecent(parentDir: string, keepRecent: number): Promise<void> {
  if (!Number.isFinite(keepRecent) || keepRecent <= 0) {
    return;
  }
  const entries = await fsp.readdir(parentDir, { withFileTypes: true }).catch((error: unknown) => {
    logSnapshotRequestRetentionNonBlockingError('pruneSnapshotRequestDirsKeepRecent.readdir', error, { parentDir });
    return [];
  });
  const requestDirs: Array<{ dir: string; name: string; mtimeMs: number }> = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    if (entry.name === '_tmp' || entry.name.startsWith('__')) {
      continue;
    }
    const dir = path.join(parentDir, entry.name);
    const requestLike = isRequestLikeDirectoryName(entry.name) || await hasRuntimeMarker(dir);
    if (!requestLike) {
      continue;
    }
    try {
      const stat = await fsp.stat(dir);
      requestDirs.push({
        dir,
        name: entry.name,
        mtimeMs: Number.isFinite(stat.mtimeMs) ? stat.mtimeMs : 0
      });
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT') {
        logSnapshotRequestRetentionNonBlockingError('pruneSnapshotRequestDirsKeepRecent.stat', error, { dir });
      }
    }
  }

  if (requestDirs.length <= keepRecent) {
    return;
  }

  requestDirs.sort((a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name));
  await Promise.all(
    requestDirs.slice(keepRecent).map(async (entry) => {
      await fsp.rm(entry.dir, { recursive: true, force: true }).catch((error: unknown) => {
        logSnapshotRequestRetentionNonBlockingError('pruneSnapshotRequestDirsKeepRecent.rm', error, {
          dir: entry.dir
        });
      });
    })
  );
}
