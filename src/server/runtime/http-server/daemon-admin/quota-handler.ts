import type { Application, Request, Response } from 'express';
import type { DaemonAdminRouteOptions } from '../daemon-admin-routes.js';
import { rejectNonLocalOrUnauthorizedAdmin } from '../daemon-admin-routes.js';
import type { ManagerModule } from '../../../../manager/types.js';
import type { QuotaManagerModule, QuotaRecord } from '../../../../manager/modules/quota/index.js';
import type { ProviderQuotaDaemonModule } from '../../../../manager/modules/quota/index.js';
import { loadTokenPortalFingerprintSummary } from '../../../../token-portal/fingerprint-summary.js';

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

function getProviderQuotaModule(options: DaemonAdminRouteOptions): ProviderQuotaDaemonModule | null {
  const daemon = options.getManagerDaemon() as
    | {
        getModule?: (id: string) => ManagerModule | undefined;
      }
    | null;
  if (!daemon) {
    return null;
  }
  const modQuota = typeof daemon.getModule === 'function'
    ? (daemon.getModule('quota') as ManagerModule | undefined)
    : undefined;
  if (modQuota) {
    return modQuota as unknown as ProviderQuotaDaemonModule;
  }
  const legacy = typeof daemon.getModule === 'function'
    ? (daemon.getModule('provider-quota') as ManagerModule | undefined)
    : undefined;
  return legacy ? (legacy as unknown as ProviderQuotaDaemonModule) : null;
}

export function registerQuotaRoutes(app: Application, options: DaemonAdminRouteOptions): void {
  app.post('/quota/refresh', async (req: Request, res: Response) => {
    if (rejectNonLocalOrUnauthorizedAdmin(req, res)) {return;}
    try {
      const quotaModule = getQuotaModule(options) as
        | (QuotaManagerModule & { refreshNow?: () => Promise<unknown> })
        | null;
      const refreshMod = quotaModule as { refreshNow?: () => Promise<unknown> };
      if (!quotaModule || typeof refreshMod.refreshNow !== 'function') {
        res.status(503).json({ error: { message: 'quota module not available', code: 'not_ready' } });
        return;
      }
      const result = await refreshMod.refreshNow();
      res.status(200).json({ ok: true, action: 'refresh', result });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: { message, code: 'quota_refresh_failed' } });
    }
  });

  app.get('/quota/summary', (req: Request, res: Response) => {
    if (rejectNonLocalOrUnauthorizedAdmin(req, res)) {return;}
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

  app.get('/quota/providers', async (req: Request, res: Response) => {
    if (rejectNonLocalOrUnauthorizedAdmin(req, res)) {return;}
    try {
      const mod = getProviderQuotaModule(options);
      interface AdminSnapshotModule { getAdminSnapshot?: () => Record<string, unknown> }
      const snapshot = mod && typeof (mod as AdminSnapshotModule).getAdminSnapshot === 'function'
        ? (mod as AdminSnapshotModule).getAdminSnapshot?.() ?? {}
        : {};

      const entries = Object.values(snapshot).map((state: unknown) => {
        const record = state && typeof state === 'object' ? (state as Record<string, unknown>) : {};
        const providerKey = typeof record.providerKey === 'string' ? record.providerKey : '';
        return {
          providerKey,
          inPool: Boolean(record.inPool),
          reason: record.reason ?? null,
          authIssue: record.authIssue ?? null,
          authType: record.authType ?? null,
          priorityTier: typeof record.priorityTier === 'number' ? record.priorityTier : null,
          cooldownUntil: record.cooldownUntil ?? null,
          blacklistUntil: record.blacklistUntil ?? null,
          consecutiveErrorCount: typeof record.consecutiveErrorCount === 'number' ? record.consecutiveErrorCount : 0
        };
      });

      // Enrich Antigravity providers with camoufox fingerprint info (per alias).
      const aliases = new Set<string>();
      for (const p of entries) {
        const key = typeof p.providerKey === 'string' ? p.providerKey : '';
        if (!key.toLowerCase().startsWith('antigravity.')) {
          continue;
        }
        const parts = key.split('.');
        const alias = parts.length >= 2 ? String(parts[1] || '').trim().toLowerCase() : '';
        if (alias) {
          aliases.add(alias);
        }
      }

      const fpByAlias = new Map<string, Awaited<ReturnType<typeof loadTokenPortalFingerprintSummary>> | null>();
      if (aliases.size) {
        await Promise.allSettled(
          Array.from(aliases).map(async (alias) => {
            const fp = await loadTokenPortalFingerprintSummary('antigravity', alias).catch(() => null);
            fpByAlias.set(alias, fp);
          })
        );
      }

      const providers = entries.map((p) => {
        const key = typeof p.providerKey === 'string' ? p.providerKey : '';
        if (!key.toLowerCase().startsWith('antigravity.')) {
          return p;
        }
        const parts = key.split('.');
        const alias = parts.length >= 2 ? String(parts[1] || '').trim().toLowerCase() : '';
        const fp = alias ? fpByAlias.get(alias) : null;
        return {
          ...p,
          fpAlias: alias || null,
          fpProfileId: fp?.profileId || null,
          fpSuffix: fp?.suffix || null,
          fpOs: fp?.os || null,
          fpArch: fp?.arch || null,
          fpPlatform: fp?.navigatorPlatform || null,
          fpOscpu: fp?.navigatorOscpu || null
        };
      });
      res.status(200).json({ updatedAt: Date.now(), providers });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: { message } });
    }
  });

  app.post('/quota/providers/:providerKey/reset', async (req: Request, res: Response) => {
    if (rejectNonLocalOrUnauthorizedAdmin(req, res)) {return;}
    const providerKey = String(req.params.providerKey || '').trim();
    if (!providerKey) {
      res.status(400).json({ error: { message: 'providerKey is required', code: 'bad_request' } });
      return;
    }
    const mod = getProviderQuotaModule(options) as
      | (ProviderQuotaDaemonModule & { resetProvider?: (providerKey: string) => Promise<unknown> })
      | null;
    const resetMod = mod as { resetProvider?: (key: string) => Promise<unknown> };
    if (!mod || typeof resetMod.resetProvider !== 'function') {
      res.status(503).json({ error: { message: 'provider-quota module not available', code: 'not_ready' } });
      return;
    }
    try {
      const result = await resetMod.resetProvider(providerKey);
      // If this provider supports external quota refresh (e.g. antigravity), force-refresh immediately
      // so the virtual-router pool state can converge without waiting for the periodic timer.
      let quotaRefresh: unknown = null;
      if (providerKey.toLowerCase().startsWith('antigravity.')) {
        try {
          const quotaModule = getQuotaModule(options) as unknown as { refreshNow?: () => Promise<unknown> } | null;
          if (quotaModule && typeof quotaModule.refreshNow === 'function') {
            quotaRefresh = await quotaModule.refreshNow();
          }
        } catch {
          quotaRefresh = null;
        }
      }
      res.status(200).json({
        ok: true,
        providerKey,
        action: 'reset',
        result,
        ...(quotaRefresh ? { meta: { quotaRefresh } } : {})
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: { message, code: 'quota_provider_reset_failed' } });
    }
  });

  app.post('/quota/providers/:providerKey/recover', async (req: Request, res: Response) => {
    if (rejectNonLocalOrUnauthorizedAdmin(req, res)) {return;}
    const providerKey = String(req.params.providerKey || '').trim();
    if (!providerKey) {
      res.status(400).json({ error: { message: 'providerKey is required', code: 'bad_request' } });
      return;
    }
    const mod = getProviderQuotaModule(options) as
      | (ProviderQuotaDaemonModule & { recoverProvider?: (providerKey: string) => Promise<unknown> })
      | null;
    const recoverMod = mod as { recoverProvider?: (key: string) => Promise<unknown> };
    if (!mod || typeof recoverMod.recoverProvider !== 'function') {
      res.status(503).json({ error: { message: 'provider-quota module not available', code: 'not_ready' } });
      return;
    }
    try {
      const result = await recoverMod.recoverProvider(providerKey);
      res.status(200).json({ ok: true, providerKey, action: 'recover', result });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: { message, code: 'quota_provider_recover_failed' } });
    }
  });

  app.post('/quota/providers/:providerKey/disable', async (req: Request, res: Response) => {
    if (rejectNonLocalOrUnauthorizedAdmin(req, res)) {return;}
    const providerKey = String(req.params.providerKey || '').trim();
    if (!providerKey) {
      res.status(400).json({ error: { message: 'providerKey is required', code: 'bad_request' } });
      return;
    }
    const body = req.body as Record<string, unknown>;
    const modeRaw = typeof body?.mode === 'string' ? String(body.mode).trim().toLowerCase() : 'cooldown';
    const mode = modeRaw === 'blacklist' ? 'blacklist' : 'cooldown';
    const durationMinutesRaw = typeof body?.durationMinutes === 'number' ? body.durationMinutes : Number.NaN;
    const durationMsRaw = typeof body?.durationMs === 'number' ? body.durationMs : Number.NaN;
    const durationMs =
      Number.isFinite(durationMsRaw) && durationMsRaw > 0
        ? Math.floor(durationMsRaw)
        : Number.isFinite(durationMinutesRaw) && durationMinutesRaw > 0
          ? Math.floor(durationMinutesRaw * 60_000)
          : 0;
    if (!durationMs) {
      res.status(400).json({ error: { message: 'durationMs or durationMinutes is required', code: 'bad_request' } });
      return;
    }
    const mod = getProviderQuotaModule(options) as
      | (ProviderQuotaDaemonModule & { disableProvider?: (options: unknown) => Promise<unknown> })
      | null;
    const disableMod = mod as { disableProvider?: (options: unknown) => Promise<unknown> };
    if (!mod || typeof disableMod.disableProvider !== 'function') {
      res.status(503).json({ error: { message: 'provider-quota module not available', code: 'not_ready' } });
      return;
    }
    try {
      const result = await disableMod.disableProvider({ providerKey, mode, durationMs });
      res.status(200).json({ ok: true, providerKey, action: 'disable', mode, durationMs, result });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: { message, code: 'quota_provider_disable_failed' } });
    }
  });

  app.get('/quota/runtime', (req: Request, res: Response) => {
    if (rejectNonLocalOrUnauthorizedAdmin(req, res)) {return;}
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
    if (rejectNonLocalOrUnauthorizedAdmin(req, res)) {return;}
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
