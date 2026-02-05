import fs from 'fs/promises';
import path from 'path';
import { homedir } from 'os';
import { buildTokenKey, type TokenDescriptor } from './token-types.js';

export type RefreshOutcome = 'success' | 'failure';
export type RefreshMode = 'auto' | 'manual';

export interface RefreshMetadata {
  startedAt: number;
  completedAt: number;
  durationMs: number;
  mode: RefreshMode;
  error?: string;
  tokenFileMtime?: number | null;
  countTowardsFailureStreak?: boolean;
  forceAutoSuspend?: boolean;
  autoSuspendImmediately?: boolean;
}

const MAX_AUTO_FAILURES = 3;

export interface TokenHistoryAggregate {
  key: string;
  provider: TokenDescriptor['provider'];
  alias: string;
  filePath: string;
  displayName: string;
  refreshSuccesses: number;
  refreshFailures: number;
  totalAttempts: number;
  firstSeenAt: number;
  lastAttemptAt?: number;
  lastDurationMs?: number;
  lastMode?: RefreshMode;
  lastResult?: RefreshOutcome;
  lastSuccessAt?: number;
  lastFailureAt?: number;
  lastError?: string;
  failureStreak: number;
  autoSuspended: boolean;
  suspendedAt?: number;
  lastTokenMtime?: number | null;
}

export interface TokenDaemonHistoryFile {
  version: number;
  updatedAt: number;
  tokens: Record<string, TokenHistoryAggregate>;
}

export interface TokenHistorySnapshot {
  exists: boolean;
  data: TokenDaemonHistoryFile;
}

export interface TokenHistoryEvent {
  timestamp: number;
  event: 'token-refresh-success' | 'token-refresh-failure';
  provider: string;
  alias: string;
  filePath: string;
  displayName: string;
  durationMs: number;
  mode: RefreshMode;
  error?: string;
}

function resolveHomeDir(): string {
  // Prefer $HOME so tests (and edge environments) can sandbox state.
  const envHome = String(process.env.HOME || '').trim();
  return envHome || homedir();
}

export function resolveTokenHistoryDirectory(): string {
  return path.join(resolveHomeDir(), '.routecodex', 'statics');
}

export function resolveTokenHistoryFilePath(): string {
  return path.join(resolveTokenHistoryDirectory(), 'token-daemon-history.json');
}

export function resolveTokenHistoryEventsFilePath(): string {
  return path.join(resolveTokenHistoryDirectory(), 'token-daemon-events.log');
}

function createDefaultHistory(): TokenDaemonHistoryFile {
  return {
    version: 1,
    updatedAt: Date.now(),
    tokens: {}
  };
}

export class TokenHistoryStore {
  private historyReady = false;
  private cachedHistory: TokenDaemonHistoryFile | null = null;
  private readonly staticsDir: string;
  private readonly historyFile: string;
  private readonly eventsFile: string;

  constructor() {
    this.staticsDir = resolveTokenHistoryDirectory();
    this.historyFile = resolveTokenHistoryFilePath();
    this.eventsFile = resolveTokenHistoryEventsFilePath();
  }

  get historyFilePath(): string {
    return this.historyFile;
  }

  get eventsFilePath(): string {
    return this.eventsFile;
  }

  async getSnapshot(): Promise<TokenHistorySnapshot> {
    const exists = await this.historyExists();
    const data = await this.readHistoryFile();
    return { exists, data };
  }

  async recordRefreshResult(token: TokenDescriptor, outcome: RefreshOutcome, metadata: RefreshMetadata): Promise<void> {
    const history = await this.readHistoryFile();
    const key = buildTokenKey(token);
    const entry = history.tokens[key] ?? {
      key,
      provider: token.provider,
      alias: token.alias,
      filePath: token.filePath,
      displayName: token.displayName,
      refreshSuccesses: 0,
      refreshFailures: 0,
      totalAttempts: 0,
      firstSeenAt: metadata.startedAt,
      failureStreak: 0,
      autoSuspended: false
    };

    entry.provider = token.provider;
    entry.alias = token.alias;
    entry.filePath = token.filePath;
    entry.displayName = token.displayName;
    entry.totalAttempts += 1;
    entry.lastAttemptAt = metadata.startedAt;
    entry.lastDurationMs = metadata.durationMs;
    entry.lastMode = metadata.mode;
    entry.lastResult = outcome;

    const isAuto = metadata.mode === 'auto';

    entry.lastTokenMtime = metadata.tokenFileMtime ?? entry.lastTokenMtime ?? null;

    if (outcome === 'success') {
      entry.refreshSuccesses += 1;
      entry.lastSuccessAt = metadata.completedAt;
      entry.lastError = undefined;
      entry.failureStreak = 0;
      entry.autoSuspended = false;
      entry.suspendedAt = undefined;
    } else {
      entry.refreshFailures += 1;
      entry.lastFailureAt = metadata.completedAt;
      entry.lastError = metadata.error;
      if (isAuto) {
        const shouldCount = metadata.countTowardsFailureStreak !== false;
        if (shouldCount) {
          entry.failureStreak = (entry.failureStreak || 0) + 1;
        }
        if (metadata.autoSuspendImmediately) {
          entry.autoSuspended = true;
          entry.suspendedAt = metadata.completedAt;
        } else {
          const forceSuspend = Boolean(metadata.forceAutoSuspend);
          if (entry.failureStreak >= MAX_AUTO_FAILURES) {
            const createSuspension = forceSuspend || metadata.tokenFileMtime === null;
            if (createSuspension) {
              entry.autoSuspended = true;
              entry.suspendedAt = metadata.completedAt;
            }
          }
        }
      } else {
        entry.failureStreak = 0;
        entry.autoSuspended = false;
        entry.suspendedAt = undefined;
      }
    }

    history.tokens[key] = entry;
    history.updatedAt = Date.now();
    await this.writeHistoryFile(history);
    await this.appendEvent({
      timestamp: metadata.completedAt,
      event: outcome === 'success' ? 'token-refresh-success' : 'token-refresh-failure',
      provider: token.provider,
      alias: token.alias,
      filePath: token.filePath,
      displayName: token.displayName,
      durationMs: metadata.durationMs,
      mode: metadata.mode,
      error: outcome === 'failure' ? metadata.error : undefined
    });
  }

  async getEntry(token: TokenDescriptor): Promise<TokenHistoryAggregate | null> {
    const history = await this.readHistoryFile();
    const key = buildTokenKey(token);
    return history.tokens[key] ?? null;
  }

  async isAutoSuspended(token: TokenDescriptor, currentMtime?: number | null): Promise<boolean> {
    const history = await this.readHistoryFile();
    const key = buildTokenKey(token);
    const entry = history.tokens[key];
    if (!entry?.autoSuspended) {
      return false;
    }
    if (entry.lastTokenMtime === null || entry.lastTokenMtime === undefined) {
      // token never wrote to disk; allow one forced interactive flow
      entry.autoSuspended = false;
      entry.failureStreak = 0;
      entry.suspendedAt = undefined;
      history.tokens[key] = entry;
      await this.writeHistoryFile(history);
      return false;
    }
    if (currentMtime !== undefined && currentMtime !== null && currentMtime > entry.lastTokenMtime) {
      entry.autoSuspended = false;
      entry.failureStreak = 0;
      entry.suspendedAt = undefined;
      entry.lastTokenMtime = currentMtime;
      history.tokens[key] = entry;
      await this.writeHistoryFile(history);
      return false;
    }
    return true;
  }

  async clearAutoSuspension(token: TokenDescriptor): Promise<void> {
    const history = await this.readHistoryFile();
    const key = buildTokenKey(token);
    const entry = history.tokens[key];
    if (!entry) {
      return;
    }
    entry.autoSuspended = false;
    entry.failureStreak = 0;
    entry.suspendedAt = undefined;
    history.tokens[key] = entry;
    await this.writeHistoryFile(history);
  }

  private async ensureDir(): Promise<void> {
    if (this.historyReady) {
      return;
    }
    await fs.mkdir(this.staticsDir, { recursive: true });
    this.historyReady = true;
  }

  private async historyExists(): Promise<boolean> {
    try {
      await fs.access(this.historyFile);
      return true;
    } catch {
      return false;
    }
  }

  private async readHistoryFile(): Promise<TokenDaemonHistoryFile> {
    await this.ensureDir();
    if (this.cachedHistory) {
      return this.cachedHistory;
    }
    try {
      const raw = await fs.readFile(this.historyFile, 'utf8');
      const parsed = JSON.parse(raw) as TokenDaemonHistoryFile;
      if (!parsed || typeof parsed !== 'object' || parsed.version !== 1 || !parsed.tokens) {
        this.cachedHistory = createDefaultHistory();
      } else {
        this.cachedHistory = parsed;
      }
    } catch {
      this.cachedHistory = createDefaultHistory();
    }
    return this.cachedHistory;
  }

  private async writeHistoryFile(data: TokenDaemonHistoryFile): Promise<void> {
    await this.ensureDir();
    const payload = JSON.stringify(data, null, 2);
    await fs.writeFile(this.historyFile, payload, 'utf8');
    this.cachedHistory = data;
  }

  private async appendEvent(event: TokenHistoryEvent): Promise<void> {
    const payload = JSON.stringify(event);
    try {
      await this.ensureDir();
      await fs.appendFile(this.eventsFile, `${payload}\n`, 'utf8');
    } catch {
      // ignore append errors to avoid blocking daemon
    }
  }
}

export async function readTokenHistorySnapshot(): Promise<TokenHistorySnapshot> {
  const store = new TokenHistoryStore();
  return store.getSnapshot();
}

export { MAX_AUTO_FAILURES };
