/**
 * Interactive OAuth Lock Management
 *
 * Extracted from oauth-lifecycle.ts to reduce God Object size.
 * Handles concurrent interactive OAuth authorization lock acquisition/release.
 */

import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import { resolveRccAuthDir } from '../../../config/user-data-paths.js';
import { logOAuthLifecycleNonBlocking } from './oauth-lifecycle-logger.js';
import { logOAuthDebug } from '../oauth-logger.js';
import { keyFor } from './throttle.js';

const OAUTH_INTERACTIVE_LOCK_FILE = path.join(resolveRccAuthDir(), '.oauth-interactive.lock.json');

type InteractiveOAuthLockRecord = {
  pid: number;
  providerType: string;
  tokenFile: string;
  startedAt: number;
  callbackPort?: number;
};

// ========== Functions ==========
export function readInteractiveOAuthLock(): InteractiveOAuthLockRecord | null {
  try {
    if (!fsSync.existsSync(OAUTH_INTERACTIVE_LOCK_FILE)) {
      return null;
    }
    const raw = fsSync.readFileSync(OAUTH_INTERACTIVE_LOCK_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }
    const node = parsed as Record<string, unknown>;
    if (typeof node.pid !== 'number' || typeof node.tokenFile !== 'string' || typeof node.providerType !== 'string') {
      return null;
    }
    return {
      pid: node.pid,
      tokenFile: node.tokenFile,
      providerType: node.providerType,
      startedAt: typeof node.startedAt === 'number' ? node.startedAt : Date.now(),
      callbackPort: typeof node.callbackPort === 'number' ? node.callbackPort : undefined
    };
  } catch (error) {
    logOAuthLifecycleNonBlocking('readInteractiveOAuthLock', error, {
      lockFile: OAUTH_INTERACTIVE_LOCK_FILE
    });
    return null;
  }
}

export function isSameInteractiveOAuthLock(
  left: Pick<InteractiveOAuthLockRecord, 'pid' | 'providerType' | 'tokenFile'>,
  right: Pick<InteractiveOAuthLockRecord, 'pid' | 'providerType' | 'tokenFile'>
): boolean {
  return (
    left.pid === right.pid &&
    left.providerType === right.providerType &&
    path.resolve(left.tokenFile) === path.resolve(right.tokenFile)
  );
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    logOAuthLifecycleNonBlocking(
      'isProcessAlive',
      error,
      { pid },
      { throttleKey: keyFor('interactive-oauth-process-alive', String(pid)) }
    );
    return false;
  }
}

export async function forceReclaimInteractiveOAuthLock(lock: InteractiveOAuthLockRecord): Promise<boolean> {
  try {
    const existing = readInteractiveOAuthLock();
    if (!existing || !isSameInteractiveOAuthLock(existing, lock)) {
      return false;
    }
    await fs.unlink(OAUTH_INTERACTIVE_LOCK_FILE);
    logOAuthDebug(
      `[OAuth] interactive lock reclaimed pid=${lock.pid} token=${lock.tokenFile} provider=${lock.providerType}`
    );
    return true;
  } catch (error) {
    logOAuthLifecycleNonBlocking('forceReclaimInteractiveOAuthLock', error, {
      pid: lock.pid,
      providerType: lock.providerType,
      tokenFile: lock.tokenFile
    });
    return false;
  }
}

export async function notifyOAuthLockCancel(lock: InteractiveOAuthLockRecord): Promise<void> {
  if (!lock.callbackPort || !Number.isFinite(lock.callbackPort) || lock.callbackPort <= 0) {
    return;
  }
  const url = `http://127.0.0.1:${lock.callbackPort}/oauth2callback?error=cancelled_by_new_auth`;
  try {
    await fetch(url, { method: 'GET' });
    logOAuthDebug(`[OAuth] interactive lock cancel signal sent port=${lock.callbackPort}`);
  } catch (error) {
    logOAuthDebug(
      `[OAuth] interactive lock cancel signal failed port=${lock.callbackPort}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

export async function acquireInteractiveOAuthLock(providerType: string, tokenFilePath: string): Promise<() => void> {
  await fs.mkdir(path.dirname(OAUTH_INTERACTIVE_LOCK_FILE), { recursive: true });
  const current: InteractiveOAuthLockRecord = {
    pid: process.pid,
    providerType,
    tokenFile: path.resolve(tokenFilePath),
    startedAt: Date.now()
  };

  const maxAttempts = 20;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await fs.writeFile(OAUTH_INTERACTIVE_LOCK_FILE, `${JSON.stringify(current, null, 2)}\n`, { flag: 'wx' });
      process.env.ROUTECODEX_OAUTH_INTERACTIVE_LOCK_FILE = OAUTH_INTERACTIVE_LOCK_FILE;
      return () => {
        try {
          const lock = readInteractiveOAuthLock();
          if (lock && lock.pid === process.pid && path.resolve(lock.tokenFile) === current.tokenFile) {
            fsSync.unlinkSync(OAUTH_INTERACTIVE_LOCK_FILE);
          }
        } catch (error) {
          logOAuthLifecycleNonBlocking('acquireInteractiveOAuthLock.release', error, {
            lockFile: OAUTH_INTERACTIVE_LOCK_FILE,
            providerType,
            tokenFile: current.tokenFile
          });
        } finally {
          if (process.env.ROUTECODEX_OAUTH_INTERACTIVE_LOCK_FILE === OAUTH_INTERACTIVE_LOCK_FILE) {
            delete process.env.ROUTECODEX_OAUTH_INTERACTIVE_LOCK_FILE;
          }
        }
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code || '';
      if (code !== 'EEXIST') {
        throw error;
      }
      const existing = readInteractiveOAuthLock();
      if (!existing) {
        try {
          await fs.unlink(OAUTH_INTERACTIVE_LOCK_FILE);
        } catch (error) {
          logOAuthLifecycleNonBlocking('acquireInteractiveOAuthLock.removeStaleEmptyLock', error, {
            lockFile: OAUTH_INTERACTIVE_LOCK_FILE,
            providerType,
            tokenFile: current.tokenFile
          });
        }
        continue;
      }
      if (!isProcessAlive(existing.pid)) {
        try {
          await fs.unlink(OAUTH_INTERACTIVE_LOCK_FILE);
        } catch (error) {
          logOAuthLifecycleNonBlocking('acquireInteractiveOAuthLock.removeDeadProcessLock', error, {
            lockFile: OAUTH_INTERACTIVE_LOCK_FILE,
            stalePid: existing.pid,
            providerType: existing.providerType,
            tokenFile: existing.tokenFile
          });
        }
        continue;
      }
      const sameToken = path.resolve(existing.tokenFile) === current.tokenFile;
      if (sameToken) {
        await notifyOAuthLockCancel(existing);
        await new Promise((resolve) => setTimeout(resolve, 300));
        const afterCancel = readInteractiveOAuthLock();
        const stuckOnSameLock =
          !!afterCancel && isSameInteractiveOAuthLock(afterCancel, existing);
        if (stuckOnSameLock) {
          const lockAgeMs = Math.max(0, Date.now() - (afterCancel.startedAt || Date.now()));
          const shouldForceReclaim = attempt >= 3 || lockAgeMs >= 15_000;
          if (shouldForceReclaim) {
            await forceReclaimInteractiveOAuthLock(afterCancel);
          }
        }
        continue;
      }
      throw new Error(
        `Interactive OAuth is already running for token=${existing.tokenFile}. Concurrent auth is disabled.`
      );
    }
  }
  throw new Error('Failed to acquire interactive OAuth lock after multiple attempts');
}

