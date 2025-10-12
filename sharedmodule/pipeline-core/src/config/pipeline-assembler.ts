/**
 * Pipeline Assembler (core)
 * Assembles pipelines from merged config and returns PipelineManager + routePools
 */

import fs from 'fs/promises';
import path from 'path';
import type { PipelineManager as IPipelineManager, PipelineConfig, ModuleConfig, PipelineManagerConfig } from '../interfaces/pipeline-interfaces';
import { resolveInlineApiKey } from '../utils/inline-auth-resolver';

export interface AssembledPipelines {
  manager: IPipelineManager;
  routePools: Record<string, string[]>;
}

export class PipelineAssembler {
  private static asRecord(v: unknown): Record<string, any> { return v && typeof v === 'object' ? (v as Record<string, any>) : {}; }

  private static validatePc(
    pc: { provider?: { type?: string }; model?: { actualModelId?: string }; llmSwitch?: { type?: string }; compatibility?: { type?: string }; workflow?: { type?: string } },
    context: { routeName: string; targetKey: string }
  ): { ok: boolean; errors: string[] } {
    const errors: string[] = [];
    if (!pc?.provider?.type) { errors.push('provider.type missing'); }
    if (!pc?.model?.actualModelId) { errors.push('model.actualModelId missing'); }
    if (!pc?.llmSwitch?.type) { errors.push('llmSwitch.type missing'); }
    if (!pc?.compatibility?.type) { errors.push('compatibility.type missing'); }
    if (!pc?.workflow?.type) { errors.push('workflow.type missing'); }
    if (errors.length) {
      console.error(`[PipelineAssembler] INVALID pipeline config for ${context.routeName}/${context.targetKey}: ${errors.join(', ')}`);
      return { ok: false, errors };
    }
    return { ok: true, errors: [] };
  }

  private static findEndpointSpecificLLMSwitch(providerId: string, modelId: string, keyId: string, pipelineConfigs: Record<string, any>): ModuleConfig | undefined {
    const _ = providerId && modelId && keyId; // reserved for future differentiation
    const endpointBased = pipelineConfigs['endpoint-based'] as Record<string, any>;
    if (endpointBased) {
      const anthropicConfig = endpointBased['/v1/anthropic/messages'] as Record<string, any>;
      if (anthropicConfig && anthropicConfig['llmSwitch']) {
        const llmSwitchConfig = anthropicConfig['llmSwitch'] as Record<string, any>;
        return { type: String(llmSwitchConfig.type || 'llmswitch-anthropic-openai'), config: (llmSwitchConfig.config as Record<string, unknown>) || {} };
      }
      const openaiConfig = endpointBased['/v1/chat/completions'] as Record<string, any>;
      if (openaiConfig && openaiConfig['llmSwitch']) {
        const llmSwitchConfig = openaiConfig['llmSwitch'] as Record<string, any>;
        return { type: String(llmSwitchConfig.type || 'llmswitch-openai-openai'), config: (llmSwitchConfig.config as Record<string, unknown>) || {} };
      }
    }
    return undefined;
  }

  static async assembleFromFile(mergedConfigPath: string): Promise<AssembledPipelines> {
    const abs = mergedConfigPath.startsWith('.') ? path.resolve(process.cwd(), mergedConfigPath) : mergedConfigPath;
    const content = await fs.readFile(abs, 'utf-8');
    const mergedConfig: any = JSON.parse(content);
    return this.assemble(mergedConfig);
  }

  static async assemble(mergedConfig: unknown): Promise<AssembledPipelines> {
    const mc = this.asRecord(mergedConfig);
    const cc = this.asRecord(mc.compatibilityConfig);
    let routeTargets = (this.asRecord(cc.routeTargets)) as Record<string, any[]>;
    let pipelineConfigs = (this.asRecord(cc.pipelineConfigs)) as Record<string, any>;
    // Fallback: derive from legacy mergedConfig.virtualrouter.routing/pipelineConfigs if compatibility section lacks them
    if (!routeTargets || Object.keys(routeTargets).length === 0) {
      const legacyVr = this.asRecord((mc as Record<string, unknown>)['virtualrouter']);
      const legacyRouting = this.asRecord(legacyVr['routing']);
      if (legacyRouting && Object.keys(legacyRouting).length > 0) {
        const derived: Record<string, any[]> = {};
        for (const [k, v] of Object.entries(legacyRouting)) {
          derived[k] = Array.isArray(v) ? (v as any[]) : [];
        }
        routeTargets = derived;
      }
      const legacyPipeCfg = this.asRecord(legacyVr['pipelineConfigs']);
      if (legacyPipeCfg && Object.keys(legacyPipeCfg).length > 0) {
        pipelineConfigs = legacyPipeCfg as Record<string, any>;
      }
    }
    const topLevelPipelineConfigs = (this.asRecord(mc.pipelineConfigs)) as Record<string, any>;

    if (Object.keys(topLevelPipelineConfigs).length > 0) {
      for (const [key, config] of Object.entries(topLevelPipelineConfigs)) {
        if (!pipelineConfigs[key]) {
          pipelineConfigs[key] = config;
        } else {
          const existing = this.asRecord(pipelineConfigs[key]);
          const newConfig = this.asRecord(config);
          const merged: Record<string, any> = { ...existing };
          for (const [prop, value] of Object.entries(newConfig)) {
            if (prop === 'llmSwitch' && existing[prop]) {
              const existingLlm = this.asRecord(existing[prop]);
              const newLlm = this.asRecord(value);
              merged[prop] = { ...existingLlm, ...newLlm, config: { ...(existingLlm.config || {}), ...(newLlm.config || {}) } };
            } else {
              merged[prop] = value;
            }
          }
          pipelineConfigs[key] = merged;
        }
      }
    }

    const modulesRec = this.asRecord(mc.modules);
    const vrCfg = this.asRecord(this.asRecord(modulesRec.virtualrouter).config);
    const inputProtocol = String((this.asRecord(this.asRecord(this.asRecord(cc.normalizedConfig).virtualrouter)).inputProtocol || vrCfg.inputProtocol || 'openai')).toLowerCase();

    const defaultLlmSwitch: ModuleConfig = { type: 'llmswitch-unified', config: {} };
    const selectLLMSwitchForRoute = (_routeName: string): ModuleConfig => ({ type: 'llmswitch-unified', config: {} });

    type PcShape = {
      provider?: { type?: string; baseURL?: string; baseUrl?: string; auth?: any };
      model?: { actualModelId?: string; maxTokens?: number; maxContext?: number };
      protocols?: { input?: string; output?: string };
      llmSwitch?: { type?: string; config?: Record<string, any>; enabled?: boolean };
      workflow?: { type?: string; enabled?: boolean; config?: Record<string, any> };
      compatibility?: { type?: string; config?: Record<string, any> };
      keyConfig?: { actualKey?: string; keyType?: string };
      __attachAuth?: () => Promise<void>;
    };

    const normalizedProviders: Record<string, any> = this.asRecord(this.asRecord(this.asRecord(cc.normalizedConfig).virtualrouter).providers);

    const buildPcFromNormalized = (provId: string, mdlId: string): PcShape => {
      const np = this.asRecord(normalizedProviders[provId]);
      const modelCfg = this.asRecord(this.asRecord(np.models)[mdlId]);
      const compat = this.asRecord(modelCfg.compatibility || np.compatibility);
      let apiKey = Array.isArray(np.apiKey) && (np.apiKey as unknown[]).length ? String((np.apiKey as unknown[])[0]).trim() : '';
      const pid = String(provId || '').toLowerCase();
      const unifiedType = (() => {
        if (pid === 'modelscope') return 'openai-provider';
        const t = String(np.type || '').toLowerCase();
        if (t === 'openai-provider') return 'openai-provider';
        if (t === 'openai') return 'openai-provider';
        if (pid === 'glm' || t === 'glm') return 'glm-http-provider';
        return String(np.type || provId);
      })();
      const provider: Record<string, any> = { type: unifiedType, baseURL: (np.baseURL as string | undefined) || (np.baseUrl as string | undefined) };
      const model: Record<string, any> = { actualModelId: mdlId, maxTokens: modelCfg.maxTokens, maxContext: modelCfg.maxContext };
      const pc: PcShape = { provider, model, protocols: { input: inputProtocol || 'openai', output: 'openai' }, llmSwitch: defaultLlmSwitch };
      try {
        const ctype = (compat && typeof compat.type === 'string') ? String(compat.type) : undefined;
        const ccfg = (compat && typeof compat.config === 'object' && compat.config !== null) ? (compat.config as Record<string, any>) : {};
        if (ctype) { (pc as any).compatibility = { type: ctype, config: ccfg } as PcShape['compatibility']; }
      } catch {}
      const attachAuth = async () => {
        if (!apiKey || apiKey === '***REDACTED***') { apiKey = (await resolveInlineApiKey(provId)) || ''; }
        if (apiKey) { pc.provider = pc.provider || {}; (pc.provider as any).auth = { type: 'apikey', apiKey }; }
      };
      (pc as any).__attachAuth = attachAuth;
      if (compat && (compat as any)['type']) {
        const ctype = String((compat as any)['type'] || '');
        pc.compatibility = { type: ctype || 'passthrough-compatibility', config: (compat as any)['config'] as Record<string, any> || {} };
      }
      return pc;
    };

    const pipelines: PipelineConfig[] = [];
    const routePools: Record<string, string[]> = {};
    const createdPipelines = new Map<string, PipelineConfig>();

    for (const [routeName, targets] of Object.entries(routeTargets as Record<string, any[]>)) {
      const targetList: any[] = Array.isArray(targets) && Array.isArray((targets as any[])[0]) ? (targets as any[]).flat() : (targets as any[]);
      routePools[routeName] = [];
      for (const target of targetList) {
        let providerId: string, modelId: string, keyId: string;
        if (typeof target === 'string') { const parts = target.split('.'); providerId = parts[0] || 'undefined'; modelId = parts[1] || 'undefined'; keyId = parts[2] || 'undefined'; }
        else if (target && typeof target === 'object') { const tobj = target as { providerId?: string; modelId?: string; keyId?: string }; providerId = tobj.providerId || 'undefined'; modelId = tobj.modelId || 'undefined'; keyId = tobj.keyId || 'undefined'; }
        else { providerId = 'undefined'; modelId = 'undefined'; keyId = 'undefined'; }

        const targetKey = `${providerId}.${modelId}.${keyId}`;
        let pipeline = createdPipelines.get(targetKey);
        if (!pipeline) {
          const pc = buildPcFromNormalized(providerId, modelId);
          await (pc.__attachAuth?.());
          const cfg = PipelineAssembler.asRecord(pipelineConfigs[targetKey]);
          const providerType = String(pc.provider?.type || cfg?.provider?.type || 'openai-provider');
          const actualModelId = (pc.model?.actualModelId || modelId);
          const maxTokens = pc.model?.maxTokens || cfg?.model?.maxTokens;
          const maxContext = pc.model?.maxContext || cfg?.model?.maxContext;

          const llmSwitch = pc.llmSwitch ? { type: pc.llmSwitch.type || 'llmswitch-unified', config: pc.llmSwitch.config || {}, enabled: pc.llmSwitch.enabled !== false } : selectLLMSwitchForRoute(routeName);
          const compatibility = pc.compatibility ? { type: pc.compatibility.type || 'passthrough-compatibility', config: pc.compatibility.config || {}, enabled: true } : undefined;
          const workflow = pc.workflow ? { type: pc.workflow.type || 'streaming-control', config: pc.workflow.config || {}, enabled: pc.workflow.enabled !== false } : undefined;

          const providerConfigObj: Record<string, any> = { model: actualModelId, baseURL: pc.provider?.baseURL || pc.provider?.baseUrl };
          if (typeof maxTokens === 'number') providerConfigObj.maxTokens = maxTokens;
          if (typeof maxContext === 'number') providerConfigObj.context = maxContext;
          if (pc?.keyConfig?.actualKey) {
            const authType = pc.keyConfig.keyType || 'apiKey';
            if (authType === 'apiKey') providerConfigObj.auth = { type: 'apikey', apiKey: pc.keyConfig.actualKey };
            else if (authType === 'authFile') providerConfigObj.auth = { type: 'bearer', token: pc.keyConfig.actualKey };
          } else if (pc?.provider && (pc.provider as any).auth) {
            providerConfigObj.auth = (pc.provider as any).auth;
          }

          const provider: ModuleConfig = { type: providerType, config: providerConfigObj };
          const modulesBlock: Record<string, any> = { llmSwitch, compatibility, provider }; if (workflow) modulesBlock.workflow = workflow;

          const v2 = PipelineAssembler.validatePc({ provider: { type: providerType }, model: { actualModelId: actualModelId || modelId }, llmSwitch: { type: (llmSwitch as any)?.type }, compatibility: { type: (compatibility as any)?.type }, workflow: { type: (modulesBlock.workflow as any)?.type } }, { routeName, targetKey });
          if (!v2.ok) { continue; }

          pipeline = { id: `${providerId}_${keyId}.${modelId}`, provider: { type: providerType }, modules: modulesBlock, settings: { debugEnabled: true } } as PipelineConfig;
          pipelines.push(pipeline);
          createdPipelines.set(targetKey, pipeline);
        }
        routePools[routeName].push(pipeline.id);
      }
    }

    const managerConfig: PipelineManagerConfig = { pipelines, settings: { debugLevel: 'basic', defaultTimeout: 30000, maxRetries: 2 } };

    // Use core PipelineManager facade which resolves host manager implementation under the hood (transitional)
    const core = await import('../index.js');
    const PipelineManager: any = (core as any).PipelineManager;
    const manager: IPipelineManager = await PipelineManager.create(managerConfig, { handleError: async () => {}, createContext: () => ({}), getStatistics: () => ({}) }, { logDebug: () => {}, logError: () => {}, logModule: () => {}, processDebugEvent: () => {}, getLogs: () => [] });
    await (manager as any).initialize();
    return { manager, routePools };
  }
}
