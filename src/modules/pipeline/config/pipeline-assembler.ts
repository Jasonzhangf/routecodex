/**
 * Pipeline Assembler (merged-config consumer)
 *
 * Strictly consumes pipeline_assembler.config produced by the configuration engine.
 * No inference or legacy compatibility logic is performed here.
 */

import fs from 'fs/promises';
import path from 'path';
import type { MergedConfig } from '../../../config/merged-config-types.js';
import type { PipelineManagerConfig, PipelineConfig, ModuleConfig } from '../interfaces/pipeline-interfaces.js';
import { PipelineManager } from '../core/pipeline-manager.js';

export interface AssembledPipelines {
  manager: PipelineManager;
  routePools: Record<string, string[]>;
  routeMeta: Record<string, { providerId: string; modelId: string; keyId: string }>;
}

export class PipelineAssembler {
  private static asRecord(v: unknown): Record<string, unknown> {
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  }

  private static validatePc(
    pc: { provider?: { type?: string }; model?: { actualModelId?: string }; llmSwitch?: { type?: string }; compatibility?: { type?: string }; workflow?: { type?: string } },
    context: { routeName: string; targetKey: string }
  ): { ok: boolean; errors: string[] } {
    const errors: string[] = [];
    if (!pc?.provider?.type) { errors.push('provider.type missing'); }
    if (!pc?.model?.actualModelId) { errors.push('model.actualModelId missing'); }
    if (errors.length) {
      console.error(`[PipelineAssembler] INVALID pipeline config for ${context.routeName}/${context.targetKey}: ${errors.join(', ')}`);
      return { ok: false, errors };
    }
    return { ok: true, errors: [] };
  }

  static async assembleFromFile(mergedConfigPath: string): Promise<AssembledPipelines> {
    const abs = mergedConfigPath.startsWith('.') ? path.resolve(process.cwd(), mergedConfigPath) : mergedConfigPath;
    const content = await fs.readFile(abs, 'utf-8');
    const mergedConfig: MergedConfig = JSON.parse(content);
    return this.assemble(mergedConfig);
  }

  static async assemble(mergedConfig: unknown): Promise<AssembledPipelines> {
    const mc = this.asRecord(mergedConfig);
    const pac = this.asRecord(this.asRecord(mc.pipeline_assembler).config);
    const compatCfg = this.asRecord(mc.compatibilityConfig || {});
    const keyMappings = this.asRecord(compatCfg.keyMappings || {});
    const globalKeys = this.asRecord(keyMappings.global || {});
    const providerKeys = this.asRecord(keyMappings.providers || {});
    const pipelinesIn = Array.isArray((pac as any).pipelines) ? (pac as any).pipelines as any[] : [];
    if (!pipelinesIn.length) {
      throw new Error('[PipelineAssembler] No pipelines in pipeline_assembler.config. Ensure config-manager generated pipelines.');
    }

    const pipelines: PipelineConfig[] = [];
    let routePools: Record<string, string[]> = (pac as any).routePools || {};
    let routeMeta: Record<string, { providerId: string; modelId: string; keyId: string }> = (pac as any).routeMeta || {};

    const seen = new Set<string>();
    const resolveKey = (provId: string | undefined, keyId: string | undefined): string | undefined => {
      if (!keyId) { return undefined; }
      const normalize = (val: unknown): string | undefined => {
        if (typeof val === 'string' && val.trim()) { return val.trim(); }
        if (Array.isArray(val)) {
          for (const item of val) {
            if (typeof item === 'string' && item.trim()) { return item.trim(); }
          }
        }
        return undefined;
      };

      const direct = normalize(globalKeys[keyId]);
      if (direct) { return direct; }
      const provMap = this.asRecord(provId ? providerKeys[provId] : undefined);
      const fromProv = normalize(provMap[keyId]);
      if (fromProv) { return fromProv; }
      return undefined;
    };
    for (const p of pipelinesIn) {
      const id = String(p.id || '');
      if (!id || seen.has(id)) { continue; }
      const modules = (p.modules || {}) as Record<string, unknown>;
      const provider = modules.provider as { type?: string; config?: Record<string, unknown> };
      let llmSwitch = modules.llmSwitch as { type?: string; config?: Record<string, unknown> } | undefined;
      const workflow = modules.workflow as { type?: string; config?: Record<string, unknown> } | undefined;
      const compatibility = modules.compatibility as { type?: string; config?: Record<string, unknown> } | undefined;
      if (!id || !provider?.type || !compatibility?.type) { continue; }
      // Enrich llmSwitch config from merged-config virtualrouter if missing
      if (llmSwitch && (!llmSwitch.config || Object.keys(llmSwitch.config || {}).length === 0)) {
        try {
          // Prefer modules.virtualrouter.config.llmSwitch
          let lsCfg: Record<string, unknown> = {};
          try {
            const vrCfg = this.asRecord(this.asRecord(this.asRecord(mc.modules).virtualrouter).config);
            const ls = this.asRecord(vrCfg.llmSwitch || {});
            lsCfg = this.asRecord(ls.config || {});
          } catch { /* ignore */ }
          // Fallback to top-level virtualrouter.llmSwitch
          if (!Object.keys(lsCfg).length) {
            try {
              const topVr = this.asRecord((mc as Record<string, unknown>).virtualrouter || {});
              const topLs = this.asRecord(topVr.llmSwitch || {});
              lsCfg = this.asRecord(topLs.config || {});
            } catch { /* ignore */ }
          }
          if (Object.keys(lsCfg).length > 0) {
            llmSwitch = { type: String((llmSwitch as any).type || 'llmswitch-conversion-router'), config: lsCfg } as any;
          }
        } catch { /* ignore enrichment errors */ }
      }
      const provCfg = this.asRecord(provider.config || {});
      // Normalize provider config field names
      if (provCfg.baseURL && !provCfg.baseUrl) {
        provCfg.baseUrl = provCfg.baseURL as unknown as string;
      }
      // Enrich provider config from merged-config providers if critical fields missing
      try {
        const addIf = (arr: Array<Record<string, unknown>>, obj: unknown) => {
          const r = this.asRecord(obj);
          if (Object.keys(r).length) arr.push(r);
        };
        const familyFromType = (t: string) => (t || '').toLowerCase().split('-')[0];
        const typeStr = String((provider as any).type || '');
        const family = familyFromType(typeStr);
        const aliasFamily = ((): string | undefined => {
          const t = typeStr.toLowerCase();
          if (t.includes('glm')) return 'openai';
          if (t.includes('openai')) return 'openai';
          if (t.includes('lmstudio')) return 'lmstudio';
          if (t.includes('qwen')) return 'qwen';
          return undefined;
        })();

        const sysProvSources: Array<Record<string, unknown>> = [];
        try {
          const topVr = this.asRecord((mc as Record<string, unknown>).virtualrouter || {});
          const topProviders = this.asRecord(topVr.providers || {});
          if (topProviders && typeof topProviders === 'object') {
            addIf(sysProvSources, (topProviders as any)[typeStr]);
            addIf(sysProvSources, (topProviders as any)[family]);
            if (aliasFamily && aliasFamily !== family) {
              addIf(sysProvSources, (topProviders as any)[aliasFamily]);
            }
          }
        } catch { /* ignore */ }
        try {
          const modulesRec = this.asRecord(mc.modules || {});
          const vrCfg = this.asRecord(this.asRecord(modulesRec.virtualrouter).config || {});
          const modProviders = this.asRecord(vrCfg.providers || {});
          if (modProviders && typeof modProviders === 'object') {
            addIf(sysProvSources, (modProviders as any)[typeStr]);
            addIf(sysProvSources, (modProviders as any)[family]);
            if (aliasFamily && aliasFamily !== family) {
              addIf(sysProvSources, (modProviders as any)[aliasFamily]);
            }
          }
        } catch { /* ignore */ }
        for (const sysP of sysProvSources) {
          if (!provCfg.baseUrl && (sysP as any).baseUrl) { provCfg.baseUrl = (sysP as any).baseUrl as string; }
          if (!provCfg.baseUrl && (sysP as any).baseURL) { provCfg.baseUrl = (sysP as any).baseURL as string; }
          // Merge auth: if we already have an auth object, enrich missing fields
          const srcAuth = this.asRecord((sysP as any).auth || {});
          if (!provCfg.auth && Object.keys(srcAuth).length) {
            provCfg.auth = srcAuth as Record<string, unknown>;
          } else if (provCfg.auth) {
            const dstAuth = this.asRecord(provCfg.auth);
            if (!('apiKey' in dstAuth) && (srcAuth as any).apiKey) {
              (dstAuth as any).apiKey = (srcAuth as any).apiKey;
            }
            if (!('type' in dstAuth) && (srcAuth as any).type) {
              (dstAuth as any).type = (srcAuth as any).type;
            }
            provCfg.auth = dstAuth;
          }
          // Some configs store apiKey at top-level
          if (!this.asRecord(provCfg.auth || {}).apiKey && Array.isArray((sysP as any).apiKey) && (sysP as any).apiKey[0]) {
            const dstAuth = this.asRecord(provCfg.auth || {});
            (dstAuth as any).apiKey = (sysP as any).apiKey[0];
            if (!(dstAuth as any).type) { (dstAuth as any).type = 'apikey'; }
            provCfg.auth = dstAuth;
          }
        }
      } catch { /* ignore enrichment errors */ }

      // Generic enrichment: if auth still missing but baseUrl is known, try host-based match from providers catalog
      try {
        const needAuth = !this.asRecord(provCfg.auth || {}).apiKey;
        const base = String((provCfg as any).baseUrl || (provCfg as any).baseURL || '');
        if (needAuth && base) {
          const hostOf = (u: string): string | null => { try { return new URL(u).host; } catch { return null; } };
          const wantHost = hostOf(base);
          if (wantHost) {
            const topVrAll = this.asRecord((mc as Record<string, unknown>).virtualrouter || {});
            const allProviders = this.asRecord(topVrAll.providers || {});
            for (const vv of Object.values(allProviders)) {
              const p = this.asRecord(vv);
              const h = hostOf(String(p.baseUrl || p.baseURL || ''));
              if (h && h === wantHost) {
                const vAuth = this.asRecord(p.auth || {});
                if (vAuth.apiKey && String(vAuth.apiKey as string).trim()) {
                  const dst = this.asRecord(provCfg.auth || {});
                  (dst as any).apiKey = (vAuth.apiKey as string).trim();
                  (dst as any).type = (dst as any).type || 'apikey';
                  provCfg.auth = dst;
                  break;
                }
                if (Array.isArray((p as any).apiKey) && (p as any).apiKey[0]) {
                  const dst = this.asRecord(provCfg.auth || {});
                  (dst as any).apiKey = String((p as any).apiKey[0]).trim();
                  (dst as any).type = (dst as any).type || 'apikey';
                  provCfg.auth = dst;
                  break;
                }
              }
            }
          }
        }
      } catch { /* ignore */ }
      const metaForId = this.asRecord(routeMeta[id] || (pac as any).routeMeta?.[id] || {});
      const providerIdForKey = typeof metaForId.providerId === 'string' ? metaForId.providerId : undefined;
      const keyIdForPipeline = typeof metaForId.keyId === 'string' ? metaForId.keyId : undefined;
      const actualKey = resolveKey(providerIdForKey, keyIdForPipeline);
      if (actualKey) {
        const dstAuth = this.asRecord(provCfg.auth || {});
        (dstAuth as any).apiKey = actualKey;
        if (!(dstAuth as any).type) { (dstAuth as any).type = 'apikey'; }
        provCfg.auth = dstAuth;
      }

      const modBlock: Record<string, unknown> = {
        provider: { type: provider.type, config: provCfg },
        compatibility: { type: compatibility.type, config: compatibility.config || {} },
      };

      const allowedSwitches = new Set([
        'llmswitch-anthropic-openai',
        'llmswitch-openai-openai',
        'llmswitch-response-chat',
        'llmswitch-conversion-router',
        'llmswitch-responses-passthrough',
      ]);

      if (llmSwitch?.type) {
        const normalizedType = String(llmSwitch.type).toLowerCase();
        if (allowedSwitches.has(normalizedType)) {
          modBlock.llmSwitch = {
            type: llmSwitch.type,
            config: llmSwitch.config || {},
          };
        } else {
          modBlock.llmSwitch = { type: 'llmswitch-anthropic-openai', config: {} };
        }
      } else {
        modBlock.llmSwitch = { type: 'llmswitch-anthropic-openai', config: {} };
      }
      if (workflow?.type) { modBlock.workflow = { type: workflow.type, config: workflow.config || {} }; }
      pipelines.push({ id, provider: { type: provider.type }, modules: modBlock, settings: { debugEnabled: true } } as PipelineConfig);
      seen.add(id);
    }

    // Reconcile routePools with available pipelines using routeTargets if present
    const availableIds = new Set(pipelines.map(p => p.id));
    const providerFamily = (s: string | undefined): string => (s || '').toLowerCase().split('-')[0];
    const pipelineByFamily: Record<string, string[]> = {};
    pipelines.forEach(p => {
      const provider = ((p as any).modules?.provider?.type || (p as any).provider?.type || '') as string;
      const fam = providerFamily(provider);
      if (!pipelineByFamily[fam]) { pipelineByFamily[fam] = []; }
      pipelineByFamily[fam].push(p.id);
    });

    const rtAny = (pac as any).routeTargets as Record<string, Array<{ providerId: string; modelId: string; keyId: string }>> | undefined;
    if (rtAny && Object.keys(rtAny).length > 0) {
      const pools: Record<string, string[]> = {};
      const meta: Record<string, { providerId: string; modelId: string; keyId: string }> = { ...routeMeta };
      for (const [routeName, targets] of Object.entries(rtAny)) {
        const list = Array.isArray(targets) ? targets : [];
        const ids: string[] = [];
        for (const t of list) {
          const fam = providerFamily(t.providerId);
          const candidates = pipelineByFamily[fam] || [];
          const chosen = candidates[0] || pipelines[0]?.id;
          if (chosen) {
            ids.push(chosen);
            if (!meta[chosen]) {
              meta[chosen] = { providerId: t.providerId, modelId: t.modelId, keyId: t.keyId };
            }
          }
        }
        pools[routeName] = ids.filter(id => availableIds.has(id));
      }
      // Always override with routeTargets to ensure proper routing
      routePools = pools;
      routeMeta = meta;
    } else {
      // If routePools exist but reference unknown ids, drop invalid ones
      const pools: Record<string, string[]> = {};
      for (const [routeName, ids] of Object.entries(routePools || {})) {
        pools[routeName] = (ids || []).filter(id => availableIds.has(id));
      }
      routePools = pools;
    }

    // Final safeguard: if no valid routePools, create a default route to the first pipeline
    const totalRoutes = Object.values(routePools || {}).reduce((acc, v) => acc + ((v || []).length), 0);
    if ((!routePools || Object.keys(routePools).length === 0) || totalRoutes === 0) {
      if (pipelines.length > 0) {
        const firstId = pipelines[0].id;
        routePools = { default: [firstId] };
        if (!routeMeta[firstId]) {
          routeMeta[firstId] = { providerId: ((pipelines[0] as any).modules?.provider?.type || (pipelines[0] as any).provider?.type || 'openai') as string, modelId: (pipelines[0] as any).modules?.provider?.config?.model || 'unknown', keyId: 'key1' };
        }
      }
    }

    const managerConfig: PipelineManagerConfig = { pipelines, settings: { debugLevel: 'basic', defaultTimeout: 30000, maxRetries: 2 } };
    const dummyErrorCenter: any = { handleError: async () => {}, createContext: () => ({}), getStatistics: () => ({}) };
    const dummyDebugCenter: any = { logDebug: () => {}, logError: () => {}, logModule: () => {}, processDebugEvent: () => {}, getLogs: () => [] };
    const manager = new PipelineManager(managerConfig, dummyErrorCenter, dummyDebugCenter);
    await manager.initialize();

    // Reconcile routePools against actually initialized pipelines (defensive):
    try {
      const mgrAny: any = manager as any;
      const presentIds: string[] = Array.from(mgrAny?.pipelines?.keys?.() || []);
      if (presentIds.length > 0) {
        const present = new Set<string>(presentIds);
        const filtered: Record<string, string[]> = {};
        for (const [route, ids] of Object.entries(routePools || {})) {
          const keep = (ids || []).filter(id => present.has(id));
          if (keep.length) filtered[route] = keep;
        }
        if (!filtered.default || filtered.default.length === 0) {
          filtered.default = presentIds;
        }
        routePools = filtered;
      }
    } catch { /* best-effort; keep original pools if inspection fails */ }

    return { manager, routePools, routeMeta };
  }
}
