import * as fs from 'node:fs';
import * as path from 'node:path';
import type { RoutingInstructionState } from './routing-instructions.js';
import {
  serializeRoutingInstructionState,
  deserializeRoutingInstructionState
} from './routing-instructions.js';
import { providerErrorCenter } from './error-center.js';
import {
  resolveRccPath
} from '../../runtime/user-data-paths.js';

interface PersistedRoutingState {
  version: number;
  state: Record<string, unknown>;
}

const pendingWrites = new Map<string, Promise<void>>();
const STICKY_RUNTIME_REQUEST_ID = 'sticky-session-store';

function isNodeErrorWithCode(error: unknown): error is NodeJS.ErrnoException {
  return !!error && typeof error === 'object' && 'code' in error;
}

function shouldIgnoreUnlinkError(error: unknown): boolean {
  return isNodeErrorWithCode(error) && error.code === 'ENOENT';
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function emitStickyStoreError(
  code: string,
  stage: 'sticky_session.persist' | 'sticky_session.read' | 'sticky_session.recover',
  message: string,
  details: Record<string, unknown>
): void {
  providerErrorCenter.emit({
    code,
    message,
    stage,
    runtime: {
      requestId: STICKY_RUNTIME_REQUEST_ID,
      providerProtocol: 'sticky-session-store',
      providerType: 'internal'
    },
    details
  });
  try {
    const op = typeof details.operation === 'string' ? details.operation : 'unknown';
    const errMsg = typeof details.error === 'string' ? details.error : '';
    console.warn(`[sticky-session-store] ${code} stage=${stage} op=${op}${errMsg ? ` error=${errMsg}` : ''}`);
  } catch {
    // no-op
  }
}

export class StickySessionKeyMissingError extends Error {
  constructor(public readonly key: string | undefined, message: string) {
    super(message);
    this.name = 'StickySessionKeyMissingError';
  }
}

function isPersistentKey(key: string | undefined): key is string {
  if (!key) return false;
  return key.startsWith('session:')
    || key.startsWith('conversation:')
    || key.startsWith('tmux:');
}

function resolveDefaultSessionDir(scope: 'tmux' | 'routing'): string | null {
  try {
    return scope === 'tmux'
      ? resolveRccPath('sessions')
      : resolveRccPath('state', 'routing');
  } catch {
    return null;
  }
}

function resolveSessionDir(scope: 'tmux' | 'routing'): string | null {
  try {
    const override = process.env.ROUTECODEX_SESSION_DIR;
    if (scope === 'tmux' && override && override.trim()) {
      return path.resolve(override.trim());
    }
    return resolveDefaultSessionDir(scope);
  } catch {
    return null;
  }
}

function keyToFilename(key: string): string | null {
  if (!isPersistentKey(key)) {
    return null;
  }
  const idx = key.indexOf(':');
  if (idx <= 0 || idx === key.length - 1) {
    return null;
  }
  const scope = key.substring(0, idx); // "session" | "conversation" | "tmux"
  const rawId = key.substring(idx + 1);
  const safeId = rawId.replace(/[^a-zA-Z0-9_.-]/g, '_');
  return `${scope}-${safeId}.json`;
}

function resolveSessionFilepaths(key: string | undefined): string[] {
  if (!isPersistentKey(key)) {
    return [];
  }
  const scope = key.startsWith('tmux:') ? 'tmux' : 'routing';
  const dir = resolveSessionDir(scope);
  const filename = keyToFilename(key);
  if (!dir || !filename) {
    return [];
  }

  return [path.join(dir, filename)];
}

function readPersistedStateFromFile(filepath: string): RoutingInstructionState | null {
  try {
    if (!fs.existsSync(filepath)) {
      return null;
    }
    const raw = fs.readFileSync(filepath, 'utf8');
    if (!raw) {
      return null;
    }
    let parsed: PersistedRoutingState | Record<string, unknown>;
    try {
      parsed = JSON.parse(raw) as PersistedRoutingState | Record<string, unknown>;
    } catch (parseError) {
      const recovered = recoverPersistedJson(raw);
      if (!recovered) {
        emitStickyStoreError(
          'STICKY_STATE_READ_FAILED',
          'sticky_session.read',
          'failed to parse persisted sticky state JSON',
          {
            operation: 'read_parse_json',
            filepath,
            error: formatError(parseError)
          }
        );
        return null;
      }
      parsed = recovered;
      try {
        const payload =
          parsed && typeof (parsed as PersistedRoutingState).version === 'number'
            ? (parsed as PersistedRoutingState)
            : ({ version: 1, state: parsed as Record<string, unknown> } as PersistedRoutingState);
        atomicWriteFileSync(filepath, JSON.stringify(payload));
      } catch (rewriteError) {
        emitStickyStoreError(
          'STICKY_STATE_RECOVER_FAILED',
          'sticky_session.recover',
          'failed to rewrite recovered sticky state payload',
          {
            operation: 'recover_rewrite',
            filepath,
            error: formatError(rewriteError)
          }
        );
      }
    }
    const payload =
      parsed && typeof (parsed as PersistedRoutingState).version === 'number'
        ? (parsed as PersistedRoutingState).state
        : (parsed as Record<string, unknown>);
    if (!payload || typeof payload !== 'object') {
      return null;
    }
    return deserializeRoutingInstructionState(payload);
  } catch (error) {
    emitStickyStoreError(
      'STICKY_STATE_READ_FAILED',
      'sticky_session.read',
      'failed to read sticky session state from disk',
      {
        operation: 'read_file',
        filepath,
        error: formatError(error)
      }
    );
    return null;
  }
}

export function loadRoutingInstructionStateSync(key: string | undefined): RoutingInstructionState | null {
  if (!isPersistentKey(key)) {
    const error = new StickySessionKeyMissingError(key, 'Sticky session key missing or invalid; failing fast per no-fallback policy');
    throw error;
  }

  const filepaths = resolveSessionFilepaths(key);
  if (filepaths.length === 0) {
    const error = new StickySessionKeyMissingError(key, 'Unable to resolve session file path for sticky key; failing fast per no-fallback policy');
    throw error;
  }

  for (const filepath of filepaths) {
    const loaded = readPersistedStateFromFile(filepath);
    if (!loaded) {
      continue;
    }

    return loaded;
  }

  return null;
}

export function saveRoutingInstructionStateAsync(
  key: string | undefined,
  state: RoutingInstructionState | null
): void {
  const filepaths = resolveSessionFilepaths(key);
  if (filepaths.length === 0) {
    return;
  }

  // 空状态意味着清除持久化文件
  if (!state) {
    for (const filepath of filepaths) {
      scheduleWrite(filepath, async () => {
        try {
          await fs.promises.unlink(filepath);
        } catch (error) {
          if (!shouldIgnoreUnlinkError(error)) {
            emitStickyStoreError(
              'STICKY_STATE_PERSIST_FAILED',
              'sticky_session.persist',
              'failed to unlink sticky session state file',
              {
                operation: 'unlink',
                filepath,
                error: formatError(error)
              }
            );
          }
        }
      });
    }
    return;
  }

  const payload: PersistedRoutingState = {
    version: 1,
    state: serializeRoutingInstructionState(state)
  };

  for (const filepath of filepaths) {
    const dir = path.dirname(filepath);
    scheduleWrite(filepath, async () => {
      try {
        await fs.promises.mkdir(dir, { recursive: true });
      } catch (error) {
        emitStickyStoreError(
          'STICKY_STATE_PERSIST_FAILED',
          'sticky_session.persist',
          'failed to create sticky session state directory',
          {
            operation: 'mkdir',
            filepath,
            dir,
            error: formatError(error)
          }
        );
      }
      try {
        await atomicWriteFile(filepath, JSON.stringify(payload));
      } catch (error) {
        emitStickyStoreError(
          'STICKY_STATE_PERSIST_FAILED',
          'sticky_session.persist',
          'failed to persist sticky session state file',
          {
            operation: 'write',
            filepath,
            dir,
            error: formatError(error)
          }
        );
      }
    });
  }
}

export function saveRoutingInstructionStateSync(
  key: string | undefined,
  state: RoutingInstructionState | null
): void {
  if (!isPersistentKey(key)) {
    return;
  }

  const filepaths = resolveSessionFilepaths(key);
  if (filepaths.length === 0) {
    return;
  }

  if (!state) {
    for (const filepath of filepaths) {
      try {
        fs.unlinkSync(filepath);
      } catch (error) {
        if (!shouldIgnoreUnlinkError(error)) {
          emitStickyStoreError(
            'STICKY_STATE_PERSIST_FAILED',
            'sticky_session.persist',
            'failed to unlink sticky session state file',
            {
              operation: 'unlinkSync',
              filepath,
              error: formatError(error)
            }
          );
        }
      }
    }
    return;
  }

  const payload: PersistedRoutingState = {
    version: 1,
    state: serializeRoutingInstructionState(state)
  };

  for (const filepath of filepaths) {
    const dir = path.dirname(filepath);
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (error) {
      emitStickyStoreError(
        'STICKY_STATE_PERSIST_FAILED',
        'sticky_session.persist',
        'failed to create sticky session state directory',
        {
          operation: 'mkdirSync',
          filepath,
          dir,
          error: formatError(error)
        }
      );
    }

    try {
      atomicWriteFileSync(filepath, JSON.stringify(payload));
    } catch (error) {
      emitStickyStoreError(
        'STICKY_STATE_PERSIST_FAILED',
        'sticky_session.persist',
        'failed to persist sticky session state file',
        {
          operation: 'writeSync',
          filepath,
          dir,
          error: formatError(error)
        }
      );
    }
  }
}

function scheduleWrite(filepath: string, task: () => Promise<void>): void {
  const previous = pendingWrites.get(filepath) ?? Promise.resolve();
  const next = previous
    .then(task)
    .catch((error) => {
      emitStickyStoreError(
        'STICKY_STATE_PERSIST_FAILED',
        'sticky_session.persist',
        'unexpected sticky session async write task failure',
        {
          operation: 'scheduleWrite',
          filepath,
          error: formatError(error)
        }
      );
    })
    .finally(() => {
      if (pendingWrites.get(filepath) === next) {
        pendingWrites.delete(filepath);
      }
    });
  pendingWrites.set(filepath, next);
}

async function atomicWriteFile(filepath: string, content: string): Promise<void> {
  const tmp = `${filepath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  try {
    await fs.promises.writeFile(tmp, content, { encoding: 'utf8' });
    try {
      await fs.promises.rename(tmp, filepath);
    } catch {
      try {
        await fs.promises.unlink(filepath);
      } catch {
        // ignore unlink failures
      }
      await fs.promises.rename(tmp, filepath);
    }
  } finally {
    try {
      await fs.promises.unlink(tmp);
    } catch {
      // ignore tmp cleanup failures
    }
  }
}

function atomicWriteFileSync(filepath: string, content: string): void {
  const tmp = `${filepath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  try {
    fs.writeFileSync(tmp, content, { encoding: 'utf8' });
    try {
      fs.renameSync(tmp, filepath);
    } catch {
      try {
        fs.unlinkSync(filepath);
      } catch {
        // ignore unlink failures
      }
      fs.renameSync(tmp, filepath);
    }
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // ignore tmp cleanup failures
    }
  }
}

function recoverPersistedJson(raw: string): PersistedRoutingState | Record<string, unknown> | null {
  if (typeof raw !== 'string') {
    return null;
  }
  const text = raw.trim();
  if (!text.startsWith('{')) {
    return null;
  }
  const maxScan = Math.min(text.length, 256 * 1024);
  for (let i = maxScan - 1; i >= 1; i -= 1) {
    if (text[i] !== '}') {
      continue;
    }
    const candidate = text.slice(0, i + 1);
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as PersistedRoutingState | Record<string, unknown>;
      }
    } catch {
      // keep scanning
    }
  }
  return null;
}
