import fs from 'fs/promises';
import path from 'path';
import { homedir } from 'os';
import { resolveRccAuthDir } from '../config/user-data-paths.js';
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
import { buildVirtualRouterInputFromUserConfig } from '../config/virtual-router-types.js';
import { ensureAntigravityTokenProjectMetadata } from '../providers/auth/antigravity-userinfo-helper.js';
import { DEFAULT_TOKEN_DAEMON } from '../constants/index.js';

export interface TokenDaemonOptions {
  intervalMs: number;
  refreshAheadMinutes: number;
  configPath?: string;
}

const DEBUG_FLAG = String(process.env.ROUTECODEX_TOKEN_DAEMON_DEBUG || '').trim().toLowerCase();
const DEBUG_ENABLED = DEBUG_FLAG === '1' || DEBUG_FLAG === 'true';
const LOG_FLAG = String(process.env.ROUTECODEX_TOKEN_DAEMON_LOG || '').trim().toLowerCase();
const LOG_ENABLED = LOG_FLAG === '1' || LOG_FLAG === 'true';

const GEMINI_PROVIDER_IDS = new Set(['gemini-cli', 'antigravity']);
const USER_TIMEOUT_PATTERNS = [
  'device authorization timed out',
  'authorization timed out',
  'authorization flow expired',
  'user did not complete',
  'callback timed out',
  'oauth callback timeout'
];
const camoufoxEnabledCache = new Map<string, boolean>();
const DEFAULT_CAMOUFOX_CACHE_KEY = '__default__';

type CamoufoxOverrideOptions = {
  useCamoufox: boolean;
  autoMode?: string | null;
  devMode?: boolean;
};

function formatUnknownError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack || `${error.name}: ${error.message}`;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function logTokenDaemonNonBlockingError(
  stage: string,
  error: unknown,
  details?: Record<string, unknown>
): void {
  try {
    const suffix = details && Object.keys(details).length > 0 ? ` details=${JSON.stringify(details)}` : '';
    console.warn(`[token-daemon] ${stage} failed (non-blocking): ${formatUnknownError(error)}${suffix}`);
  } catch {
    void 0;
  }
}

function resolveConfiguredProviders(userConfig: unknown): Set<OAuthProviderId> {
  const configured = new Set<OAuthProviderId>();
  const input = buildVirtualRouterInputFromUserConfig((userConfig ?? {}) as Record<string, unknown>);
  const routing = input.routing ?? {};
  const providers = input.providers ?? {};

  const activeProviderIds = new Set<string>();
  if (routing && typeof routing === 'object') {
    for (const pools of Object.values(routing)) {
      if (!Array.isArray(pools)) {
        continue;
      }
      for (const pool of pools) {
        const poolRecord = pool as { targets?: unknown; loadBalancing?: unknown };
        const targets = poolRecord.targets;
        if (!Array.isArray(targets)) {
          // keep walking weights even when targets is absent
        } else {
          for (const target of targets) {
            const providerId = extractProviderIdFromRouteTarget(target);
            if (providerId) {
              activeProviderIds.add(providerId);
            }
          }
        }
        const lb = poolRecord.loadBalancing;
        if (lb && typeof lb === 'object' && !Array.isArray(lb)) {
          const weights = (lb as Record<string, unknown>).weights;
          if (weights && typeof weights === 'object' && !Array.isArray(weights)) {
            for (const weightKey of Object.keys(weights as Record<string, unknown>)) {
              const providerId = extractProviderIdFromRouteTarget(weightKey);
              if (providerId) {
                activeProviderIds.add(providerId);
              }
            }
          }
        }
      }
    }
  }

  if (activeProviderIds.size === 0) {
    return configured;
  }

  const addIfSupported = (idRaw: unknown, enabledRaw: unknown, providerNode?: unknown): void => {
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
    const node = providerNode && typeof providerNode === 'object' ? (providerNode as Record<string, unknown>) : null;
    const authNode = node?.auth && typeof node.auth === 'object' ? (node.auth as Record<string, unknown>) : null;
    const authType = typeof authNode?.type === 'string' ? authNode.type.trim().toLowerCase() : '';
    if (authType === 'deepseek-account') {
      configured.add('deepseek-account');
    }
  };

  for (const [providerKey, value] of Object.entries(providers)) {
    if (!activeProviderIds.has(providerKey.trim().toLowerCase())) {
      continue;
    }
    const v = value as any;
    addIfSupported(v?.id ?? providerKey, v?.enabled, v);
  }

  return configured;
}

function extractProviderIdFromRouteTarget(target: unknown): string | null {
  if (typeof target !== 'string') {
    return null;
  }
  const trimmed = target.trim().toLowerCase();
  if (!trimmed) {
    return null;
  }
  const idx = trimmed.indexOf('.');
  if (idx <= 0) {
    return trimmed;
  }
  return trimmed.slice(0, idx);
}

async function isCamoufoxOauthEnabled(configPath?: string): Promise<boolean> {
  const cacheKey = configPath && configPath.trim() ? configPath.trim() : DEFAULT_CAMOUFOX_CACHE_KEY;
  const cached = camoufoxEnabledCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }
  try {
    const { userConfig } = await loadRouteCodexConfig(configPath);
    const cfg = userConfig as Record<string, unknown>;
    const raw = typeof cfg.oauthBrowser === 'string' ? cfg.oauthBrowser.trim().toLowerCase() : '';
    const enabled = raw === 'camoufox';
    camoufoxEnabledCache.set(cacheKey, enabled);
    return enabled;
  } catch (configError) {
    logTokenDaemonNonBlockingError('isCamoufoxOauthEnabled.loadRouteCodexConfig', configError, {
      configPath: configPath || 'default'
    });
    camoufoxEnabledCache.set(cacheKey, false);
    return false;
  }
}

export class TokenDaemon {
  private readonly intervalMs: number;
  private readonly refreshAheadMinutes: number;
  private readonly historyStore: TokenHistoryStore;
  private readonly configPath?: string;
  private timer: NodeJS.Timeout | null = null;
  private lastRefreshAttempt: Map<string, number> = new Map();
  private antigravityMetadataEnsureTimestamps: Map<string, number> = new Map();
  private sessionStatsByProvider: Map<OAuthProviderId, {
    autoAttempts: number;
    autoSuccesses: number;
    autoFailures: number;
  }> = new Map();

  constructor(options?: Partial<TokenDaemonOptions>) {
    this.intervalMs = options?.intervalMs && options.intervalMs > 0
      ? options.intervalMs
      : DEFAULT_TOKEN_DAEMON.INTERVAL_MS;
    const envRefreshAhead = Number.parseInt(
      String(
        process.env.ROUTECODEX_TOKEN_REFRESH_AHEAD_MIN ||
          process.env.RCC_TOKEN_REFRESH_AHEAD_MIN ||
          ''
      ).trim(),
      10
    );
    const effectiveEnvRefreshAhead =
      Number.isFinite(envRefreshAhead) && envRefreshAhead > 0 ? envRefreshAhead : null;
    this.refreshAheadMinutes =
      options?.refreshAheadMinutes && options.refreshAheadMinutes > 0
        ? options.refreshAheadMinutes
        : effectiveEnvRefreshAhead ?? DEFAULT_TOKEN_DAEMON.REFRESH_AHEAD_MINUTES;
    this.historyStore = new TokenHistoryStore();
    this.configPath = options?.configPath && options.configPath.trim()
      ? options.configPath.trim()
      : undefined;
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
    } catch (shutdownError) {
      logTokenDaemonNonBlockingError('stop.shutdownLocalTokenPortalEnv', shutdownError);
    }
    try {
      await this.printSessionAndHistorySummary();
    } catch (summaryError) {
      logTokenDaemonNonBlockingError('stop.printSessionAndHistorySummary', summaryError);
    }
    if (LOG_ENABLED) {
      console.log(chalk.blue('ℹ'), 'Token Refresh Daemon stopped');
    }
  }

  private async tick(): Promise<void> {
    const snapshot = await collectTokenSnapshot();
    const now = snapshot.timestamp;
    const refreshAheadMs = this.refreshAheadMinutes * 60_000;
    const camoufoxEnabled = await isCamoufoxOauthEnabled(this.configPath);
    const refreshUnconfigured =
      String(process.env.ROUTECODEX_TOKEN_DAEMON_REFRESH_UNCONFIGURED || '').trim() === '1';
    let configuredProviders: Set<OAuthProviderId> | null = null;
    if (!refreshUnconfigured) {
      try {
        const { userConfig } = await loadRouteCodexConfig(this.configPath);
        configuredProviders = resolveConfiguredProviders(userConfig);
      } catch (loadConfigError) {
        logTokenDaemonNonBlockingError('tick.loadRouteCodexConfig', loadConfigError, {
          configPath: this.configPath || 'default'
        });
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
        const needsCamoufoxProfile = camoufoxEnabled;
        if (needsCamoufoxProfile && token.alias) {
          try {
            ensureCamoufoxProfileDir(token.provider, token.alias);
            ensureCamoufoxFingerprintForToken(token.provider, token.alias);
          } catch (prepareCamoufoxError) {
            logTokenDaemonNonBlockingError('tick.ensureCamoufoxProfile', prepareCamoufoxError, {
              provider: token.provider,
              alias: token.alias
            });
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
        if (now - last < DEFAULT_TOKEN_DAEMON.MIN_REFRESH_INTERVAL_MS) {
          this.logDebug(
            `[daemon] skip token throttle alias=${token.alias} sinceLast=${now - last}ms minInterval=${DEFAULT_TOKEN_DAEMON.MIN_REFRESH_INTERVAL_MS}`
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
    if (providerType === 'deepseek-account') {
      this.logDebug(
        `[daemon] skip refresh provider=${providerType} alias=${token.alias} reason=non_refreshable_token_file`
      );
      return;
    }

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
      if (providerType === 'antigravity') {
        await (this as any).runAntigravityAutoAuthorization(token);
      } else if (providerType === 'gemini-cli') {
        await (this as any).runGeminiCliAutoAuthorization(token);
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
      let tokenMtimeAfterFailure: number | null | undefined = tokenMtimeBefore;
      if (isPermanentAuthFailure) {
        await maybeMarkTokenFileNoRefresh(token.filePath);
        tokenMtimeAfterFailure = await getTokenFileMtime(token.filePath);
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
        // Use post-write mtime so daemon's own "noRefresh" write does not clear auto-suspension immediately.
        tokenFileMtime: tokenMtimeAfterFailure,
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

  private async runGeminiCliAutoAuthorization(token: TokenDescriptor): Promise<void> {
    try {
      await this.ensureTokenWithOverrides(token, {
        useCamoufox: true,
        autoMode: 'gemini',
        devMode: false
      });
      return;
    } catch (autoError) {
      const message = autoError instanceof Error ? autoError.message : String(autoError);
      console.warn(
        chalk.yellow('!'),
        `Camoufox auto OAuth failed for gemini-cli (${token.displayName}): ${message}. Falling back to manual mode.`
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
    // Only explicit auto-authorization flows (qwen/gemini-cli/antigravity) opt into interactive mode via Camoufox.
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
    const normalizeProviderSelector = (raw: string): OAuthProviderId | undefined => {
      if (SUPPORTED_OAUTH_PROVIDERS.includes(raw as OAuthProviderId)) {
        return raw as OAuthProviderId;
      }
      if (raw === 'deepseek' || raw === 'deepseek-web') {
        return 'deepseek-account';
      }
      return undefined;
    };
    // Provider selector takes precedence over fuzzy file matching.
    // Example: "deepseek-account" should return the first deepseek token, not
    // trigger a multi-match error because all filenames contain that prefix.
    const explicitProvider = normalizeProviderSelector(normalized);
    if (explicitProvider) {
      const byProvider = snapshot.providers.find((p) => p.provider === explicitProvider);
      const first = byProvider?.tokens[0];
      if (first) {
        return first;
      }
      return createSyntheticTokenDescriptor(explicitProvider);
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
    const providerMatch = normalizeProviderSelector(normalized);
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
      if (now - last < DEFAULT_TOKEN_DAEMON.ANTIGRAVITY_METADATA_ENSURE_INTERVAL_MS) {
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
      } catch (sessionStatsError) {
        logTokenDaemonNonBlockingError('recordHistoryEvent.sessionStatsByProvider', sessionStatsError, {
          provider: token.provider
        });
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
  } catch (markNoRefreshError) {
    logTokenDaemonNonBlockingError('maybeMarkTokenFileNoRefresh', markNoRefreshError, {
      filePath
    });
  }
}

function defaultTokenFilePath(provider: OAuthProviderId): string {
  if (provider === 'qwen') {
    return path.join(resolveRccAuthDir(), 'qwen-oauth-1-default.json');
  }
  if (GEMINI_PROVIDER_IDS.has(provider)) {
    const file = provider === 'antigravity' ? 'antigravity-oauth.json' : 'gemini-oauth.json';
    return path.join(resolveRccAuthDir(), file);
  }
  if (provider === 'deepseek-account') {
    return path.join(resolveRccAuthDir(), 'deepseek-account-default.json');
  }
  return path.join(resolveRccAuthDir(), `${provider}-oauth-1-default.json`);
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
