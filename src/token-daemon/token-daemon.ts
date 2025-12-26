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

export interface TokenDaemonOptions {
  intervalMs: number;
  refreshAheadMinutes: number;
}

const DEBUG_FLAG = String(process.env.ROUTECODEX_TOKEN_DAEMON_DEBUG || '').trim().toLowerCase();
const DEBUG_ENABLED = DEBUG_FLAG === '1' || DEBUG_FLAG === 'true';

const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_REFRESH_AHEAD_MINUTES = 30;
const MIN_REFRESH_INTERVAL_MS = 5 * 60_000;

export class TokenDaemon {
  private readonly intervalMs: number;
  private readonly refreshAheadMinutes: number;
  private timer: NodeJS.Timeout | null = null;
  private lastRefreshAttempt: Map<string, number> = new Map();

  constructor(options?: Partial<TokenDaemonOptions>) {
    this.intervalMs = options?.intervalMs && options.intervalMs > 0 ? options.intervalMs : DEFAULT_INTERVAL_MS;
    this.refreshAheadMinutes =
      options?.refreshAheadMinutes && options.refreshAheadMinutes > 0
        ? options.refreshAheadMinutes
        : DEFAULT_REFRESH_AHEAD_MINUTES;
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
        if (msLeft <= 0 || msLeft > refreshAheadMs) {
          this.logDebug(
            `[daemon] skip token outside refresh window alias=${token.alias} remainingMs=${msLeft} window=${refreshAheadMs}`
          );
          continue;
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

    console.log(
      chalk.gray('◉'),
      `Auto-refresh token for ${providerType} (${token.displayName}), file=${token.filePath}`
    );
    this.logDebug(
      `[daemon] trigger refresh provider=${providerType} alias=${token.alias} file=${token.filePath}`
    );

    await ensureValidOAuthToken(
      providerType,
      {
        type: rawType,
        tokenFile: token.filePath
      } as any,
      {
        openBrowser: false,
        forceReacquireIfRefreshFails: false
      }
    );

    console.log(
      chalk.green('✓'),
      `Token refreshed for ${providerType} (${token.displayName})`
    );
    this.logDebug(`[daemon] refresh success provider=${providerType} alias=${token.alias}`);
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
    }

    return null;
  }

  private logDebug(message: string): void {
    if (!DEBUG_ENABLED) {
      return;
    }
    console.log(chalk.gray('[token-daemon-debug]'), message);
  }
}
