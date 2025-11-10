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
    let pipelinesIn: any[] = Array.isArray((pac as any).pipelines) ? (pac as any).pipelines as any[] : [];

    // v2 兼容旧配置：当未生成 pipelines 时，根据 legacy routePools 自动合成最小可用流水线
    // 规则：
    // - 从 routePools 收集被引用的 pipelineId（例如 glm_key1.glm-4.5-air）
    // - 解析 provider 家族（glm/openai/qwen 等）与可能的 keyId/modelId
    // - 为每个 id 生成 provider + compatibility + llmSwitch 模块；provider 基本配置从 virtualrouter.providers 合并
    // - 兼容 keyMappings 与用户配置（~/.routecodex/config.json）的 apiKey 注入
    let synthesizeFromLegacy = false;
    const legacyRoutePools: Record<string, string[]> = (pac as any).routePools || {};
    const referencedLegacyIds = new Set<string>();
    if (!pipelinesIn.length && legacyRoutePools && typeof legacyRoutePools === 'object') {
      for (const ids of Object.values(legacyRoutePools)) {
        (ids || []).forEach((id: string) => { if (typeof id === 'string' && id.trim()) referencedLegacyIds.add(id); });
      }
      if (referencedLegacyIds.size > 0) {
        synthesizeFromLegacy = true;
      }
    }
    // 优先使用合并配置顶层 pipelines（来自用户配置），避免错误的 legacy 解析
    if (!pipelinesIn.length) {
      try {
        const mcPipes = Array.isArray((mc as any).pipelines) ? ((mc as any).pipelines as any[]) : [];
        if (mcPipes.length > 0) {
          pipelinesIn = mcPipes;
          synthesizeFromLegacy = false;
        }
      } catch { /* ignore */ }
    }
    if (!pipelinesIn.length && !synthesizeFromLegacy) {
      // 最后兜底：没有 pipelines，也没有 legacy routePools，则后面默认会再兜底 default 路由
      // 为避免启动失败，这里不再抛错
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
    const sourcePipes = synthesizeFromLegacy ? Array.from(referencedLegacyIds).map((id) => ({ id })) : pipelinesIn;
    for (const p of sourcePipes) {
      const id = String(p.id || '');
      if (!id || seen.has(id)) { continue; }
      const modules = this.asRecord((p as any).modules || {});

      // 解析 provider 家族（legacy id 形如 glm_key1.glm-4.5-air）
      const parseLegacy = (pid: string) => {
        try {
          const out: { provider: string; keyId?: string; modelId?: string } = { provider: 'openai' };
          const us = pid.split('_');
          if (us.length >= 1 && us[0]) { out.provider = us[0]; }
          const dot = pid.indexOf('.');
          if (dot > 0 && dot < pid.length - 1) { out.modelId = pid.slice(dot + 1); }
          if (us.length >= 2) {
            const rest = us[1];
            const dot2 = rest.indexOf('.');
            out.keyId = dot2 > 0 ? rest.slice(0, dot2) : rest;
          }
          return out;
        } catch { return { provider: 'openai' } as const; }
      };

      const legacy = synthesizeFromLegacy ? parseLegacy(id) : null;
      const providerFamilyFromLegacy = synthesizeFromLegacy ? (legacy?.provider || 'openai') : undefined;
      const provider = synthesizeFromLegacy
        ? { type: 'generic-openai-provider', config: {} as Record<string, unknown> }
        : (modules.provider as { type?: string; config?: Record<string, unknown> });
      let llmSwitch = synthesizeFromLegacy
        ? { type: 'llmswitch-conversion-router', config: {} as Record<string, unknown> }
        : (modules.llmSwitch as { type?: string; config?: Record<string, unknown> } | undefined);
      const workflow = synthesizeFromLegacy
        ? undefined
        : (modules.workflow as { type?: string; config?: Record<string, unknown> } | undefined);
      // Compatibility: do not synthesize or guess. Only use when explicitly provided in modules.
      let compatibility = synthesizeFromLegacy
        ? undefined
        : (modules.compatibility as { type?: string; config?: Record<string, unknown> } | undefined);

      // 不进行 provider 级兼容层继承或推断。compatibility 仅来自显式 modules 定义。

      // 校验必要字段（provider）；兼容层可选
      if (!id || !provider?.type) { continue; }
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
          if (Object.keys(r).length) {arr.push(r);}
        };
        const familyFromType = (t: string) => (t || '').toLowerCase().split('-')[0];
        const typeStr = String(synthesizeFromLegacy ? (providerFamilyFromLegacy || 'openai') : ((provider as any).type || ''));
        const family = familyFromType(typeStr);
        const aliasFamily = ((): string | undefined => {
          const t = typeStr.toLowerCase();
          if (t.includes('glm')) {return 'openai';}
          if (t.includes('openai')) {return 'openai';}
          if (t.includes('lmstudio')) {return 'lmstudio';}
          if (t.includes('qwen')) {return 'qwen';}
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
          // Provider级超时：允许从 virtualrouter.providers.* 读取 timeout 注入到 provider 配置
          if (typeof (provCfg as any).timeout !== 'number' && typeof (sysP as any).timeout === 'number') {
            (provCfg as any).timeout = Number((sysP as any).timeout);
          }
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
          // 兼容层继承已在前置阶段完成，这里不再重复
        }
      } catch { /* ignore enrichment errors */ }

      // Respect explicit OAuth: if auth.type === 'oauth', skip API key enrichment entirely
      const authType = String(this.asRecord(provCfg.auth || {}).type || '').toLowerCase();
      const isOAuthAuth = authType === 'oauth';

      // Generic enrichment: if auth still missing but baseUrl is known, try host-based match from providers catalog
      try {
        const needAuth = !isOAuthAuth && !this.asRecord(provCfg.auth || {}).apiKey;
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
      const legacyDefaults = legacy ? { providerId: (legacy as any).provider, modelId: (legacy as any).modelId || 'unknown', keyId: (legacy as any).keyId || 'key1' } : {};
      const metaForId = this.asRecord(routeMeta[id] || (pac as any).routeMeta?.[id] || legacyDefaults);
      const providerIdForKey = typeof metaForId.providerId === 'string' ? metaForId.providerId : undefined;
      const keyIdForPipeline = typeof metaForId.keyId === 'string' ? metaForId.keyId : undefined;
      // Ensure provider config carries the concrete upstream model id and providerType for this pipeline
      try {
        const upstreamModelId = typeof metaForId.modelId === 'string' ? metaForId.modelId : undefined;
        if (upstreamModelId) {
          (provCfg as any).model = upstreamModelId;
          // 模型级超时：若存在，则覆盖 provider 级超时（优先级更高）
          try {
            const topVr = this.asRecord((mc as Record<string, unknown>).virtualrouter || {});
            const topProviders = this.asRecord(topVr.providers || {});
            const provEntry = this.asRecord((topProviders as any)[providerIdForKey || ''] || {});
            const models = this.asRecord(provEntry.models || {});
            const mdl = this.asRecord(models[upstreamModelId] || {});
            const mdlTimeout = typeof (mdl as any).timeout === 'number' ? Number((mdl as any).timeout) : undefined;
            if (typeof mdlTimeout === 'number') {
              (provCfg as any).timeout = mdlTimeout; // model.timeout 覆盖 provider.timeout
            }
          } catch { /* ignore model-level timeout resolution errors */ }
        }
        // 注入 providerType：优先使用 routeMeta.providerId（例如 'lmstudio'），否则回退到 provider.type 的别名映射
        {
          const supported = new Set(['openai', 'glm', 'qwen', 'iflow', 'lmstudio', 'responses']);
          const alias = (s: string): string | '' => {
            const t = (s || '').toLowerCase();
            if (!t) return '' as any;
            if (t.includes('openai') || t.includes('generic-openai') || t.includes('modelscope')) return 'openai';
            if (t.includes('glm') || t.includes('bigmodel') || t.includes('zhipu')) return 'glm';
            if (t.includes('qwen') || t.includes('dashscope') || t.includes('aliyun')) return 'qwen';
            if (t.includes('lmstudio') || t.includes('lm-studio')) return 'lmstudio';
            if (t.includes('iflow')) return 'iflow';
            if (t.includes('responses')) return 'responses';
            return '' as any;
          };
          const fromRoute = String(providerIdForKey || '').toLowerCase();
          const fromProvider = String((provider && provider.type) || '').toLowerCase();
          const cand1 = supported.has(fromRoute) ? fromRoute : alias(fromRoute);
          const cand2 = supported.has(fromProvider) ? fromProvider : alias(fromProvider);
          const finalType = cand1 || cand2 || 'openai';
          (provCfg as any).providerType = finalType;
        }
      } catch { /* ignore */ }
      if (!isOAuthAuth) {
        // First, resolve via keyMappings
        let resolvedKey = resolveKey(providerIdForKey, keyIdForPipeline);
        // If missing or current key looks redacted, try pac.authMappings
        const curAuth = this.asRecord(provCfg.auth || {});
        const curKey = String((curAuth as any).apiKey || '').trim();
        const looksRedacted = curKey === '***REDACTED***' || (curKey && curKey.length <= 16);
        if ((!resolvedKey || looksRedacted) && keyIdForPipeline) {
          const am = (pac as any).authMappings as Record<string, unknown> | undefined;
          const candidate = am && typeof am[keyIdForPipeline] === 'string' ? String(am[keyIdForPipeline]) : undefined;
          if (candidate && candidate.trim()) {
            resolvedKey = candidate.trim();
          }
        }
        // 严禁跨来源兜底读取用户全局配置中的其他provider密钥，避免污染
        if (resolvedKey) {
          const dstAuth = this.asRecord(provCfg.auth || {});
          (dstAuth as any).apiKey = resolvedKey;
          if (!(dstAuth as any).type) { (dstAuth as any).type = 'apikey'; }
          provCfg.auth = dstAuth;
        }
      }

      const fam = 'openai';
      const compatTypeSelected = (compatibility && compatibility.type)
        ? String(compatibility.type)
        : '';
      const compatCfgSelected = this.asRecord((compatibility && compatibility.config) || {});
      const modBlock: Record<string, unknown> = {
        provider: { type: provider.type, config: provCfg },
      };
      // Always attach the standard compatibility module. If user provided a compatibility config,
      // pass it as the module config; otherwise use empty config.
      (modBlock as any).compatibility = { type: 'compatibility', config: compatCfgSelected };

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
          // 默认使用转换路由器（内部根据端点自动选择 codec），统一入口
          modBlock.llmSwitch = { type: 'llmswitch-conversion-router', config: {} };
        }
      } else {
        // 未指定 llmSwitch 时，使用转换路由器
        modBlock.llmSwitch = { type: 'llmswitch-conversion-router', config: {} };
      }
      if (workflow?.type) { modBlock.workflow = { type: workflow.type, config: workflow.config || {} }; }
      // Do not infer provider module type; honor the type already provided in pipeline definition
      // (modBlock.provider already set above)

      pipelines.push({ id, provider: { type: fam || 'openai' }, modules: modBlock, settings: { debugEnabled: true } } as PipelineConfig);
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
      // Build a reverse index for exact matching
      const indexByTriple = new Map<string, string>();
      Object.entries(meta).forEach(([pid, m]) => {
        const k = `${m.providerId}|${m.modelId}|${m.keyId || 'key1'}`;
        if (!indexByTriple.has(k)) indexByTriple.set(k, pid);
      });
      for (const [routeName, targets] of Object.entries(rtAny)) {
        const list = Array.isArray(targets) ? targets : [];
        const ids: string[] = [];
        for (const t of list) {
          // Prefer exact providerId+modelId+keyId match via routeMeta
          const exactKey = `${t.providerId}|${t.modelId}|${t.keyId || 'key1'}`;
          let chosen = indexByTriple.get(exactKey);
          if (!chosen) {
            // Fallback: search pipelines for matching provider model config
            const match = pipelines.find(p => {
              try {
                const prov = (p as any).modules?.provider?.config || {};
                const mdl = String((prov as any).model || '');
                const mid = String(t.modelId || '');
                // Match by configured modelId
                return mdl === mid;
              } catch { return false; }
            });
            if (match) chosen = match.id;
          }
          if (!chosen) {
            // Final fallback by family to keep previous behavior
            const fam = providerFamily(t.providerId);
            const candidates = pipelineByFamily[fam] || [];
            chosen = candidates[0] || pipelines[0]?.id;
          }
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
      // If routePools exist but reference unknown ids, drop invalid ones (legacy 引用将因上面合成被保留)
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

    // 默认超时提升至 300s（可被 provider.timeout 与 model.timeout 覆盖）
    const managerConfig: PipelineManagerConfig = { pipelines, settings: { debugLevel: 'basic', defaultTimeout: 300000, maxRetries: 2 } };
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
          if (keep.length) {filtered[route] = keep;}
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
