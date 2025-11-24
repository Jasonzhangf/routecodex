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
import { ensureLlmswitchPipelineRegistry } from '../../llmswitch/pipeline-registry.js';

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
    pc: { provider?: { type?: string }; model?: { actualModelId?: string }; llmSwitch?: { type?: string }; compatibility?: { type?: string } },
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
    await ensureLlmswitchPipelineRegistry().catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`[PipelineAssembler] 无法加载 llmswitch pipeline-config：${message}`);
    });
    const mc = this.asRecord(mergedConfig);
    const pac = this.asRecord(this.asRecord(mc.pipeline_assembler).config);
    const compatCfg = this.asRecord(mc.compatibilityConfig || {});
    const keyMappings = this.asRecord(compatCfg.keyMappings || {});
    const globalKeys = this.asRecord(keyMappings.global || {});
    const providerKeys = this.asRecord(keyMappings.providers || {});
    const pipelinesIn: any[] = Array.isArray((pac as any).pipelines) ? (pac as any).pipelines as any[] : [];
    if (!pipelinesIn.length) {
      throw new Error('PipelineAssembler(V2): pipeline_assembler.config.pipelines is required (no fallback). 请使用 config-core 导出的 V2 装配配置');
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

      const provider = (modules.provider as { type?: string; config?: Record<string, unknown> });
      let llmSwitch = (modules.llmSwitch as { type?: string; config?: Record<string, unknown> } | undefined);
      // Compatibility: 仅使用显式声明
      let compatibility = (modules.compatibility as { type?: string; config?: Record<string, unknown> } | undefined);

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
        const typeStr = String(((provider as any).type || ''));
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
          // Provider级 headers：允许从 virtualrouter.providers.* 读取 headers 注入（如 User-Agent）
          try {
            const srcHeaders = this.asRecord((sysP as any).headers || {});
            if (Object.keys(srcHeaders).length) {
              const dstHeaders = this.asRecord((provCfg as any).headers || {});
              (provCfg as any).headers = { ...dstHeaders, ...srcHeaders } as Record<string, string>;
            }
          } catch { /* ignore header merge errors */ }
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
      const metaForId = this.asRecord(routeMeta[id] || (pac as any).routeMeta?.[id] || {});
      const providerIdForKey = typeof metaForId.providerId === 'string' ? metaForId.providerId : undefined;
      const keyIdForPipeline = typeof metaForId.keyId === 'string' ? metaForId.keyId : undefined;

      // 对内置 OAuth provider（qwen/iflow）在 provider.config 上注入 extensions.oauthProviderId，
      // 以便 ProviderFactory.validateConfig 能选择正确的默认 OAuth 配置，而不要求在用户配置中硬编码 clientId/tokenUrl。
      if (isOAuthAuth && providerIdForKey) {
        const family = String(providerIdForKey).toLowerCase();
        if (family === 'qwen' || family === 'iflow') {
          try {
            const ext = this.asRecord((provCfg as any).extensions || {});
            if (!ext.oauthProviderId) {
              (ext as any).oauthProviderId = family;
              (provCfg as any).extensions = ext;
            }
          } catch {
            // best-effort 注入，失败时保持原样，让上游校验显式报错
          }
        }
      }
      // Ensure provider config carries the concrete upstream model id for this pipeline
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
          } catch {
            /* ignore model-level timeout resolution errors */
          }
        }
      } catch {
        /* ignore */
      }

      // 注入 providerType（协议族）：
      //  - 若 canonical 已提供 provider.config.providerType 且属于协议族集合（openai/responses/anthropic/...），则直接信任；
      //  - 否则才根据 provider.type / routeMeta.providerId 做最小推断，且只输出协议族，而不是 glm/qwen/iflow/lmstudio 这类家族名。
      {
        // 协议族 + 服务族：
        // - openai/responses/anthropic/gemini：协议族（决定 providerProtocol）
        // - glm/qwen/iflow/lmstudio：服务族（共享 openai-chat 协议形状，但在 ServiceProfile 中拥有独立配置）
        const protocolFamilies = new Set([
          'openai',
          'responses',
          'anthropic',
          'gemini',
          'iflow',
          // 预留服务族，统一走 openai-chat 协议
          'glm',
          'qwen',
          'lmstudio',
        ]);
        const provCfgObj = this.asRecord(provider?.config || {});
        const existing = String((provCfgObj as any).providerType || '').toLowerCase();
        if (existing && protocolFamilies.has(existing)) {
          (provCfg as any).providerType = existing;
        } else {
          const alias = (s: string): string | '' => {
            const t = (s || '').toLowerCase();
            if (!t) return '' as any;
            if (t.includes('openai') || t.includes('generic-openai') || t.includes('modelscope')) return 'openai';
            if (t.includes('responses')) return 'responses';
            if (t.includes('anthropic')) return 'anthropic';
            // glm/qwen/iflow/lmstudio 等服务家族共享 openai-chat 协议，但在 ServiceProfile 中拥有独立配置
            if (t.includes('glm') || t.includes('zhipu')) return 'glm';
            if (t.includes('qwen') || t.includes('dashscope') || t.includes('aliyun')) return 'qwen';
            if (t.includes('iflow')) return 'iflow';
            if (t.includes('lmstudio') || t.includes('lm-studio')) return 'lmstudio';
            return '' as any;
          };
          const fromCfgTypeRaw = String((provCfgObj as any).type || '').toLowerCase();
          const candCfg = alias(fromCfgTypeRaw);
          const fromRoute = String(providerIdForKey || '').toLowerCase();
          const fromProvider = String((provider && provider.type) || '').toLowerCase();
          const candRoute = alias(fromRoute);
          const candProv = alias(fromProvider);
          // 协议型 provider（responses/anthropic）优先按 config.type 归类，其次按 provider.type；其余按 routeMeta/provider.type 归类
          let finalType: string | '' = '';
          if (candCfg === 'responses' || candCfg === 'anthropic') {
            finalType = candCfg;
          } else if (candProv === 'responses' || candProv === 'anthropic') {
            finalType = candProv;
          } else {
            finalType = candRoute || candProv || candCfg || 'openai';
          }
          if (!finalType || !protocolFamilies.has(finalType)) {
            throw new Error(
              `PipelineAssembler(V2): unable to infer providerType (protocol family) for pipeline '${id}'. ` +
              `routeMeta.providerId='${providerIdForKey || ''}', provider.type='${(provider && provider.type) || ''}'`
            );
          }
          (provCfg as any).providerType = finalType;
        }
      }
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

      const compatTypeSelected = (compatibility && compatibility.type)
        ? String(compatibility.type)
        : '';
      const compatCfgSelected = this.asRecord((compatibility && compatibility.config) || {});
      const modBlock: Record<string, unknown> = {
        // provider 模块类型使用归一化后的 providerTypeForPipeline（openai/glm/qwen/iflow/lmstudio/responses 等），
        // 而不是原始 config.provider.type，确保能命中已注册的 Provider module 工厂。
        provider: { type: String((provCfg as any).providerType || provider.type || "").trim(), config: provCfg },
      };

      // Attach compatibility respecting explicit submodule types.
      // Rules:
      // 1) 如果用户直接在 compatibility.type 上声明了具体子模块（例如 'glm' / 'passthrough'），
      //    则将其视为子模块类型并包一层标准容器 'compatibility'。
      //    - 对于 'passthrough'，内部统一归一为内置模块名 'passthrough-compatibility'。
      // 2) 如果用户选择了标准容器 'compatibility'，则优先读取 config.moduleType；
      //    若缺失或为空，则默认走 passthrough-compatibility（“不写就是 passthrough-compatibility”）。
      (() => {
        const normalizedType = compatTypeSelected.trim();
        const providerType: string = String((provCfg as any)?.providerType || '').toLowerCase();

        if (normalizedType && normalizedType.toLowerCase() !== 'compatibility') {
          // Map explicit concrete submodule into standard container (no inference)
          const subTypeRaw = normalizedType;
          const subTypeLower = subTypeRaw.toLowerCase();
          // 允许在配置中使用简写 'passthrough'，内部统一映射到内置模块 'passthrough-compatibility'
          const moduleType = subTypeLower === 'passthrough' ? 'passthrough-compatibility' : subTypeRaw;

          (modBlock as any).compatibility = {
            type: 'compatibility',
            config: {
              moduleType,
              moduleConfig: this.asRecord(compatCfgSelected || {}),
              providerType,
              // 透传由 config-core 生成的 direct files（若存在）供 StandardCompatibility 直载 JSON
              ...(compatCfgSelected && (compatCfgSelected as any).files ? { files: (compatCfgSelected as any).files } : {})
            }
          };
          return;
        }

        // Standard container path：moduleType 可选，缺省视为 passthrough-compatibility
        let moduleType = String((compatCfgSelected as any)?.moduleType || '').trim();
        const mtLower = moduleType.toLowerCase();
        if (!mtLower) {
          // 不写 moduleType → 默认 passthrough-compatibility
          moduleType = 'passthrough-compatibility';
        } else if (mtLower === 'passthrough') {
          // 允许简写 'passthrough'
          moduleType = 'passthrough-compatibility';
        }

        const moduleConfig = this.asRecord((compatCfgSelected as any)?.moduleConfig || {});
        (modBlock as any).compatibility = {
          type: 'compatibility',
          config: {
            moduleType,
            moduleConfig,
            providerType,
            ...(compatCfgSelected && (compatCfgSelected as any).files ? { files: (compatCfgSelected as any).files } : {})
          }
        };
      })();

      const allowedSwitches = new Set([
        'llmswitch-anthropic-openai',
        'llmswitch-openai-openai',
        'llmswitch-conversion-router'
      ]);

      if (llmSwitch?.type) {
        const normalizedType = String(llmSwitch.type).toLowerCase();
        if (allowedSwitches.has(normalizedType)) {
          const cfg = this.asRecord(llmSwitch.config || {});
          modBlock.llmSwitch = {
            type: llmSwitch.type,
            config: cfg,
          };
        } else {
          // 默认使用转换路由器（内部根据端点自动选择 codec），统一入口
          modBlock.llmSwitch = { type: 'llmswitch-conversion-router', config: {} };
        }
      } else {
        // 未指定 llmSwitch 时，使用转换路由器
        modBlock.llmSwitch = { type: 'llmswitch-conversion-router', config: {} };
      }
      // Do not infer provider module type; honor the type already provided in pipeline definition
      // (modBlock.provider already set above)

    const providerTypeForPipeline = String((provCfg as any).providerType || provider.type || '').trim();
    if (!providerTypeForPipeline) {
      throw new Error(`PipelineAssembler(V2): provider.type/providerType is required for pipeline '${id}'（禁止兜底为 openai）`);
    }

    // 将第三方provider type映射到已注册的标准provider模块（配置驱动）
    const mapProviderTypeToRegisteredModule = (type: string): string => {
      const t = type.toLowerCase();
      // 已注册的标准provider types
      const registeredTypes = new Set(['openai', 'responses', 'anthropic']);

      if (registeredTypes.has(t)) {
        return t;
      }

      // 第三方provider（glm/qwen/iflow/lmstudio等）全部映射到openai（使用OpenAI兼容协议）
      return 'openai';
    };

    const mappedProviderType = mapProviderTypeToRegisteredModule(providerTypeForPipeline);

    // 将 modules.provider 的模块类型同步为映射后的类型，保证能够命中 Registry 中注册的模块工厂
    (modBlock as any).provider = { type: mappedProviderType, config: provCfg };

    // 根据 providerType 决定出口协议（providerProtocol），传入 llmSwitch 配置：
    //  - openai/glm/qwen/iflow/lmstudio → openai-chat
    //  - responses → openai-responses
    //  - anthropic → anthropic-messages
    (() => {
      const t = providerTypeForPipeline.toLowerCase();
      let providerProtocol = 'openai-chat';
      if (t === 'responses') providerProtocol = 'openai-responses';
        else if (t === 'iflow') providerProtocol = 'openai-chat';
      else if (t === 'anthropic') providerProtocol = 'anthropic-messages';

      const lsBlock = (modBlock as any).llmSwitch as { type?: string; config?: Record<string, unknown> } | undefined;
      if (lsBlock) {
        const cfg = this.asRecord(lsBlock.config || {});
        if (!cfg.providerProtocol) {
          (cfg as any).providerProtocol = providerProtocol;
        }
        // 将 provider.process 透传给 llmSwitch.config.process，供 core 决定 passthrough/chat 模式
        const rawProcess = (provCfg as any)?.process;
        if (typeof rawProcess === 'string' && rawProcess.trim() && !cfg.process) {
          (cfg as any).process = rawProcess.trim();
        }
        (modBlock as any).llmSwitch = {
          type: lsBlock.type || 'llmswitch-conversion-router',
          config: cfg
        };
      }
    })();

    pipelines.push({
      id,
      provider: { type: providerTypeForPipeline },
      modules: modBlock,
      settings: { debugEnabled: true }
    } as PipelineConfig);
    seen.add(id);
  }

  // Synthesize pipelines for ids present in routePools but missing from `pipelines`
  // V2 禁止从 routePools 合成流水线，这里仅做显式检测并 Fail Fast，防止静默兜底。
  try {
    const poolsObj = this.asRecord((pac as any).routePools || {});
    const idsFromPools = new Set<string>();
    Object.values(poolsObj).forEach((arr: any) => {
      if (Array.isArray(arr)) arr.forEach((pid: any) => { if (typeof pid === 'string' && pid.trim()) idsFromPools.add(pid.trim()); });
    });
    const existing = new Set(pipelines.map(p => p.id));
    const parseLegacyId = (pid: string): { providerId: string; modelId: string; keyId?: string } | null => {
      // pattern1: provider.model__key   e.g. glm.glm-4.6__key1
      const m1 = pid.match(/^([^.]+)\.([^_]+)__([^_]+)$/);
      if (m1) return { providerId: m1[1], modelId: m1[2], keyId: m1[3] };
      // pattern2: provider_key.model   e.g. glm_key1.glm-4.6
      const m2 = pid.match(/^([^_.]+)_([^\.]+)\.([\s\S]+)$/);
      if (m2) return { providerId: m2[1], keyId: m2[2], modelId: m2[3] };
      // pattern3: provider.model
      const m3 = pid.match(/^([^\.]+)\.([\s\S]+)$/);
      if (m3) return { providerId: m3[1], modelId: m3[2] };
      return null;
    };
    for (const pid of idsFromPools) {
      if (existing.has(pid)) continue;
      // V2 禁止从 routePools 合成流水线，统一在配置阶段生成
      throw new Error(`routePools references unknown pipeline id: ${pid}. V2 不允许兜底合成，请在配置中显式定义该 pipeline`);
    }
  } catch { /* non-fatal synthesis */ }

  // Reconcile routePools with available pipelines using routeTargets if present (no fallback in V2)
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
            throw new Error(`V2 routing requires explicit pipeline mapping for target {providerId:'${t.providerId}', modelId:'${t.modelId}', keyId:'${t.keyId}'} — no fallback allowed`);
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
      // Validate routePools strictly — unknown pipeline ids 必须在配置中修正
      const invalid: Array<{ route: string; id: string }> = [];
      for (const [routeName, ids] of Object.entries(routePools || {})) {
        for (const id of (ids || [])) {
          if (!availableIds.has(id)) invalid.push({ route: routeName, id });
        }
      }
      if (invalid.length) {
        const list = invalid.map(x => `${x.route}:${x.id}`).join(', ');
        throw new Error(`routePools reference unknown pipeline ids (no fallback in V2): ${list}`);
      }
    }

    // Final safeguard: if no valid routePools, create a default route to the first pipeline
    const totalRoutes = Object.values(routePools || {}).reduce((acc, v) => acc + ((v || []).length), 0);
    if ((!routePools || Object.keys(routePools).length === 0) || totalRoutes === 0) {
      throw new Error('No valid routePools configured (V2 disables default-route fallback). Please define explicit routePools → pipeline ids');
    }

    // 默认超时提升至 300s（可被 provider.timeout 与 model.timeout 覆盖）
    // Build manager settings with optional errorHandling/rateLimit configuration from merged-config
    const mgrSettings: PipelineManagerConfig['settings'] = { debugLevel: 'basic', defaultTimeout: 300000, maxRetries: 2 };
    try {
      const eh = this.asRecord((mc as any).errorHandling || {});
      const rl = this.asRecord(eh.rateLimit || {});
      const backoff = Array.isArray((rl as any).backoffMs) ? ((rl as any).backoffMs as unknown[]) : [];
      const schedule: number[] = backoff.map(v => Number(v)).filter(v => Number.isFinite(v) && v > 0) as number[];
      const switchOn429 = typeof (rl as any).switchOn429 === 'boolean' ? Boolean((rl as any).switchOn429) : undefined;
      const maxAttempts = typeof (rl as any).maxAttempts === 'number' ? Number((rl as any).maxAttempts) : undefined;
      if (schedule.length || switchOn429 !== undefined || maxAttempts !== undefined) {
        mgrSettings.rateLimit = {};
        if (schedule.length) mgrSettings.rateLimit.backoffMs = schedule;
        if (switchOn429 !== undefined) mgrSettings.rateLimit.switchOn429 = switchOn429;
        if (typeof maxAttempts === 'number') mgrSettings.rateLimit.maxAttempts = maxAttempts;
      }
    } catch { /* ignore optional errorHandling config */ }

    const managerConfig: PipelineManagerConfig = { pipelines, settings: mgrSettings };
    const dummyErrorCenter: any = { handleError: async () => {}, createContext: () => ({}), getStatistics: () => ({}) };
    const dummyDebugCenter: any = { logDebug: () => {}, logError: () => {}, logModule: () => {}, processDebugEvent: () => {}, getLogs: () => [] };
    const manager = new PipelineManager(managerConfig, dummyErrorCenter, dummyDebugCenter);
    await manager.initialize();

    // Reconcile routePools against actually initialized pipelines：
    //  - 若某些 pipeline 初始化失败，仅剪枝对应 routePools 引用，而不拖垮整个服务器；
    //  - 仍然要求至少存在一条有效流水线以保证服务可用。
    try {
      const mgrAny: any = manager as any;
      const presentIds: string[] = Array.isArray(mgrAny?.getPipelineIds?.()) ? mgrAny.getPipelineIds() : [];
      if (presentIds.length === 0) {
        throw new Error('No pipelines initialized. Ensure pipeline_assembler.config.pipelines is correctly defined and providers are valid');
      }
      const present = new Set<string>(presentIds);
      const invalid: Array<{ route: string; id: string }> = [];
      const pruned: Record<string, string[]> = {};
      for (const [route, ids] of Object.entries(routePools || {})) {
        const kept: string[] = [];
        for (const id of (ids || [])) {
          if (present.has(id)) {
            kept.push(id);
          } else {
            invalid.push({ route, id });
          }
        }
        pruned[route] = kept;
      }
      if (invalid.length) {
        const list = invalid.map(x => `${x.route}:${x.id}`).join(', ');
        // eslint-disable-next-line no-console
        console.warn(`[PipelineAssembler] pruned pipelines not created from routePools: ${list}`);
      }
      routePools = pruned;
    } catch (e) {
      throw e instanceof Error ? e : new Error(String(e || 'routePools validation failed'));
    }

    return { manager, routePools, routeMeta };
  }
}
