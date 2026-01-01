import fs from 'fs/promises';
import path from 'path';
import { homedir } from 'os';
import chalk from 'chalk';
import { ensureValidOAuthToken } from '../providers/auth/oauth-lifecycle.js';
import {
  collectTokenSnapshot,
  type TokenDaemonSnapshot
} from './token-utils.js';
import {
  buildTokenKey,
  SUPPORTED_OAUTH_PROVIDERS,
  type OAuthProviderId,
  type TokenDescriptor
} from './token-types.js';
import { TokenHistoryStore, type RefreshOutcome } from './history-store.js';
import { ensureLocalTokenPortalEnv } from '../token-portal/local-token-portal.js';

export interface TokenDaemonOptions {
  intervalMs: number;
  refreshAheadMinutes: number;
}

const DEBUG_FLAG = String(process.env.ROUTECODEX_TOKEN_DAEMON_DEBUG || '').trim().toLowerCase();
const DEBUG_ENABLED = DEBUG_FLAG === '1' || DEBUG_FLAG === 'true';

const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_REFRESH_AHEAD_MINUTES = 30;
const MIN_REFRESH_INTERVAL_MS = 5 * 60_000;
const GEMINI_PROVIDER_IDS = new Set(['gemini-cli', 'antigravity']);

export class TokenDaemon {
  private readonly intervalMs: number;
  private readonly refreshAheadMinutes: number;
  private readonly historyStore: TokenHistoryStore;
  private timer: NodeJS.Timeout | null = null;
  private lastRefreshAttempt: Map<string, number> = new Map();

  constructor(options?: Partial<TokenDaemonOptions>) {
    this.intervalMs = options?.intervalMs && options.intervalMs > 0 ? options.intervalMs : DEFAULT_INTERVAL_MS;
    this.refreshAheadMinutes =
      options?.refreshAheadMinutes && options.refreshAheadMinutes > 0
        ? options.refreshAheadMinutes
        : DEFAULT_REFRESH_AHEAD_MINUTES;
    this.historyStore = new TokenHistoryStore();
  }

  async start(): Promise<void> {
    console.log(chalk.blue('ℹ'), 'Token Refresh Daemon started');
    console.log(
      chalk.blue('ℹ'),
      `Polling interval=${Math.round(this.intervalMs / 1000)}s, refreshAhead=${this.refreshAheadMinutes}min`
    );

    // initial tick
    await this.tick();

    this.timer = setInterval(() => {
      void this.tick().catch((error) => {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(chalk.red('✗'), `Token daemon tick failed: ${msg}`);
      });
    }, this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    console.log(chalk.blue('ℹ'), 'Token Refresh Daemon stopped');
  }

  private async tick(): Promise<void> {
    const snapshot = await collectTokenSnapshot();
    const now = snapshot.timestamp;
    const refreshAheadMs = this.refreshAheadMinutes * 60_000;

    for (const providerSnapshot of snapshot.providers) {
      for (const token of providerSnapshot.tokens) {
        this.logDebug(
          `[daemon] evaluate token provider=${token.provider} alias=${token.alias} expires=${token.state.expiresAt ?? 'unknown'} remainingMs=${token.state.msUntilExpiry ?? 'unknown'} refreshToken=${token.state.hasRefreshToken}`
        );
        const key = buildTokenKey(token);
        const { state } = token;
        const expires = state.expiresAt;
        const msLeft = state.msUntilExpiry;
        if (token.alias === 'static') {
          this.logDebug(`[daemon] skip token with static alias provider=${token.provider} file=${token.filePath}`);
          continue;
        }

        // respect per-token norefresh 标记：仅做状态展示，不做自动刷新
        if (state.noRefresh) {
          this.logDebug(`[daemon] skip token (noRefresh=true) alias=${token.alias}`);
          continue;
        }

        if (!state.hasRefreshToken || !expires || msLeft === null) {
          this.logDebug(`[daemon] skip token missing refresh info alias=${token.alias} hasRefresh=${state.hasRefreshToken} expires=${expires}`);
          continue;
        }

        // Only attempt auto-refresh when token is valid/expiring and within refresh window
        if (msLeft > refreshAheadMs) {
          this.logDebug(
            `[daemon] skip token outside refresh window alias=${token.alias} remainingMs=${msLeft} window=${refreshAheadMs}`
          );
          continue;
        }
        if (msLeft <= 0) {
          this.logDebug(`[daemon] token already expired alias=${token.alias} - forcing immediate refresh`);
        }

        const last = this.lastRefreshAttempt.get(key) || 0;
        if (now - last < MIN_REFRESH_INTERVAL_MS) {
          this.logDebug(
            `[daemon] skip token throttle alias=${token.alias} sinceLast=${now - last}ms minInterval=${MIN_REFRESH_INTERVAL_MS}`
          );
          continue;
        }

        this.lastRefreshAttempt.set(key, now);
        await this.trySilentRefresh(token).catch((error) => {
          const msg = error instanceof Error ? error.message : String(error);
          console.error(
            chalk.red('✗'),
            `Auto-refresh failed for ${token.provider} (${token.displayName}): ${msg}`
          );
        });
      }
    }
  }

  private async trySilentRefresh(token: TokenDescriptor): Promise<void> {
    const providerType: OAuthProviderId = token.provider;
    const rawType = `${providerType}-oauth`;

    const tokenMtimeBefore = await getTokenFileMtime(token.filePath);
    if (await this.historyStore.isAutoSuspended(token, tokenMtimeBefore)) {
      this.logDebug(
        `[daemon] skip refresh provider=${providerType} alias=${token.alias} reason=auto-suspended`
      );
      return;
    }

    const portalReady = await this.ensurePortalEnvironment();
    if (!portalReady) {
      this.logDebug(
        `[daemon] skip refresh provider=${providerType} alias=${token.alias} reason=portal-unavailable`
      );
      return;
    }
    const startedAt = Date.now();

    console.log(
      chalk.gray('◉'),
      `Auto-refresh token for ${providerType} (${token.displayName}), file=${token.filePath}`
    );
    this.logDebug(
      `[daemon] trigger refresh provider=${providerType} alias=${token.alias} file=${token.filePath}`
    );

    try {
      await ensureValidOAuthToken(
        providerType,
        {
          type: rawType,
          tokenFile: token.filePath
        } as any,
        {
          openBrowser: true,
          forceReacquireIfRefreshFails: true
        }
      );

      console.log(
        chalk.green('✓'),
        `Token refreshed for ${providerType} (${token.displayName})`
      );
      this.logDebug(`[daemon] refresh success provider=${providerType} alias=${token.alias}`);
      const tokenMtimeAfter = await getTokenFileMtime(token.filePath);
      await this.recordHistoryEvent(token, 'success', startedAt, {
        tokenFileMtime: tokenMtimeAfter
      });
    } catch (error) {
      await this.recordHistoryEvent(token, 'failure', startedAt, {
        error,
        tokenFileMtime: tokenMtimeBefore
      });
      throw error;
    }
  }

  static async getSnapshot(): Promise<TokenDaemonSnapshot> {
    return collectTokenSnapshot();
  }

  static async findTokenBySelector(selector: string): Promise<TokenDescriptor | null> {
    const snapshot = await collectTokenSnapshot();
    const normalized = selector.trim();
    if (!normalized) {
      return null;
    }
    const candidates: TokenDescriptor[] = [];

    for (const providerSnapshot of snapshot.providers) {
      for (const token of providerSnapshot.tokens) {
        const base = token.filePath.split(/[\\/]/).pop() || token.filePath;
        if (token.filePath === normalized || base === normalized || token.filePath.includes(normalized)) {
          candidates.push(token);
        }
      }
    }

    if (candidates.length === 1) {
      return candidates[0];
    }

    if (candidates.length > 1) {
      console.error(chalk.red('✗'), `Selector "${selector}" matched multiple token files:`);
      for (const t of candidates) {
        console.error(
          '  -',
          `[${t.provider}] seq=${t.sequence} alias=${t.alias || 'default'} file=${t.filePath}`
        );
      }
      return null;
    }

    // No direct match; allow provider name selector
    const providerMatch = SUPPORTED_OAUTH_PROVIDERS.find((p) => p === normalized);
    if (providerMatch) {
      const byProvider = snapshot.providers.find((p) => p.provider === providerMatch);
      const first = byProvider?.tokens[0];
      if (first) {
        return first;
      }
      return createSyntheticTokenDescriptor(providerMatch);
    }

    return null;
  }

  private logDebug(message: string): void {
    if (!DEBUG_ENABLED) {
      return;
    }
    console.log(chalk.gray('[token-daemon-debug]'), message);
  }

  private async ensurePortalEnvironment(): Promise<boolean> {
    try {
      await ensureLocalTokenPortalEnv();
      return true;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logDebug(`[daemon] portal init failed: ${msg}`);
      return false;
    }
  }

  private async recordHistoryEvent(
    token: TokenDescriptor,
    outcome: RefreshOutcome,
    startedAt: number,
    meta?: { error?: unknown; tokenFileMtime?: number | null }
  ): Promise<void> {
    try {
      const completedAt = Date.now();
      await this.historyStore.recordRefreshResult(token, outcome, {
        startedAt,
        completedAt,
        durationMs: completedAt - startedAt,
        mode: 'auto',
        error: meta?.error ? (meta.error instanceof Error ? meta.error.message : String(meta.error)) : undefined,
        tokenFileMtime: meta?.tokenFileMtime ?? null
      });
    } catch (historyError) {
      this.logDebug(
        `[daemon] history persistence failed: ${
          historyError instanceof Error ? historyError.message : String(historyError)
        }`
      );
    }
  }
}

async function getTokenFileMtime(filePath: string): Promise<number | null> {
  try {
    const stats = await fs.stat(filePath);
    return stats.mtimeMs;
  } catch {
    return null;
  }
}

function defaultTokenFilePath(provider: OAuthProviderId): string {
  const home = homedir();
  if (provider === 'iflow') {
    return path.join(home, '.iflow', 'oauth_creds.json');
  }
  if (provider === 'qwen') {
    return path.join(home, '.routecodex', 'auth', 'qwen-oauth.json');
  }
  if (GEMINI_PROVIDER_IDS.has(provider)) {
    const file = provider === 'antigravity' ? 'antigravity-oauth.json' : 'gemini-oauth.json';
    return path.join(home, '.routecodex', 'auth', file);
  }
  return path.join(home, '.routecodex', 'auth', `${provider}-oauth-1-default.json`);
}

function createSyntheticTokenDescriptor(provider: OAuthProviderId): TokenDescriptor {
  const filePath = defaultTokenFilePath(provider);
  return {
    provider,
    filePath,
    sequence: 0,
    alias: 'default',
    state: {
      hasAccessToken: false,
      hasRefreshToken: false,
      hasApiKey: false,
      expiresAt: null,
      msUntilExpiry: null,
      status: 'invalid',
      noRefresh: false
    },
    displayName: path.basename(filePath)
  };
}
