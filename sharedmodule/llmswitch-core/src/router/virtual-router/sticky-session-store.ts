import * as fs from 'node:fs';
import * as path from 'node:path';
import os from 'node:os';
import type { RoutingInstructionState } from './routing-instructions.js';
import {
  serializeRoutingInstructionState,
  deserializeRoutingInstructionState
} from './routing-instructions.js';
import { providerErrorCenter } from './error-center.js';

interface PersistedRoutingState {
  version: number;
  state: Record<string, unknown>;
}

const pendingWrites = new Map<string, Promise<void>>();

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

function resolveRoutecodexUserDir(): string | null {
  try {
    const override = String(process.env.ROUTECODEX_USER_DIR || '').trim();
    if (override) {
      return path.resolve(override);
    }
    const home = os.homedir();
    if (!home) {
      return null;
    }
    return path.join(home, '.routecodex');
  } catch {
    return null;
  }
}

function resolveDefaultSessionDir(): string | null {
  try {
    const userDir = resolveRoutecodexUserDir();
    if (!userDir) {
      return null;
    }
    return path.join(userDir, 'sessions');
  } catch {
    return null;
  }
}

function resolveSessionDir(): string | null {
  try {
    const override = process.env.ROUTECODEX_SESSION_DIR;
    if (override && override.trim()) {
      return path.resolve(override.trim());
    }
    return resolveDefaultSessionDir();
  } catch {
    return null;
  }
}

function resolveSessionFallbackDir(primaryDir: string): string | null {
  try {
    const defaultDir = resolveDefaultSessionDir();
    if (!defaultDir) {
      return null;
    }
    const normalizedPrimary = path.resolve(primaryDir);
    const normalizedDefault = path.resolve(defaultDir);
    if (normalizedPrimary === normalizedDefault) {
      return null;
    }
    if (
      normalizedPrimary.startsWith(`${normalizedDefault}${path.sep}`) ||
      normalizedPrimary === normalizedDefault
    ) {
      return normalizedDefault;
    }
    return null;
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
  const dir = resolveSessionDir();
  const filename = keyToFilename(key);
  if (!dir || !filename) {
    return [];
  }

  return [path.join(dir, filename)];
}

function resolveSessionLoadFilepaths(key: string | undefined): string[] {
  if (!isPersistentKey(key)) {
    return [];
  }
  return resolveSessionFilepaths(key);
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
    } catch {
      const recovered = recoverPersistedJson(raw);
      if (!recovered) {
        return null;
      }
      parsed = recovered;
      try {
        const payload =
          parsed && typeof (parsed as PersistedRoutingState).version === 'number'
            ? (parsed as PersistedRoutingState)
            : ({ version: 1, state: parsed as Record<string, unknown> } as PersistedRoutingState);
        atomicWriteFileSync(filepath, JSON.stringify(payload));
      } catch {
        // ignore rewrite failures
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
  } catch {
    return null;
  }
}

export function loadRoutingInstructionStateSync(key: string | undefined): RoutingInstructionState | null {
  if (!isPersistentKey(key)) {
    const error = new StickySessionKeyMissingError(key, 'Sticky session key missing or invalid; failing fast per no-fallback policy');
    throw error;
  }

  const filepaths = resolveSessionLoadFilepaths(key);
  if (filepaths.length === 0) {
    const error = new StickySessionKeyMissingError(key, 'Unable to resolve session file path for sticky key; failing fast per no-fallback policy');
    throw error;
  }

  const writeTargets = resolveSessionFilepaths(key);

  for (const filepath of filepaths) {
    const loaded = readPersistedStateFromFile(filepath);
    if (!loaded) {
      continue;
    }

    if (writeTargets.length > 0 && !writeTargets.includes(filepath)) {
      saveRoutingInstructionStateSync(key, loaded);
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
        } catch {
          // ignore unlink errors (e.g. ENOENT)
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
      } catch {
        // ignore mkdir errors; write below will fail silently
      }
      try {
        await atomicWriteFile(filepath, JSON.stringify(payload));
      } catch {
        // ignore async write failures
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
      } catch {
        // ignore unlink failures
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
    } catch {
      // ignore mkdir errors
    }

    try {
      atomicWriteFileSync(filepath, JSON.stringify(payload));
    } catch {
      // ignore sync write failures
    }
  }
}

function scheduleWrite(filepath: string, task: () => Promise<void>): void {
  const previous = pendingWrites.get(filepath) ?? Promise.resolve();
  const next = previous
    .then(task)
    .catch(() => {
      // swallow errors
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
