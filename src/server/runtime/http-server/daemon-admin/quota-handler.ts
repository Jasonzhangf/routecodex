import type { Application, Request, Response } from 'express';
import type { DaemonAdminRouteOptions } from '../daemon-admin-routes.js';
import { rejectNonLocalOrUnauthorizedAdmin } from '../daemon-admin-routes.js';
import type { ManagerModule } from '../../../../manager/types.js';
import type { QuotaManagerModule, QuotaRecord } from '../../../../manager/modules/quota/index.js';

function getQuotaModule(options: DaemonAdminRouteOptions): QuotaManagerModule | null {
  const daemon = options.getManagerDaemon() as
    | {
        getModule?: (id: string) => ManagerModule | undefined;
      }
    | null;
  if (!daemon) {
    return null;
  }
  const mod = typeof daemon.getModule === 'function' ? (daemon.getModule('quota') as ManagerModule | undefined) : undefined;
  if (!mod) {
    return null;
  }
  return mod as unknown as QuotaManagerModule;
}

export function registerQuotaRoutes(app: Application, options: DaemonAdminRouteOptions): void {
  app.get('/quota/summary', (req: Request, res: Response) => {
    if (rejectNonLocalOrUnauthorizedAdmin(req, res, options.getExpectedApiKey?.())) return;
    try {
      const quotaModule = getQuotaModule(options);
      const snapshot: Record<string, QuotaRecord> = quotaModule ? quotaModule.getRawSnapshot() : {};
      const records = Object.entries(snapshot).map(([key, value]) => ({
        key,
        remainingFraction: value.remainingFraction,
        resetAt: value.resetAt ?? null,
        fetchedAt: value.fetchedAt
      }));
      res.status(200).json({
        updatedAt: Date.now(),
        records
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: { message } });
    }
  });

  app.get('/quota/runtime', (req: Request, res: Response) => {
    if (rejectNonLocalOrUnauthorizedAdmin(req, res, options.getExpectedApiKey?.())) return;
    const runtimeKey = typeof req.query.runtimeKey === 'string' ? req.query.runtimeKey : undefined;
    const providerKey = typeof req.query.providerKey === 'string' ? req.query.providerKey : undefined;
    try {
      const quotaModule = getQuotaModule(options);
      const snapshot: Record<string, QuotaRecord> = quotaModule ? quotaModule.getRawSnapshot() : {};
      // 当前仅针对 antigravity 语义；snapshot 键格式为 "antigravity://alias/modelId"
      const items: Array<{
        key: string;
        alias: string | null;
        modelId: string | null;
        remainingFraction: number | null;
        resetAt?: number;
        fetchedAt: number;
      }> = [];
      for (const [key, record] of Object.entries(snapshot)) {
        const parsed = parseAntigravityKey(key);
        if (!parsed) {
          continue;
        }
        if (runtimeKey && !runtimeKey.includes(parsed.alias)) {
          continue;
        }
        if (providerKey && !providerKey.includes(parsed.alias)) {
          continue;
        }
        items.push({
          key,
          alias: parsed.alias,
          modelId: parsed.modelId,
          remainingFraction: record.remainingFraction,
          resetAt: record.resetAt,
          fetchedAt: record.fetchedAt
        });
      }
      res.status(200).json({
        runtimeKey: runtimeKey ?? null,
        providerKey: providerKey ?? null,
        items
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: { message } });
    }
  });

  app.get('/quota/cooldowns', (req: Request, res: Response) => {
    if (rejectNonLocalOrUnauthorizedAdmin(req, res, options.getExpectedApiKey?.())) return;
    // 目前 VirtualRouter 的 series cooldown 状态未通过稳定 API 暴露；
    // 为避免与核心路由实现交叉，先返回空列表，占位以便前端视图对接。
    res.status(200).json([]);
  });
}

function parseAntigravityKey(key: string): { alias: string; modelId: string } | null {
  // 形如 "antigravity://alias/modelId"
  const prefix = 'antigravity://';
  if (!key.startsWith(prefix)) {
    return null;
  }
  const rest = key.slice(prefix.length);
  const idx = rest.indexOf('/');
  if (idx <= 0) {
    return null;
  }
  const alias = rest.slice(0, idx);
  const modelId = rest.slice(idx + 1);
  if (!alias || !modelId) {
    return null;
  }
  return { alias, modelId };
}
