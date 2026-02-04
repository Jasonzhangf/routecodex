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
import { ensureLocalTokenPortalEnv, shutdownLocalTokenPortalEnv } from '../token-portal/local-token-portal.js';
import {
  ensureCamoufoxProfileDir,
  ensureCamoufoxFingerprintForToken
} from '../providers/core/config/camoufox-launcher.js';
import { loadRouteCodexConfig } from '../config/routecodex-config-loader.js';
import { ensureAntigravityTokenProjectMetadata } from '../providers/auth/antigravity-userinfo-helper.js';

export interface TokenDaemonOptions {
  intervalMs: number;
  refreshAheadMinutes: number;
}

const DEBUG_FLAG = String(process.env.ROUTECODEX_TOKEN_DAEMON_DEBUG || '').trim().toLowerCase();
const DEBUG_ENABLED = DEBUG_FLAG === '1' || DEBUG_FLAG === 'true';
const LOG_FLAG = String(process.env.ROUTECODEX_TOKEN_DAEMON_LOG || '').trim().toLowerCase();
const LOG_ENABLED = LOG_FLAG === '1' || LOG_FLAG === 'true';

const DEFAULT_INTERVAL_MS = 60_000;
// 默认行为：在到期前 5 分钟进入自动刷新窗口。
const DEFAULT_REFRESH_AHEAD_MINUTES = 5;
const MIN_REFRESH_INTERVAL_MS = 5 * 60_000;
const GEMINI_PROVIDER_IDS = new Set(['gemini-cli', 'antigravity']);
const ANTIGRAVITY_METADATA_ENSURE_INTERVAL_MS = 10 * 60_000;
const USER_TIMEOUT_PATTERNS = [
  'device authorization timed out',
  'authorization timed out',
  'authorization flow expired',
  'user did not complete',
  'callback timed out',
  'oauth callback timeout'
];
let camoufoxEnabledCache: boolean | null = null;

type CamoufoxOverrideOptions = {
  useCamoufox: boolean;
  autoMode?: string | null;
  devMode?: boolean;
};

function resolveConfiguredProviders(userConfig: unknown): Set<OAuthProviderId> {
  const configured = new Set<OAuthProviderId>();
  const cfg = (userConfig ?? {}) as any;
  const vr = (cfg.virtualrouter ?? cfg.virtualRouter ?? cfg.router ?? cfg) as any;
  const providers = vr?.providers;
  const addIfSupported = (idRaw: unknown, enabledRaw: unknown): void => {
    const id = typeof idRaw === 'string' ? idRaw.trim().toLowerCase() : '';
    if (!id) {
      return;
    }
    const enabled = enabledRaw === undefined ? true : Boolean(enabledRaw);
    if (!enabled) {
      return;
    }
    const match = SUPPORTED_OAUTH_PROVIDERS.find((p) => p === id);
    if (match) {
      configured.add(match);
    }
  };
  if (Array.isArray(providers)) {
    for (const p of providers) {
      addIfSupported(p?.id, p?.enabled);
    }
    return configured;
  }
  if (providers && typeof providers === 'object') {
    for (const [key, value] of Object.entries(providers)) {
      const v = value as any;
      addIfSupported(v?.id ?? key, v?.enabled);
    }
  }
  return configured;
}

async function isCamoufoxOauthEnabled(): Promise<boolean> {
  if (camoufoxEnabledCache !== null) {
    return camoufoxEnabledCache;
  }
  try {
    const { userConfig } = await loadRouteCodexConfig();
    const cfg = userConfig as Record<string, unknown>;
    const raw = typeof cfg.oauthBrowser === 'string' ? cfg.oauthBrowser.trim().toLowerCase() : '';
    camoufoxEnabledCache = raw === 'camoufox';
    return camoufoxEnabledCache;
  } catch {
    camoufoxEnabledCache = false;
    return false;
  }
}

export class TokenDaemon {
  private readonly intervalMs: number;
  private readonly refreshAheadMinutes: number;
  private readonly historyStore: TokenHistoryStore;
  private timer: NodeJS.Timeout | null = null;
  private lastRefreshAttempt: Map<string, number> = new Map();
  private antigravityMetadataEnsureTimestamps: Map<string, number> = new Map();
  private sessionStatsByProvider: Map<OAuthProviderId, {
    autoAttempts: number;
    autoSuccesses: number;
    autoFailures: number;
  }> = new Map();

  constructor(options?: Partial<TokenDaemonOptions>) {
    this.intervalMs = options?.intervalMs && options.intervalMs > 0 ? options.intervalMs : DEFAULT_INTERVAL_MS;
    this.refreshAheadMinutes =
      options?.refreshAheadMinutes && options.refreshAheadMinutes > 0
        ? options.refreshAheadMinutes
        : DEFAULT_REFRESH_AHEAD_MINUTES;
    this.historyStore = new TokenHistoryStore();
  }

  async start(): Promise<void> {
    if (LOG_ENABLED) {
      console.log(chalk.blue('ℹ'), 'Token Refresh Daemon started');
      console.log(
        chalk.blue('ℹ'),
        `Polling interval=${Math.round(this.intervalMs / 1000)}s, refreshAhead=${this.refreshAheadMinutes}min`
      );
    }

    // initial tick (best-effort, non-blocking): token refresh must never block server init
    void this.tick().catch((error) => {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(chalk.red('✗'), `Token daemon tick failed: ${msg}`);
    });

    this.timer = setInterval(() => {
      void this.tick().catch((error) => {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(chalk.red('✗'), `Token daemon tick failed: ${msg}`);
      });
    }, this.intervalMs);
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    try {
      await shutdownLocalTokenPortalEnv();
    } catch {
      // best-effort: portal shutdown must never block daemon stop
    }
    try {
      await this.printSessionAndHistorySummary();
    } catch {
      // summary printing must never block shutdown
    }
    if (LOG_ENABLED) {
      console.log(chalk.blue('ℹ'), 'Token Refresh Daemon stopped');
    }
  }

  private async tick(): Promise<void> {
    const snapshot = await collectTokenSnapshot();
    const now = snapshot.timestamp;
    const refreshAheadMs = this.refreshAheadMinutes * 60_000;
    const camoufoxEnabled = await isCamoufoxOauthEnabled();
    const refreshUnconfigured =
      String(process.env.ROUTECODEX_TOKEN_DAEMON_REFRESH_UNCONFIGURED || '').trim() === '1';
    let configuredProviders: Set<OAuthProviderId> | null = null;
    if (!refreshUnconfigured) {
      try {
        const { userConfig } = await loadRouteCodexConfig();
        configuredProviders = resolveConfiguredProviders(userConfig);
      } catch {
        configuredProviders = new Set();
      }
    }

    for (const providerSnapshot of snapshot.providers) {
      for (const token of providerSnapshot.tokens) {
        if (configuredProviders && !configuredProviders.has(token.provider)) {
          this.logDebug(
            `[daemon] skip token provider not configured provider=${token.provider} alias=${token.alias} file=${token.filePath}`
          );
          continue;
        }
        this.logDebug(
          `[daemon] evaluate token provider=${token.provider} alias=${token.alias} expires=${token.state.expiresAt ?? 'unknown'} remainingMs=${token.state.msUntilExpiry ?? 'unknown'} refreshToken=${token.state.hasRefreshToken}`
        );
        if (token.provider === 'antigravity') {
          await this.ensureAntigravityTokenMetadata(token).catch((error) => {
            const msg = error instanceof Error ? error.message : String(error);
            this.logDebug(`[daemon] antigravity metadata ensure failed for ${token.filePath}: ${msg}`);
          });
        }
        const key = buildTokenKey(token);
        const { state } = token;
        const expires = state.expiresAt;
        const msLeft = state.msUntilExpiry;

        // 预生成 Camoufox profile 目录 + fingerprint：按 provider + alias 派生稳定 profileId。
        // iflow 自动认证强制开启 Camoufox，因此即便全局未启用 camoufox 浏览器也要提前准备。
        const needsCamoufoxProfile = camoufoxEnabled || token.provider === 'iflow';
        if (needsCamoufoxProfile && token.alias) {
          try {
            ensureCamoufoxProfileDir(token.provider, token.alias);
            ensureCamoufoxFingerprintForToken(token.provider, token.alias);
          } catch {
            // profile / fingerprint 预生成失败不影响后续 token 刷新逻辑
          }
        }
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

    if (LOG_ENABLED) {
      console.log(
        chalk.gray('◉'),
        `Auto-refresh token for ${providerType} (${token.displayName}), file=${token.filePath}`
      );
    }
    this.logDebug(
      `[daemon] trigger refresh provider=${providerType} alias=${token.alias} file=${token.filePath}`
    );

    try {
      if (providerType === 'iflow') {
        await (this as any).runIflowAutoAuthorization(token);
      } else if (providerType === 'antigravity') {
        await (this as any).runAntigravityAutoAuthorization(token);
      } else if (providerType === 'qwen') {
        await (this as any).runQwenAutoAuthorization(token);
      } else {
        await (this as any).ensureTokenWithOverrides(token);
      }

      if (LOG_ENABLED) {
        console.log(
          chalk.green('✓'),
          `Token refreshed for ${providerType} (${token.displayName})`
        );
      }
      this.logDebug(`[daemon] refresh success provider=${providerType} alias=${token.alias}`);
      const tokenMtimeAfter = await getTokenFileMtime(token.filePath);
      await this.recordHistoryEvent(token, 'success', startedAt, {
        tokenFileMtime: tokenMtimeAfter
      });
      await this.ensureAntigravityTokenMetadata(token, { force: true }).catch((error) => {
        const msg = error instanceof Error ? error.message : String(error);
        this.logDebug(`[daemon] antigravity metadata ensure (post-refresh) failed for ${token.filePath}: ${msg}`);
      });
    } catch (error) {
      const failureInfo = (this as any).classifyRefreshFailure(error);
      const isUserTimeout = failureInfo.isUserTimeout;
      const isPermanentAuthFailure = failureInfo.isPermanentAuthFailure;
      // Permanent refresh failures should not spam logs nor block traffic.
      // Best-effort: persist a per-token "noRefresh" flag so future daemon runs won't keep retrying.
      if (isPermanentAuthFailure) {
        await maybeMarkTokenFileNoRefresh(token.filePath);
      }
      if (LOG_ENABLED || DEBUG_ENABLED) {
        if (isUserTimeout) {
          console.warn(
            chalk.yellow('!'),
            `Auto OAuth timed out waiting for user action (${providerType} ${token.displayName})`
          );
        }
        if (isPermanentAuthFailure) {
          console.warn(
            chalk.yellow('!'),
            `Auto-refresh disabled for ${providerType} (${token.displayName}) due to permanent refresh failure. Re-auth required.`
          );
        }
      }
      await this.recordHistoryEvent(token, 'failure', startedAt, {
        error,
        tokenFileMtime: tokenMtimeBefore,
        countTowardsFailureStreak: isUserTimeout || isPermanentAuthFailure,
        forceAutoSuspend: isUserTimeout,
        autoSuspendImmediately: isPermanentAuthFailure
      });
      // Token daemon must never block or break server traffic:
      // - For "permanent auth failures" we auto-suspend this token and let real requests trigger reauth.
      // - For user timeouts we avoid spamming error logs and retry later (after suspension).
      //
      // NOTE: We intentionally do NOT throw here, otherwise the caller logs a loud
      // "Auto-refresh failed ..." line which is interpreted as a fatal error.
      if (isUserTimeout || isPermanentAuthFailure) {
        this.logDebug(
          `[daemon] refresh suppressed provider=${providerType} alias=${token.alias} permanent=${isPermanentAuthFailure} timeout=${isUserTimeout}`
        );
        return;
      }
      throw error;
    }
  }

  private async runIflowAutoAuthorization(token: TokenDescriptor): Promise<void> {
    try {
      await this.ensureTokenWithOverrides(token, {
        useCamoufox: true,
        autoMode: 'iflow',
        devMode: false
      });
      return;
    } catch (autoError) {
      const message = autoError instanceof Error ? autoError.message : String(autoError);
      console.warn(
        chalk.yellow('!'),
        `Camoufox auto OAuth failed for iflow (${token.displayName}): ${message}. Falling back to headful mode.`
      );
    }
    await this.ensureTokenWithOverrides(token, {
      useCamoufox: true,
      autoMode: null,
      devMode: true
    });
  }

  private async runAntigravityAutoAuthorization(token: TokenDescriptor): Promise<void> {
    try {
      await this.ensureTokenWithOverrides(token, {
        useCamoufox: true,
        autoMode: 'antigravity',
        devMode: false
      });
      return;
    } catch (autoError) {
      const message = autoError instanceof Error ? autoError.message : String(autoError);
      console.warn(
        chalk.yellow('!'),
        `Camoufox auto OAuth failed for antigravity (${token.displayName}): ${message}. Falling back to manual mode.`
      );
    }
    await this.ensureTokenWithOverrides(token, {
      useCamoufox: true,
      autoMode: null,
      devMode: true
    });
  }

  private async runQwenAutoAuthorization(token: TokenDescriptor): Promise<void> {
    try {
      await this.ensureTokenWithOverrides(token, {
        useCamoufox: true,
        autoMode: 'qwen',
        devMode: false
      });
      return;
    } catch (autoError) {
      const message = autoError instanceof Error ? autoError.message : String(autoError);
      console.warn(
        chalk.yellow('!'),
        `Camoufox auto OAuth failed for qwen (${token.displayName}): ${message}. Falling back to manual mode.`
      );
    }
    await this.ensureTokenWithOverrides(token, {
      useCamoufox: true,
      autoMode: null,
      devMode: true
    });
  }

  private async ensureTokenWithOverrides(
    token: TokenDescriptor,
    camoufoxOptions?: CamoufoxOverrideOptions
  ): Promise<void> {
    const providerType: OAuthProviderId = token.provider;
    const rawType = `${providerType}-oauth`;
    const wantsInteractive = Boolean(camoufoxOptions?.useCamoufox);
    // IMPORTANT: Token daemon must not pop interactive OAuth during background refresh.
    // Only explicit auto-authorization flows (iflow/antigravity) opt into interactive mode via Camoufox.
    const runner = () =>
      ensureValidOAuthToken(
        providerType,
        {
          type: rawType,
          tokenFile: token.filePath
        } as any,
        {
          openBrowser: wantsInteractive,
          forceReacquireIfRefreshFails: wantsInteractive,
          forceReauthorize: false
        }
      );
    if (!camoufoxOptions?.useCamoufox) {
      await runner();
      return;
    }
    const restoreEnv = this.applyCamoufoxEnv(camoufoxOptions);
    try {
      await runner();
    } finally {
      restoreEnv();
    }
  }

  private applyCamoufoxEnv(options: CamoufoxOverrideOptions): () => void {
    const prevBrowser = process.env.ROUTECODEX_OAUTH_BROWSER;
    const prevAutoMode = process.env.ROUTECODEX_CAMOUFOX_AUTO_MODE;
    const prevDevMode = process.env.ROUTECODEX_CAMOUFOX_DEV_MODE;

    process.env.ROUTECODEX_OAUTH_BROWSER = 'camoufox';
    if (options.autoMode) {
      process.env.ROUTECODEX_CAMOUFOX_AUTO_MODE = options.autoMode;
    } else {
      delete process.env.ROUTECODEX_CAMOUFOX_AUTO_MODE;
    }
    if (options.devMode) {
      process.env.ROUTECODEX_CAMOUFOX_DEV_MODE = '1';
    } else {
      delete process.env.ROUTECODEX_CAMOUFOX_DEV_MODE;
    }

    return () => {
      this.restoreEnvValue('ROUTECODEX_OAUTH_BROWSER', prevBrowser);
      this.restoreEnvValue('ROUTECODEX_CAMOUFOX_AUTO_MODE', prevAutoMode);
      this.restoreEnvValue('ROUTECODEX_CAMOUFOX_DEV_MODE', prevDevMode);
    };
  }

  private restoreEnvValue(name: string, value: string | undefined): void {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }

  private classifyRefreshFailure(error: unknown): { message: string; isUserTimeout: boolean; isPermanentAuthFailure: boolean } {
    const message = error instanceof Error ? error.message : String(error || '');
    const normalized = message.toLowerCase();
    const isUserTimeout = USER_TIMEOUT_PATTERNS.some((pattern) => normalized.includes(pattern));
    const isPermanentAuthFailure =
      normalized.includes('oauth error: invalid_grant') ||
      normalized.includes('oauth error: invalid_client') ||
      normalized.includes('oauth error: unauthorized_client') ||
      (normalized.includes('oauth error: invalid_request') &&
        (normalized.includes('refresh token') ||
          normalized.includes('refresh_token') ||
          normalized.includes('client_id') ||
          normalized.includes('invalid refresh token')));
    return { message, isUserTimeout, isPermanentAuthFailure };
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

  private async ensureAntigravityTokenMetadata(
    token: TokenDescriptor,
    options?: { force?: boolean }
  ): Promise<void> {
    if (token.provider !== 'antigravity') {
      return;
    }
    const filePath = token.filePath;
    if (!filePath) {
      return;
    }
    const now = Date.now();
    const force = options?.force === true;
    if (!force) {
      const last = this.antigravityMetadataEnsureTimestamps.get(filePath) || 0;
      if (now - last < ANTIGRAVITY_METADATA_ENSURE_INTERVAL_MS) {
        return;
      }
    }
    const ensured = await ensureAntigravityTokenProjectMetadata(filePath);
    if (ensured) {
      this.antigravityMetadataEnsureTimestamps.set(filePath, now);
    } else if (!force) {
      // allow retry soon if ensure failed
      this.antigravityMetadataEnsureTimestamps.delete(filePath);
    }
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
    meta?: {
      error?: unknown;
      tokenFileMtime?: number | null;
      countTowardsFailureStreak?: boolean;
      forceAutoSuspend?: boolean;
      autoSuspendImmediately?: boolean;
    }
  ): Promise<void> {
    try {
      const completedAt = Date.now();
      // update in-memory session stats (per provider, auto mode only for this daemon)
      try {
        const providerType: OAuthProviderId = token.provider;
        const current = this.sessionStatsByProvider.get(providerType) ?? {
          autoAttempts: 0,
          autoSuccesses: 0,
          autoFailures: 0
        };
        current.autoAttempts += 1;
        if (outcome === 'success') {
          current.autoSuccesses += 1;
        } else {
          current.autoFailures += 1;
        }
        this.sessionStatsByProvider.set(providerType, current);
      } catch {
        // best-effort; do not block history persistence
      }

      await this.historyStore.recordRefreshResult(token, outcome, {
        startedAt,
        completedAt,
        durationMs: completedAt - startedAt,
        mode: 'auto',
        error: meta?.error ? (meta.error instanceof Error ? meta.error.message : String(meta.error)) : undefined,
        tokenFileMtime: meta?.tokenFileMtime ?? null,
        countTowardsFailureStreak: meta?.countTowardsFailureStreak,
        forceAutoSuspend: meta?.forceAutoSuspend,
        autoSuspendImmediately: meta?.autoSuspendImmediately
      });
    } catch (historyError) {
      this.logDebug(
        `[daemon] history persistence failed: ${
          historyError instanceof Error ? historyError.message : String(historyError)
        }`
      );
    }
  }

  private async printSessionAndHistorySummary(): Promise<void> {
    // 默认情况下不在控制台输出 Token 管理历史摘要，避免重复打印旧记录。
    // 如需调试，可通过设置 ROUTECODEX_TOKEN_DAEMON_DEBUG=1 启用。
    if (!DEBUG_ENABLED) {
      return;
    }

    const snapshot = await this.historyStore.getSnapshot();
    const history = snapshot.data;
    const aggregatedByProvider = new Map<OAuthProviderId, {
      providersTokens: number;
      totalAttempts: number;
      totalSuccesses: number;
      totalFailures: number;
      suspendedTokens: number;
    }>();

    for (const entry of Object.values(history.tokens)) {
      const provider = entry.provider as OAuthProviderId;
      const current = aggregatedByProvider.get(provider) ?? {
        providersTokens: 0,
        totalAttempts: 0,
        totalSuccesses: 0,
        totalFailures: 0,
        suspendedTokens: 0
      };
      current.providersTokens += 1;
      current.totalAttempts += entry.totalAttempts ?? 0;
      current.totalSuccesses += entry.refreshSuccesses ?? 0;
      current.totalFailures += entry.refreshFailures ?? 0;
      if (entry.autoSuspended) {
        current.suspendedTokens += 1;
      }
      aggregatedByProvider.set(provider, current);
    }

    const providers = new Set<OAuthProviderId>([
      ...this.sessionStatsByProvider.keys(),
      ...aggregatedByProvider.keys()
    ]);

    if (!providers.size) {
      // nothing to report
      return;
    }

    const now = new Date().toISOString();
    const activeProviders: OAuthProviderId[] = [];
    const suspendedProviders: Array<{ provider: OAuthProviderId; suspendedTokens: number }> = [];

    for (const provider of providers) {
      const session = this.sessionStatsByProvider.get(provider);
      const historyAgg = aggregatedByProvider.get(provider);
      if (session && session.autoAttempts > 0) {
        activeProviders.push(provider);
      } else if (historyAgg && historyAgg.totalAttempts > 0) {
        activeProviders.push(provider);
      }
      if (historyAgg && historyAgg.suspendedTokens > 0) {
        suspendedProviders.push({ provider, suspendedTokens: historyAgg.suspendedTokens });
      }
    }

    const activeList = activeProviders.length
      ? Array.from(new Set(activeProviders)).sort().join(',')
      : '-';
    const suspendedList = suspendedProviders.length
      ? suspendedProviders
          .sort((a, b) => a.provider.localeCompare(b.provider))
          .map((entry) => `${entry.provider}(${entry.suspendedTokens})`)
          .join(',')
      : '-';

    console.log(
      chalk.blue('ℹ'),
      `[TokenDaemon] Summary @ ${now}: providers=${activeList}, suspended=${suspendedList}`
    );

    const providerDetails = Array.from(providers).sort();
    for (const provider of providerDetails) {
      const session = this.sessionStatsByProvider.get(provider);
      const historyAgg = aggregatedByProvider.get(provider);
      const sessionAttempts = session?.autoAttempts ?? 0;
      const sessionSuccesses = session?.autoSuccesses ?? 0;
      const sessionFailures = session?.autoFailures ?? 0;
      const historyTokens = historyAgg?.providersTokens ?? 0;
      const historyAttempts = historyAgg?.totalAttempts ?? 0;
      const historySuccesses = historyAgg?.totalSuccesses ?? 0;
      const historyFailures = historyAgg?.totalFailures ?? 0;
      const historySuspended = historyAgg?.suspendedTokens ?? 0;
      if (
        sessionAttempts === 0 &&
        historyAttempts === 0 &&
        historySuspended === 0
      ) {
        continue;
      }
      console.log(
        chalk.blue('ℹ'),
        `[TokenDaemon] ${provider}: session attempts=${sessionAttempts} success=${sessionSuccesses} failure=${sessionFailures} | ` +
          `history tokens=${historyTokens} attempts=${historyAttempts} success=${historySuccesses} failure=${historyFailures} suspended=${historySuspended}`
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

async function maybeMarkTokenFileNoRefresh(filePath: string): Promise<void> {
  try {
    if (!filePath) {
      return;
    }
    const raw = await fs.readFile(filePath, 'utf8').catch(() => '');
    if (!raw.trim()) {
      return;
    }
    const parsed = JSON.parse(raw) as any;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return;
    }
    const already =
      parsed.norefresh === true ||
      parsed.noRefresh === true ||
      (typeof parsed.norefresh === 'string' && parsed.norefresh.trim().toLowerCase() === 'true') ||
      (typeof parsed.noRefresh === 'string' && parsed.noRefresh.trim().toLowerCase() === 'true');
    if (already) {
      return;
    }
    parsed.norefresh = true;
    parsed.noRefresh = true;
    await fs.writeFile(filePath, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
  } catch {
    // best-effort: never block token refresh flow
  }
}

function defaultTokenFilePath(provider: OAuthProviderId): string {
  const home = homedir();
  if (provider === 'iflow') {
    return path.join(home, '.iflow', 'oauth_creds.json');
  }
  if (provider === 'qwen') {
    return path.join(home, '.routecodex', 'auth', 'qwen-oauth-1-default.json');
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
