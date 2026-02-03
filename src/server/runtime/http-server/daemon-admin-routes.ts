import type { Application, Request, Response } from 'express';
import { registerDaemonAuthRoutes } from './daemon-admin/auth-handler.js';
import { registerStatusRoutes } from './daemon-admin/status-handler.js';
import { registerCredentialRoutes } from './daemon-admin/credentials-handler.js';
import { registerQuotaRoutes } from './daemon-admin/quota-handler.js';
import { registerProviderRoutes } from './daemon-admin/providers-handler.js';
import { registerRestartRoutes } from './daemon-admin/restart-handler.js';
import { registerStatsRoutes } from './daemon-admin/stats-handler.js';
import { registerControlRoutes } from './daemon-admin/control-handler.js';
import type { HistoricalStatsSnapshot, StatsSnapshot } from './stats-manager.js';
import { isDaemonSessionAuthenticated } from './daemon-admin/auth-session.js';

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
  getStatsSnapshot?: () => { session: StatsSnapshot; historical: HistoricalStatsSnapshot };
}

export function isLocalRequest(req: Request): boolean {
  const ip = req.socket?.remoteAddress || '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

export function isDaemonAdminAuthenticated(req: Request): boolean {
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
