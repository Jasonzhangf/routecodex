import type { Application, Request, Response } from 'express';
import type { DaemonAdminRouteOptions } from '../daemon-admin-routes.js';
import { rejectNonLocalOrUnauthorizedAdmin } from '../daemon-admin-routes.js';
import { x7eGate, getGateState } from './routecodex-x7e-gate.js';
import type { ManagerModule } from '../../../../manager/types.js';
import type { QuotaManagerModule, QuotaRecord, QuotaManagerAdapter } from '../../../../manager/modules/quota/index.js';
import type { ProviderQuotaDaemonModule } from '../../../../manager/modules/quota/index.js';
import { loadTokenPortalFingerprintSummary } from '../../../../token-portal/fingerprint-summary.js';
import { findGoogleAccountVerificationIssue } from '../../../../token-daemon/quota-auth-issue.js';
import { createQuotaManagerAdapter } from '../../../../manager/modules/quota/quota-adapter.js';

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
  } catch {
    return {};
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function normalizeGoogleVerifyUrl(rawUrl: unknown): string | null {
  if (typeof rawUrl !== 'string') {
    return null;
  }
  const normalized = rawUrl.trim().replace(/[\"']+$/g, '').replace(/[),.]+$/g, '');
  return normalized || null;
}

function rankGoogleVerifyUrl(url: string | null): number {
  if (!url) {
    return 0;
  }
  const lowered = url.toLowerCase();
  if (lowered.includes('accounts.google.com/signin/continue')) {
    return 3;
  }
  if (lowered.includes('accounts.google.com/')) {
    return 2;
  }
  if (lowered.includes('support.google.com/accounts?p=al_alert')) {
    return 1;
  }
  return 0;
}

function pickBetterGoogleVerifyUrl(currentUrl: unknown, recoveredUrl: string | null): string | null {
  const current = normalizeGoogleVerifyUrl(currentUrl);
  const recovered = normalizeGoogleVerifyUrl(recoveredUrl);
  if (!recovered) {
    return current;
  }
  return rankGoogleVerifyUrl(recovered) > rankGoogleVerifyUrl(current) ? recovered : current;
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
      res.status(500).json({ error: { message } });
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

      // Enrich Antigravity providers with camoufox fingerprint info (per alias).
      const aliases = new Set<string>();
      const verifyAliases = new Set<string>();
      for (const p of entries) {
        const key = typeof p.providerKey === 'string' ? p.providerKey : '';
        if (!key.toLowerCase().startsWith('antigravity.')) {
          continue;
        }
        const parts = key.split('.');
        const alias = parts.length >= 2 ? String(parts[1] || '').trim().toLowerCase() : '';
        if (!alias) {
          continue;
        }
        aliases.add(alias);

        if (isRecord(p.authIssue) && String(p.authIssue.kind || '') === 'google_account_verification') {
          verifyAliases.add(alias);
        }
      }

      const fpByAlias = new Map<string, Awaited<ReturnType<typeof loadTokenPortalFingerprintSummary>> | null>();
      const verifyUrlByAlias = new Map<string, string | null>();
      await Promise.allSettled([
        ...Array.from(aliases).map(async (alias) => {
          const fp = await loadTokenPortalFingerprintSummary('antigravity', alias).catch(() => null);
          fpByAlias.set(alias, fp);
        }),
        ...Array.from(verifyAliases).map(async (alias) => {
          const issue = await findGoogleAccountVerificationIssue('antigravity', alias).catch(() => null);
          verifyUrlByAlias.set(alias, normalizeGoogleVerifyUrl(issue?.url ?? null));
        })
      ]);

      const providers = entries.map((p) => {
        const key = typeof p.providerKey === 'string' ? p.providerKey : '';
        if (!key.toLowerCase().startsWith('antigravity.')) {
          return p;
        }
        const parts = key.split('.');
        const alias = parts.length >= 2 ? String(parts[1] || '').trim().toLowerCase() : '';
        const fp = alias ? fpByAlias.get(alias) : null;

        let authIssue = p.authIssue;
        if (alias && isRecord(authIssue) && String(authIssue.kind || '') === 'google_account_verification') {
          const betterUrl = pickBetterGoogleVerifyUrl(authIssue.url, verifyUrlByAlias.get(alias) ?? null);
          if (betterUrl && betterUrl !== authIssue.url) {
            authIssue = {
              ...authIssue,
              url: betterUrl
            };
          }
        }

        return {
          ...p,
          authIssue,
          fpAlias: alias || null,
          fpProfileId: fp?.profileId || null,
          fpSuffix: fp?.suffix || null,
          fpOs: fp?.os || null,
          fpArch: fp?.arch || null,
          fpPlatform: fp?.navigatorPlatform || null,
          fpOscpu: fp?.navigatorOscpu || null
        };
      });
      res.status(200).json({ updatedAt: Date.now(), providers, ...(unifiedDto ? { schema: 'v2' } : {}) });
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
    const mod = getQuotaModule(options);
    if (!mod || typeof mod.resetProvider !== 'function') {
      res.status(503).json({ error: { message: 'quota module not available', code: 'not_ready' } });
      return;
    }
    try {
      let keys: string[] = [providerKey];
      // Antigravity verification/reauth states are per-alias across many models.
      // Operator "reset" should reset the whole alias so the pool can re-converge quickly.
      if (providerKey.toLowerCase().startsWith('antigravity.')) {
        const parts = providerKey.split('.');
        const alias = parts.length >= 2 ? String(parts[1] || '').trim().toLowerCase() : '';
        const snapshot = mod.getAdminSnapshot();
        if (alias && snapshot && typeof snapshot === 'object') {
          const prefix = `antigravity.${alias}.`;
          const expanded = Object.keys(snapshot).filter((k) => String(k || '').trim().toLowerCase().startsWith(prefix));
          if (expanded.length > 0) {
            keys = expanded;
          }
        }
      }

      let result: unknown = null;
      for (const key of keys) {
        result = await mod.resetProvider(key);
      }
      // If this provider supports external quota refresh (e.g. antigravity), force-refresh immediately
      // so the virtual-router pool state can converge without waiting for the periodic timer.
      let quotaRefresh: unknown = null;
      if (providerKey.toLowerCase().startsWith('antigravity.')) {
        try {
          const quotaModule = getQuotaRefreshModule(options) as unknown as { refreshNow?: () => Promise<unknown> } | null;
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
        ...(keys.length > 1 || quotaRefresh
          ? {
              meta: {
                ...(keys.length > 1 ? { resetKeys: keys.length } : {}),
                ...(quotaRefresh ? { quotaRefresh } : {})
              }
            }
          : {})
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
    const mod = getQuotaModule(options);
    if (!mod || typeof mod.recoverProvider !== 'function') {
      res.status(503).json({ error: { message: 'quota module not available', code: 'not_ready' } });
      return;
    }
    try {
      let keys: string[] = [providerKey];
      if (providerKey.toLowerCase().startsWith('antigravity.')) {
        const parts = providerKey.split('.');
        const alias = parts.length >= 2 ? String(parts[1] || '').trim().toLowerCase() : '';
        const snapshot = mod.getAdminSnapshot();
        if (alias && snapshot && typeof snapshot === 'object') {
          const prefix = `antigravity.${alias}.`;
          const expanded = Object.keys(snapshot).filter((k) => String(k || '').trim().toLowerCase().startsWith(prefix));
          if (expanded.length > 0) {
            keys = expanded;
          }
        }
      }

      let result: unknown = null;
      for (const key of keys) {
        result = await mod.recoverProvider(key);
      }
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
    const runtimeKey = typeof req.query.runtimeKey === 'string' ? req.query.runtimeKey : undefined;
    const providerKey = typeof req.query.providerKey === 'string' ? req.query.providerKey : undefined;
    try {
      const snapshot: Record<string, QuotaRecord> = getQuotaRawSnapshot(options);
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
