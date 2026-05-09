import type { Application, Request, Response } from 'express';
import type { DaemonAdminRouteOptions } from '../daemon-admin-routes.js';
import { rejectNonLocalOrUnauthorizedAdmin } from '../daemon-admin-routes.js';
import { x7eGate, getGateState } from './routecodex-x7e-gate.js';
import type { ManagerModule } from '../../../../manager/types.js';
import type { QuotaManagerModule, QuotaRecord, QuotaManagerAdapter } from '../../../../manager/modules/quota/index.js';
import type { ProviderQuotaDaemonModule } from '../../../../manager/modules/quota/index.js';
import { createQuotaManagerAdapter } from '../../../../manager/modules/quota/quota-adapter.js';
import { formatUnknownError } from '../../../../utils/common-utils.js';

const QUOTA_HANDLER_NON_BLOCKING_LOG_THROTTLE_MS = 60_000;
const quotaHandlerNonBlockingLogState = new Map<string, number>();


function logQuotaHandlerNonBlockingError(stage: string, error: unknown, details?: Record<string, unknown>): void {
  const now = Date.now();
  const last = quotaHandlerNonBlockingLogState.get(stage) ?? 0;
  if (now - last < QUOTA_HANDLER_NON_BLOCKING_LOG_THROTTLE_MS) {
    return;
  }
  quotaHandlerNonBlockingLogState.set(stage, now);
  try {
    const detailSuffix = details && Object.keys(details).length > 0 ? ` details=${JSON.stringify(details)}` : '';
    console.warn(`[daemon-admin][quota] ${stage} failed (non-blocking): ${formatUnknownError(error)}${detailSuffix}`);
  } catch {
    // never throw from best-effort logging
  }
}

function getQuotaModule(options: DaemonAdminRouteOptions): QuotaManagerAdapter | null {
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
  const quotaModule = mod as unknown as QuotaManagerModule;
  const providerQuotaModule = typeof daemon.getModule === 'function' ? (daemon.getModule('provider-quota') as ManagerModule | undefined) : undefined;

  const coreLike = quotaModule && typeof (quotaModule as any).getCoreQuotaManager === 'function'
    ? (quotaModule as any).getCoreQuotaManager()
    : null;

  return createQuotaManagerAdapter({
    coreManager: coreLike,
    legacyDaemon: providerQuotaModule as unknown as ProviderQuotaDaemonModule | null,
    quotaRoutingEnabled: true
  });
}

function getQuotaRefreshModule(options: DaemonAdminRouteOptions): (QuotaManagerModule & { refreshNow?: () => Promise<unknown> }) | null {
  const daemon = options.getManagerDaemon() as
    | {
        getModule?: (id: string) => ManagerModule | undefined;
      }
    | null;
  if (!daemon || typeof daemon.getModule !== 'function') {
    return null;
  }
  const mod = daemon.getModule('quota') as ManagerModule | undefined;
  if (!mod) {
    return null;
  }
  return mod as unknown as QuotaManagerModule & { refreshNow?: () => Promise<unknown> };
}

function getQuotaRawSnapshot(options: DaemonAdminRouteOptions): Record<string, QuotaRecord> {
  const daemon = options.getManagerDaemon() as
    | {
        getModule?: (id: string) => ManagerModule | undefined;
      }
    | null;
  if (!daemon || typeof daemon.getModule !== 'function') {
    return {};
  }
  const quotaModule = daemon.getModule('quota') as
    | (ManagerModule & { getRawSnapshot?: () => Record<string, QuotaRecord> })
    | undefined;
  if (!quotaModule || typeof quotaModule.getRawSnapshot !== 'function') {
    return {};
  }
  try {
    return quotaModule.getRawSnapshot() ?? {};
  } catch (error: unknown) {
    logQuotaHandlerNonBlockingError('getQuotaRawSnapshot', error);
    return {};
  }
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
      const quotaModule = getQuotaRefreshModule(options);
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
      const snapshot: Record<string, QuotaRecord> = getQuotaRawSnapshot(options);
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
      res.status(500).json({ error: { message, code: 'internal_error' } });
    }
  });

  app.get('/quota/providers', async (req: Request, res: Response) => {
    if (rejectNonLocalOrUnauthorizedAdmin(req, res)) {return;}
    try {
      const quotaAdapter = getQuotaModule(options);
      const snapshot = quotaAdapter ? quotaAdapter.getAdminSnapshot() : {};

      // Phase 2: Unified control plane DTO
      const unifiedDto = x7eGate.phase2UnifiedControl;

      const entries = Object.values(snapshot).map((state) => {
        const record = state;
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
          consecutiveErrorCount: typeof record.consecutiveErrorCount === 'number' ? record.consecutiveErrorCount : 0,
          ...(unifiedDto ? { schema: 'v2', updatedVia: 'unified_control' } : {})
        };
      });

      res.status(200).json({ updatedAt: Date.now(), providers: entries, ...(unifiedDto ? { schema: 'v2' } : {}) });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: { message, code: 'internal_error' } });
    }
  });

  app.post('/quota/providers/:providerKey/reset', async (req: Request, res: Response) => {
    if (rejectNonLocalOrUnauthorizedAdmin(req, res)) {return;}
    const providerKey = String(req.params.providerKey || '').trim();
    if (!providerKey) {
      res.status(400).json({ error: { message: 'providerKey is required', code: 'bad_request' } });
      return;
    }
    const mod = getQuotaModule(options);
    if (!mod || typeof mod.resetProvider !== 'function') {
      res.status(503).json({ error: { message: 'quota module not available', code: 'not_ready' } });
      return;
    }
    try {
      const result = await mod.resetProvider(providerKey);
      res.status(200).json({ ok: true, providerKey, action: 'reset', result });
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
    const mod = getQuotaModule(options);
    if (!mod || typeof mod.recoverProvider !== 'function') {
      res.status(503).json({ error: { message: 'quota module not available', code: 'not_ready' } });
      return;
    }
    try {
      const result = await mod.recoverProvider(providerKey);
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
    const mod = getQuotaModule(options);
    if (!mod || typeof mod.disableProvider !== 'function') {
      res.status(503).json({ error: { message: 'quota module not available', code: 'not_ready' } });
      return;
    }
    try {
      const result = await mod.disableProvider({ providerKey, mode, durationMs });
      res.status(200).json({ ok: true, providerKey, action: 'disable', mode, durationMs, result });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: { message, code: 'quota_provider_disable_failed' } });
    }
  });

  app.get('/quota/runtime', (req: Request, res: Response) => {
    if (rejectNonLocalOrUnauthorizedAdmin(req, res)) {return;}
    try {
      const snapshot: Record<string, QuotaRecord> = getQuotaRawSnapshot(options);
      const items = Object.entries(snapshot).map(([key, record]) => ({
        key,
        remainingFraction: record.remainingFraction,
        resetAt: record.resetAt,
        fetchedAt: record.fetchedAt
      }));
      res.status(200).json({
        items
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: { message, code: 'internal_error' } });
    }
  });

  app.get('/quota/cooldowns', (req: Request, res: Response) => {
    if (rejectNonLocalOrUnauthorizedAdmin(req, res)) {return;}
    // 目前 VirtualRouter 的 series cooldown 状态未通过稳定 API 暴露；
    // 为避免与核心路由实现交叉，先返回空列表，占位以便前端视图对接。
    res.status(200).json([]);
  });

  // X7E Phase 0: Gate status endpoint for observability and debugging
  app.get('/quota/x7e-gate', (req: Request, res: Response) => {
    if (rejectNonLocalOrUnauthorizedAdmin(req, res)) {return;}
    res.status(200).json({
      gate: getGateState(),
      legacyMode: x7eGate.isLegacyMode(),
      phases: {
        phase0: x7eGate.phase0Enabled,
        phase1: x7eGate.phase1UnifiedQuota,
        phase2: x7eGate.phase2UnifiedControl,
        phase3: x7eGate.phase3ExecutorSeparation,
        phase4: x7eGate.phase4UnifiedLogging
      }
    });
  });
}
