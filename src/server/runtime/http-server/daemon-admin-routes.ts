import type { Application, Request, Response } from 'express';
import { registerStatusRoutes } from './daemon-admin/status-handler.js';
import { registerCredentialRoutes } from './daemon-admin/credentials-handler.js';
import { registerQuotaRoutes } from './daemon-admin/quota-handler.js';
import { registerProviderRoutes } from './daemon-admin/providers-handler.js';

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
}

export function isLocalRequest(req: Request): boolean {
  const ip = req.socket?.remoteAddress || '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

export function rejectNonLocal(req: Request, res: Response): boolean {
  if (isLocalRequest(req)) {
    return false;
  }
  res.status(403).json({ error: { message: 'forbidden', code: 'forbidden' } });
  return true;
}

export function registerDaemonAdminRoutes(options: DaemonAdminRouteOptions): void {
  const { app } = options;

  // Daemon / manager 状态
  registerStatusRoutes(app, options);

  // Credentials / token 视图
  registerCredentialRoutes(app, options);

  // Quota / 429 冷却视图
  registerQuotaRoutes(app, options);

  // Providers 运行时 + Config V2 视图
  registerProviderRoutes(app, options);
}
