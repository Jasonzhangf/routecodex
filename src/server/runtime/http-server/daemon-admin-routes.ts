import type { Application, Request, Response } from 'express';
import { registerDaemonAuthRoutes } from './daemon-admin/auth-handler.js';
import { registerStatusRoutes } from './daemon-admin/status-handler.js';
import { registerCredentialRoutes } from './daemon-admin/credentials-handler.js';
import { registerQuotaRoutes } from './daemon-admin/quota-handler.js';
import { registerProviderRoutes } from './daemon-admin/providers-handler.js';
import { registerRestartRoutes } from './daemon-admin/restart-handler.js';
import { registerStatsRoutes } from './daemon-admin/stats-handler.js';
import { registerControlRoutes } from './daemon-admin/control-handler.js';
import type { HistoricalPeriodsSnapshot, HistoricalStatsSnapshot, StatsSnapshot } from './stats-manager.js';
import { isDaemonSessionAuthenticated } from './daemon-admin/auth-session.js';
import { resolveEnvSecretReference } from './middleware.js';

export interface DaemonAdminRouteOptions {
  app: Application;
  /**
   * Lazily resolve ManagerDaemon 实例；可能为 null（例如初始化早期或关闭中）。
   */
  getManagerDaemon: () => unknown | null;
  /**
   * 返回当前 HTTP 服务器标识（通常为 host:port）。
   */
  getServerId: () => string;
  /**
   * 返回当前虚拟路由构建产物；用于 Providers 运行时视图。
   */
  getVirtualRouterArtifacts: () => unknown | null;
  /**
   * Return the config path used to bootstrap this server instance (best-effort).
   * Control-plane mutate uses this path as the single write target.
   */
  getConfigPath?: () => string | null;
  /**
   * Deprecated: daemon-admin 不再使用 apikey 鉴权（改为密码登录）。
   */
  getExpectedApiKey?: () => string | undefined;
  /**
   * Return the bind host used by current HTTP server instance.
   * Daemon-admin auth policy baseline for non-local requests.
   */
  getServerHost?: () => string;
  /**
   * 触发服务重新读取 config 并重建 runtime（不退出进程）。
   */
  restartRuntimeFromDisk?: () => Promise<{
    reloadedAt: number;
    configPath: string;
    warnings?: string[];
  }>;
  /**
   * 返回当前进程的 token/usage 统计（session + historical）。
   * 由 HTTP server 负责组装；daemon-admin 仅展示。
   */
  getStatsSnapshot?: () => {
    session: StatsSnapshot;
    historical: HistoricalStatsSnapshot;
    periods?: HistoricalPeriodsSnapshot;
  };
}

export function isLocalRequest(req: Request): boolean {
  const ip = req.socket?.remoteAddress || '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

const DAEMON_ADMIN_AUTH_REQUIRED_LOCAL_KEY = '__routecodexDaemonAdminAuthRequired';
const DAEMON_ADMIN_APIKEY_CONFIGURED_LOCAL_KEY = '__routecodexDaemonAdminApiKeyConfigured';
const DAEMON_ADMIN_LOCAL_BYPASS_LOCAL_KEY = '__routecodexDaemonAdminLocalBypassEnabled';
const DAEMON_ADMIN_EXPECTED_APIKEY_LOCAL_KEY = '__routecodexDaemonAdminExpectedApiKey';

function normalizeHost(value: unknown): string {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim().toLowerCase();
}

export function isLoopbackBindHost(hostRaw: unknown): boolean {
  const host = normalizeHost(hostRaw);
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '::ffff:127.0.0.1';
}

function setDaemonAdminAuthRequiredForApp(app: Application, required: boolean): void {
  (app.locals as Record<string, unknown>)[DAEMON_ADMIN_AUTH_REQUIRED_LOCAL_KEY] = required;
}

function setDaemonAdminLocalBypassForApp(app: Application, enabled: boolean): void {
  (app.locals as Record<string, unknown>)[DAEMON_ADMIN_LOCAL_BYPASS_LOCAL_KEY] = enabled;
}

function setDaemonAdminExpectedApiKeyForApp(app: Application, apiKey: string): void {
  (app.locals as Record<string, unknown>)[DAEMON_ADMIN_EXPECTED_APIKEY_LOCAL_KEY] = apiKey;
}

function readBoolEnvFlag(keys: string[]): boolean {
  for (const key of keys) {
    const raw = process.env[key];
    if (typeof raw !== 'string') {
      continue;
    }
    const normalized = raw.trim().toLowerCase();
    if (!normalized) {
      continue;
    }
    if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') {
      return true;
    }
    if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') {
      return false;
    }
  }
  return false;
}

export function isDaemonAdminAuthRequired(req: Request): boolean {
  const localBypassRaw = (req.app?.locals as Record<string, unknown> | undefined)?.[DAEMON_ADMIN_LOCAL_BYPASS_LOCAL_KEY];
  const localBypassEnabled = typeof localBypassRaw === 'boolean' ? localBypassRaw : false;
  if (isLocalRequest(req) && localBypassEnabled) {
    return false;
  }
  const raw = (req.app?.locals as Record<string, unknown> | undefined)?.[DAEMON_ADMIN_AUTH_REQUIRED_LOCAL_KEY];
  if (typeof raw === 'boolean') {
    return raw;
  }
  // Fail safe: require auth when policy is unavailable.
  return true;
}

export function isDaemonAdminApiKeyConfigured(req: Request): boolean {
  const raw = (req.app?.locals as Record<string, unknown> | undefined)?.[DAEMON_ADMIN_APIKEY_CONFIGURED_LOCAL_KEY];
  return typeof raw === 'boolean' ? raw : false;
}

function normalizeHeaderValue(value: unknown): string {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim();
}

function extractDaemonAdminApiKeyFromRequest(req: Request): string {
  const direct =
    normalizeHeaderValue(req.header('x-routecodex-api-key'))
    || normalizeHeaderValue(req.header('x-api-key'))
    || normalizeHeaderValue(req.header('x-routecodex-apikey'))
    || normalizeHeaderValue(req.header('api-key'))
    || normalizeHeaderValue(req.header('apikey'));
  if (direct) {
    return direct;
  }
  const auth = normalizeHeaderValue(req.header('authorization'));
  if (!auth) {
    return '';
  }
  const match = auth.match(/^(?:Bearer|ApiKey)\s+(.+)$/i);
  return match ? normalizeHeaderValue(match[1]) : '';
}

function safeEqualApiKey(providedRaw: string, expectedRaw: string): boolean {
  const provided = normalizeHeaderValue(providedRaw);
  const expected = normalizeHeaderValue(expectedRaw);
  if (!provided || !expected) {
    return false;
  }
  return provided === expected;
}

export function isDaemonAdminApiKeyAuthenticated(req: Request): boolean {
  const expected = (req.app?.locals as Record<string, unknown> | undefined)?.[DAEMON_ADMIN_EXPECTED_APIKEY_LOCAL_KEY];
  if (typeof expected !== 'string' || !expected.trim()) {
    return false;
  }
  const provided = extractDaemonAdminApiKeyFromRequest(req);
  return safeEqualApiKey(provided, expected);
}

export function isDaemonAdminAuthenticated(req: Request): boolean {
  if (!isDaemonAdminAuthRequired(req)) {
    return true;
  }
  if (isDaemonAdminApiKeyAuthenticated(req)) {
    return true;
  }
  return isDaemonSessionAuthenticated(req);
}

export function rejectNonLocal(req: Request, res: Response): boolean {
  if (isLocalRequest(req)) {
    return false;
  }
  res.status(403).json({ error: { message: 'forbidden', code: 'forbidden' } });
  return true;
}

export function rejectNonLocalOrUnauthorizedAdmin(
  req: Request,
  res: Response
): boolean {
  if (isDaemonAdminAuthenticated(req)) {
    return false;
  }
  res.status(401).json({ error: { message: 'unauthorized', code: 'unauthorized' } });
  return true;
}

export function registerDaemonAdminRoutes(options: DaemonAdminRouteOptions): void {
  const { app } = options;
  const bindHost = typeof options.getServerHost === 'function' ? options.getServerHost() : '';
  const localBypassEnabled = readBoolEnvFlag([
    'ROUTECODEX_DAEMON_ADMIN_LOCAL_BYPASS',
    'RCC_DAEMON_ADMIN_LOCAL_BYPASS'
  ]);
  const authRequired = localBypassEnabled && isLoopbackBindHost(bindHost) ? false : true;
  setDaemonAdminAuthRequiredForApp(app, authRequired);
  setDaemonAdminLocalBypassForApp(app, localBypassEnabled);
  const expectedApiKeyRaw = typeof options.getExpectedApiKey === 'function' ? options.getExpectedApiKey() : '';
  const resolvedApiKey = resolveEnvSecretReference(typeof expectedApiKeyRaw === 'string' ? expectedApiKeyRaw : '');
  (app.locals as Record<string, unknown>)[DAEMON_ADMIN_APIKEY_CONFIGURED_LOCAL_KEY] =
    resolvedApiKey.ok && Boolean(resolvedApiKey.value);
  setDaemonAdminExpectedApiKeyForApp(app, resolvedApiKey.ok ? resolvedApiKey.value : '');

  // Daemon admin password auth (setup/login/logout/status)
  registerDaemonAuthRoutes(app);

  // Daemon / manager 状态
  registerStatusRoutes(app, options);

  // Token usage / provider stats
  registerStatsRoutes(app, options);

  // Credentials / token 视图
  registerCredentialRoutes(app, options);

  // Quota / 429 冷却视图
  registerQuotaRoutes(app, options);

  // Providers 运行时 + Config V2 视图
  registerProviderRoutes(app, options);

  // Reload / restart runtime (reload config from disk)
  registerRestartRoutes(app, options);

  // Unified control-plane endpoints (single entry for WebUI)
  registerControlRoutes(app, options);
}
