import fs from 'fs/promises';
import readline from 'readline';
import path from 'path';
import { homedir } from 'os';
import chalk from 'chalk';
import { ensureValidOAuthToken } from '../providers/auth/oauth-lifecycle.js';
import { TokenDaemon } from './token-daemon.js';
import {
  collectTokenSnapshot,
  readTokenFile,
  evaluateTokenState,
  hasRefreshToken
} from './token-utils.js';
import {
  formatTokenLabel,
  type TokenDescriptor,
  type TokenUsage
} from './token-types.js';
import {
  buildServerAuthSnapshot,
  detectLocalServerInstance,
  type ServerAuthSnapshot
} from './server-utils.js';
import {
  TokenHistoryStore,
  TOKEN_HISTORY_FILE,
  type RefreshOutcome
} from './history-store.js';
import { ensureLocalTokenPortalEnv, shutdownLocalTokenPortalEnv } from '../token-portal/local-token-portal.js';
import { shutdownCamoufoxLaunchers } from '../providers/core/config/camoufox-launcher.js';
import { loadRouteCodexConfig } from '../config/routecodex-config-loader.js';

export { TokenDaemon };

const historyStore = new TokenHistoryStore();

async function cleanupInteractiveOAuthArtifacts(): Promise<void> {
  try {
    await shutdownCamoufoxLaunchers();
  } catch {
    // ignore cleanup errors
  }
  try {
    await shutdownLocalTokenPortalEnv();
  } catch {
    // ignore cleanup errors
  }
}

// --- shared helpers ---

function normalizeTokenFilePath(p: string): string {
  const expanded = p.startsWith('~/') ? p.replace(/^~\//, `${homedir()}/`) : p;
  return path.resolve(expanded);
}

function computeTokenUsageForServer(
  token: TokenDescriptor,
  serverSnapshot: ServerAuthSnapshot | null
): TokenUsage[] {
  if (!serverSnapshot) {
    return [];
  }
  const normalizedTokenPath = normalizeTokenFilePath(token.filePath);
  const usages: TokenUsage[] = [];
  for (const p of serverSnapshot.providers) {
    if (p.auth.kind !== 'oauth' || !p.auth.tokenFile) {
      continue;
    }
    const authPath = normalizeTokenFilePath(p.auth.tokenFile);
    if (authPath === normalizedTokenPath) {
      usages.push({
        serverId: serverSnapshot.server.id,
        providerId: p.id,
        protocol: p.protocol
      });
    }
  }
  return usages;
}

function formatIso(value?: number): string {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return '-';
  }
  try {
    return new Date(value).toISOString();
  } catch {
    return '-';
  }
}

function formatDuration(ms?: number): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) {
    return '-';
  }
  if (ms < 1000) {
    return `${Math.round(ms)}ms`;
  }
  const seconds = ms / 1000;
  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`;
  }
  return `${(seconds / 60).toFixed(1)}m`;
}

// --- combined status (legacy) ---

export async function printStatus(json = false): Promise<void> {
  const snapshot = await collectTokenSnapshot();
  const serverSnapshot = await buildServerAuthSnapshot();
  const historySnapshot = await historyStore.getSnapshot();

  if (json) {
    console.log(
      JSON.stringify(
        {
          tokens: snapshot,
          servers: serverSnapshot,
          history: historySnapshot.data
        },
        null,
        2
      )
    );
    return;
  }

  const rows: string[] = [];
  rows.push('🌙 Token Refresh Daemon - Snapshot');
  rows.push(`Timestamp: ${new Date(snapshot.timestamp).toISOString()}`);
  rows.push('');
  rows.push('== Tokens ==');
  rows.push('| Provider       | File / Alias                        | Status    | Expires At                | Remaining |');
  rows.push('|----------------|--------------------------------------|-----------|---------------------------|-----------|');

  for (const providerSnapshot of snapshot.providers) {
    for (const token of providerSnapshot.tokens) {
      const label = formatTokenLabel(token);
      const expires = token.state.expiresAt ? new Date(token.state.expiresAt).toISOString() : '-';
      let remaining = '-';
      if (token.state.msUntilExpiry !== null) {
        const minutes = Math.round(token.state.msUntilExpiry / 60_000);
        remaining = `${minutes} min`;
      }
      const status = token.state.status;
      rows.push(
        `| ${providerSnapshot.provider.padEnd(14)} | ${label.padEnd(36)} | ${status.padEnd(
          9
        )} | ${expires.padEnd(25)} | ${remaining.padEnd(9)} |`
      );
    }
  }

  rows.push('');
  rows.push('== Servers ==');
  if (!serverSnapshot) {
    rows.push('(no local server config detected)');
  } else {
    const s = serverSnapshot.server;
    rows.push(`Server: ${s.baseUrl} (${s.status})`);
    rows.push(`Config: ${s.configPath}`);
    rows.push('');
    rows.push('| Provider       | Protocol  | Auth Kind | Details                           |');
    rows.push('|----------------|-----------|-----------|-----------------------------------|');
    for (const p of serverSnapshot.providers) {
      const authKind = p.auth.kind;
      let details = '';
      if (authKind === 'apikey') {
        const src = p.auth.apiKeySource ?? '-';
        details = `source=${src}${  p.auth.apiKeyPreview ? ` value=${p.auth.apiKeyPreview}` : ''}`;
      } else if (authKind === 'oauth') {
        details = `tokenFile=${p.auth.tokenFile ?? '-'}`;
      } else {
        details = '-';
      }
      rows.push(
        `| ${p.id.padEnd(14)} | ${p.protocol.padEnd(9)} | ${authKind.padEnd(9)} | ${details.padEnd(33)} |`
      );
    }
  }

  rows.push('');
  rows.push('== Refresh History ==');
  const historyEntries = Object.values(historySnapshot.data.tokens);
  if (historyEntries.length === 0) {
    rows.push(`(no refresh history yet - stats will be persisted to ${TOKEN_HISTORY_FILE})`);
  } else {
    historyEntries.sort((a, b) => {
      const left = a.lastAttemptAt ?? 0;
      const right = b.lastAttemptAt ?? 0;
      return right - left;
    });
    rows.push(
      '| Provider       | Alias     | Attempts | Success | Failure | Last Result | Last Attempt              | Duration |'
    );
    rows.push(
      '|----------------|-----------|----------|---------|---------|-------------|---------------------------|----------|'
    );
    let hasSuspended = false;
    for (const entry of historyEntries) {
      const lastResultLabel = entry.autoSuspended ? `${entry.lastResult ?? '-'}*` : `${entry.lastResult ?? '-'}`;
      if (entry.autoSuspended) {
        hasSuspended = true;
      }
      rows.push(
        `| ${entry.provider.padEnd(14)} | ${entry.alias.padEnd(9)} | ${String(entry.totalAttempts).padEnd(
          8
        )} | ${String(entry.refreshSuccesses).padEnd(7)} | ${String(entry.refreshFailures).padEnd(
          7
        )} | ${lastResultLabel.padEnd(11)} | ${formatIso(entry.lastAttemptAt).padEnd(
          25
        )} | ${formatDuration(entry.lastDurationMs).padEnd(8)} |`
      );
    }
    rows.push('');
    rows.push(`History file: ${TOKEN_HISTORY_FILE}`);
    if (hasSuspended) {
      rows.push('* auto-refresh suspended after repeated failures; will resume after a new user-triggered token update.');
    }
  }

  console.log(rows.join('\n'));
}

// --- servers view ---

export async function printServers(json = false): Promise<void> {
  const info = await detectLocalServerInstance();
  if (json) {
    console.log(JSON.stringify(info, null, 2));
    return;
  }
  if (!info) {
    console.log('No local RouteCodex server configuration detected');
    return;
  }
  console.log('== Servers ==');
  console.log(`Server: ${info.baseUrl} (${info.status})`);
  console.log(`Config: ${info.configPath}`);
}

// --- providers view ---

export async function printProviders(json = false): Promise<void> {
  const serverSnapshot = await buildServerAuthSnapshot();
  if (json) {
    console.log(JSON.stringify(serverSnapshot, null, 2));
    return;
  }
  if (!serverSnapshot) {
    console.log('No local RouteCodex server configuration detected');
    return;
  }

  const s = serverSnapshot.server;
  const rows: string[] = [];
  rows.push('== Servers ==');
  rows.push(`Server: ${s.baseUrl} (${s.status})`);
  rows.push(`Config: ${s.configPath}`);
  rows.push('');
  rows.push('| Provider       | Protocol  | Auth Kind | Details                           |');
  rows.push('|----------------|-----------|-----------|-----------------------------------|');
  for (const p of serverSnapshot.providers) {
    const authKind = p.auth.kind;
    let details = '';
    if (authKind === 'apikey') {
      const src = p.auth.apiKeySource ?? '-';
      details = `source=${src}${  p.auth.apiKeyPreview ? ` value=${p.auth.apiKeyPreview}` : ''}`;
    } else if (authKind === 'oauth') {
      details = `tokenFile=${p.auth.tokenFile ?? '-'}`;
    } else {
      details = '-';
    }
    rows.push(
      `| ${p.id.padEnd(14)} | ${p.protocol.padEnd(9)} | ${authKind.padEnd(9)} | ${details.padEnd(33)} |`
    );
  }
  console.log(rows.join('\n'));
}

// --- tokens view ---

export async function printTokens(json = false): Promise<void> {
  const snapshot = await collectTokenSnapshot();
  const serverSnapshot = await buildServerAuthSnapshot();

  if (json) {
    const enrichedProviders = snapshot.providers.map((providerSnapshot) => ({
      provider: providerSnapshot.provider,
      tokens: providerSnapshot.tokens.map((token) => ({
        ...token,
        usedBy: computeTokenUsageForServer(token, serverSnapshot)
      }))
    }));
    console.log(
      JSON.stringify(
        {
          timestamp: snapshot.timestamp,
          providers: enrichedProviders
        },
        null,
        2
      )
    );
    return;
  }

  const rows: string[] = [];
  rows.push('== Tokens ==');
  rows.push('| Provider       | File / Alias                        | Status    | Expires At                | Remaining | Used By              |');
  rows.push('|----------------|--------------------------------------|-----------|---------------------------|-----------|----------------------|');

  for (const providerSnapshot of snapshot.providers) {
    for (const token of providerSnapshot.tokens) {
      const label = formatTokenLabel(token);
      const expires = token.state.expiresAt ? new Date(token.state.expiresAt).toISOString() : '-';
      let remaining = '-';
      if (token.state.msUntilExpiry !== null) {
        const minutes = Math.round(token.state.msUntilExpiry / 60_000);
        remaining = `${minutes} min`;
      }
      const status = token.state.status;
      const usages = computeTokenUsageForServer(token, serverSnapshot);
      const usedBy =
        usages.length === 0
          ? '-'
          : usages
              .map((u) => `${u.serverId}:${u.providerId}`)
              .join(',');
      rows.push(
        `| ${providerSnapshot.provider.padEnd(14)} | ${label.padEnd(36)} | ${status.padEnd(
          9
        )} | ${expires.padEnd(25)} | ${remaining.padEnd(9)} | ${usedBy.padEnd(20)} |`
      );
    }
  }

  console.log(rows.join('\n'));
}

type InteractiveRefreshOptions = {
  force?: boolean;
};

function configHasProviderId(userConfig: unknown, providerId: string): boolean {
  const id = providerId.trim().toLowerCase();
  if (!id) {
    return false;
  }
  const cfg = (userConfig ?? {}) as any;
  const vr = (cfg.virtualrouter ?? cfg.virtualRouter ?? cfg.router ?? cfg) as any;
  const providers = vr?.providers;
  if (Array.isArray(providers)) {
    return providers.some((p: any) => String(p?.id || '').trim().toLowerCase() === id);
  }
  if (providers && typeof providers === 'object') {
    return Object.entries(providers).some(([key, value]) => {
      const v = value as any;
      const pid = String(v?.id ?? key ?? '').trim().toLowerCase();
      return pid === id;
    });
  }
  return false;
}

export async function interactiveRefresh(selector: string, options: InteractiveRefreshOptions = {}): Promise<void> {
  const token = await TokenDaemon.findTokenBySelector(selector);
  if (!token) {
    console.error(chalk.red('✗'), `No token found for selector: ${selector}`);
    return;
  }
  if (token.alias === 'static') {
    console.error(
      chalk.red('✗'),
      'Token with alias "static" is read-only. Please create a new token with a different alias to re-authenticate.'
    );
    return;
  }

  const label = formatTokenLabel(token);
  const force = Boolean(options?.force);
  if (!force) {
    // If the token is still valid and not close to expiry, avoid repeatedly forcing the user
    // into interactive OAuth flow (this looks like "infinite reauth" to users).
    const msLeft = token.state.msUntilExpiry;
    const status = token.state.status;
    const safeWindowMs = 10 * 60_000;
    if (status === 'valid' && (msLeft === null || msLeft > safeWindowMs)) {
      console.log(chalk.green('✓'), `Token is still valid; skip interactive OAuth (${label})`);
      // Still provide a hint when qwen token exists but user config has no qwen provider.
      if (token.provider === 'qwen') {
        try {
          const { userConfig } = await loadRouteCodexConfig();
          if (!configHasProviderId(userConfig, 'qwen')) {
            console.warn(
              chalk.yellow('⚠'),
              'Your user config has no "qwen" provider entry. This token will not be used until you add a qwen provider.'
            );
          }
        } catch {
          // ignore config load failures
        }
      }
      return;
    }
  }

  console.log('');
  console.log(
    chalk.yellow('⚠'),
    force ? '即将为以下 Token 打开浏览器进行 OAuth 重新授权:' : '即将为以下 Token 执行 OAuth 刷新（必要时打开浏览器）:'
  );
  console.log(`  Provider : ${token.provider}`);
  console.log(`  Sequence : ${token.sequence}`);
  console.log(`  Alias    : ${token.alias || 'default'}`);
  console.log(`  File     : ${token.filePath}`);
  console.log(`  显示名称 : ${label}`);
  console.log(`  Status   : ${token.state.status}`);
  console.log('');

  const autoConfirm = String(process.env.ROUTECODEX_OAUTH_AUTO_CONFIRM || '0') === '1';
  if (!autoConfirm) {
    const proceed = await askYesNo(force ? '继续并打开浏览器进行重新授权吗？ (y/N) ' : '继续（必要时打开浏览器）进行刷新吗？ (y/N) ');
    if (!proceed) {
      console.log(chalk.blue('ℹ'), '已取消重新认证');
      return;
    }
  }

  // Ensure user config is loaded so that global OAuth settings (e.g. oauthBrowser=camoufox)
  // are applied to process.env before triggering the OAuth flow.
  try {
    await loadRouteCodexConfig();
  } catch {
    // best-effort: failure to load config should not block interactive re-auth;
    // in that case, OAuth will fall back to default browser behavior.
  }
  // If token exists but config doesn't reference the provider, users will keep reauthing without effect.
  if (token.provider === 'qwen') {
    try {
      const { userConfig } = await loadRouteCodexConfig();
      if (!configHasProviderId(userConfig, 'qwen')) {
        console.warn(
          chalk.yellow('⚠'),
          'Your user config has no "qwen" provider entry. This token will not be used until you add a qwen provider.'
        );
      }
    } catch {
      // ignore
    }
  }

  const providerType = token.provider;
  const rawType = `${providerType}-oauth`;

  console.log(chalk.blue('ℹ'), force ? '正在启动 OAuth 重新授权流程，请在浏览器中完成登录...' : '正在尝试刷新 Token（必要时会打开浏览器）...');
  const tokenMtimeBefore = await getTokenFileMtime(token.filePath);
  const startedAt = Date.now();
  const prevCamoufoxAutoMode = process.env.ROUTECODEX_CAMOUFOX_AUTO_MODE;
  const prevDevMode = process.env.ROUTECODEX_CAMOUFOX_DEV_MODE;
  try {
    await ensureLocalTokenPortalEnv();
    // CLI-driven interactive refresh should be visible to users by default.
    // This avoids the confusing "waiting for callback" hang when Camoufox automation runs headless
    // but the user expects to complete login/2FA/verification.
    if (!process.env.ROUTECODEX_CAMOUFOX_DEV_MODE) {
      process.env.ROUTECODEX_CAMOUFOX_DEV_MODE = '1';
    }
    // Qwen: default to Camoufox auto mode so the authorize page Confirm button can be clicked automatically.
    // This avoids users getting stuck at the post-portal confirm screen when using `routecodex oauth <qwen-token>`.
    if (providerType === 'qwen') {
      process.env.ROUTECODEX_CAMOUFOX_AUTO_MODE = 'qwen';
    }
    const runEnsure = async () =>
      ensureValidOAuthToken(
        providerType,
        {
          type: rawType,
          tokenFile: token.filePath
        } as any,
        {
          openBrowser: true,
          forceReauthorize: force,
          forceReacquireIfRefreshFails: true
        }
      );

    const autoModeAtStart = String(process.env.ROUTECODEX_CAMOUFOX_AUTO_MODE || '').trim();
    try {
      await runEnsure();
    } catch (error) {
      // When Camoufox auto mode fails (selector mismatch / locale / popup differences),
      // immediately fall back to a visible manual flow in the same command invocation.
      if (autoModeAtStart) {
        const msg = error instanceof Error ? error.message : String(error);
        console.warn(
          chalk.yellow('!'),
          `Camoufox auto OAuth failed (${providerType} ${label}, autoMode=${autoModeAtStart}): ${msg}. Falling back to manual mode.`
        );
        delete process.env.ROUTECODEX_CAMOUFOX_AUTO_MODE;
        await runEnsure();
      } else {
        throw error;
      }
    }
    const tokenMtimeAfter = await getTokenFileMtime(token.filePath);
    await recordManualHistory(token, 'success', startedAt, tokenMtimeAfter);
    console.log(chalk.green('✓'), '认证完成，Token 文件已更新');
  } catch (error) {
    await recordManualHistory(token, 'failure', startedAt, tokenMtimeBefore, error);
    throw error;
  } finally {
    if (prevCamoufoxAutoMode === undefined) {
      delete process.env.ROUTECODEX_CAMOUFOX_AUTO_MODE;
    } else {
      process.env.ROUTECODEX_CAMOUFOX_AUTO_MODE = prevCamoufoxAutoMode;
    }
    if (prevDevMode === undefined) {
      delete process.env.ROUTECODEX_CAMOUFOX_DEV_MODE;
    } else {
      process.env.ROUTECODEX_CAMOUFOX_DEV_MODE = prevDevMode;
    }
    await cleanupInteractiveOAuthArtifacts();
  }
}

type OAuthValidateResult = {
  provider: string;
  alias: string;
  filePath: string;
  status: 'ok' | 'needs_reauth' | 'refresh_failed' | 'skipped';
  message?: string;
};

function oauthAuthType(provider: string): string {
  return provider === 'gemini-cli' ? 'gemini-cli-oauth' : `${provider}-oauth`;
}

async function validateSingleToken(token: TokenDescriptor): Promise<OAuthValidateResult> {
  const base = {
    provider: token.provider,
    alias: token.alias || 'default',
    filePath: token.filePath
  };

  if (token.alias === 'static') {
    return { ...base, status: 'skipped', message: 'static alias (read-only)' };
  }

  const raw = await readTokenFile(token.filePath);
  const state = evaluateTokenState(raw, Date.now());

  if (state.noRefresh) {
    return { ...base, status: 'skipped', message: 'norefresh flag set' };
  }

  if (state.status === 'valid') {
    return { ...base, status: 'ok' };
  }

  if (!hasRefreshToken(raw)) {
    return { ...base, status: 'needs_reauth', message: 'missing refresh token' };
  }

  try {
    await ensureValidOAuthToken(
      token.provider,
      {
        type: oauthAuthType(token.provider),
        tokenFile: token.filePath
      } as any,
      {
        openBrowser: false,
        forceReauthorize: false,
        forceReacquireIfRefreshFails: false
      }
    );
    const refreshed = await readTokenFile(token.filePath);
    const nextState = evaluateTokenState(refreshed, Date.now());
    if (nextState.status === 'valid' || nextState.status === 'expiring') {
      return { ...base, status: 'ok' };
    }
    return { ...base, status: 'refresh_failed', message: `status=${nextState.status}` };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error || '');
    return { ...base, status: 'refresh_failed', message: msg };
  }
}

export async function validateOAuthTokens(selector?: string, json = false): Promise<boolean> {
  const targets: TokenDescriptor[] = [];
  if (selector && selector.trim() && selector.trim() !== 'all') {
    const token = await TokenDaemon.findTokenBySelector(selector.trim());
    if (!token) {
      console.error(chalk.red('✗'), `No token found for selector: ${selector}`);
      return false;
    }
    targets.push(token);
  } else {
    const snapshot = await collectTokenSnapshot();
    for (const providerSnapshot of snapshot.providers) {
      for (const token of providerSnapshot.tokens) {
        targets.push(token);
      }
    }
  }

  const results: OAuthValidateResult[] = [];
  for (const token of targets) {
    results.push(await validateSingleToken(token));
  }

  if (json) {
    console.log(JSON.stringify({ results }, null, 2));
    return results.every((r) => r.status === 'ok' || r.status === 'skipped');
  }

  const rows: string[] = [];
  rows.push('== OAuth Token Validation ==');
  rows.push('| Provider       | Alias     | Status         | File                               | Message |');
  rows.push('|----------------|-----------|----------------|------------------------------------|---------|');
  for (const r of results) {
    rows.push(
      `| ${r.provider.padEnd(14)} | ${r.alias.padEnd(9)} | ${r.status.padEnd(14)} | ${r.filePath.padEnd(
        34
      )} | ${String(r.message || '-').slice(0, 60).padEnd(7)} |`
    );
  }
  console.log(rows.join('\n'));

  return results.every((r) => r.status === 'ok' || r.status === 'skipped');
}

async function recordManualHistory(
  token: TokenDescriptor,
  outcome: RefreshOutcome,
  startedAt: number,
  tokenFileMtime: number | null,
  error?: unknown
): Promise<void> {
  try {
    const completedAt = Date.now();
    await historyStore.recordRefreshResult(token, outcome, {
      startedAt,
      completedAt,
      durationMs: completedAt - startedAt,
      mode: 'manual',
      error: error ? (error instanceof Error ? error.message : String(error)) : undefined,
      tokenFileMtime
    });
  } catch {
    // ignore persistence failures for manual refreshes
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

function askYesNo(prompt: string): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      const normalized = String(answer || '').trim().toLowerCase();
      resolve(normalized === 'y' || normalized === 'yes');
    });
  });
}
