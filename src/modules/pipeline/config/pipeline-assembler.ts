/**
 * Pipeline Assembler
 *
 * Reads merged-config.json and assembles a static pool of pipelines per route category.
 * Combines the role of a factory (LLMSwitch selection stays simple here) and an assembler
 * (build all pipelines from configuration), without hardcoding module parameters.
 */

import fs from 'fs/promises';
import path from 'path';
// import { homedir } from 'os';
import { resolveInlineApiKey } from '../utils/inline-auth-resolver.js';
import type { MergedConfig } from '../../../config/merged-config-types.js';
import type {
  PipelineManagerConfig,
  PipelineConfig,
  ModuleConfig
} from '../interfaces/pipeline-interfaces.js';
import { PipelineManager } from '../core/pipeline-manager.js';
// Using dummy centers here; actual DebugCenter/Errors are wired upstream (server/manager)

export interface AssembledPipelines {
  manager: PipelineManager;
  routePools: Record<string, string[]>; // routeName -> pipelineIds
}

export class PipelineAssembler {
  private static asRecord(v: unknown): Record<string, unknown> {
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  }

  /**
   * 查找端点特定的LLMSwitch配置
   */
  private static findEndpointSpecificLLMSwitch(
    providerId: string, 
    modelId: string, 
    keyId: string, 
    pipelineConfigs: Record<string, unknown>
  ): ModuleConfig | undefined {
    const targetKey = `${providerId}.${modelId}.${keyId}`;
    
    // 检查是否有端点特定的配置
    const endpointBased = (pipelineConfigs as Record<string, unknown>)['endpoint-based'] as Record<string, unknown>;
    if (endpointBased) {
      // 检查Anthropic端点配置
      const anthropicConfig = (endpointBased as Record<string, unknown>)['/v1/anthropic/messages'] as Record<string, unknown>;
      if (anthropicConfig && (anthropicConfig as Record<string, unknown>)['llmSwitch']) {
        const llmSwitchConfig = (anthropicConfig as Record<string, unknown>)['llmSwitch'] as Record<string, unknown>;
        return {
          type: String(llmSwitchConfig.type || 'llmswitch-anthropic-openai'),
          config: (llmSwitchConfig.config as Record<string, unknown>) || {}
        };
      }
      
      // 检查OpenAI端点配置
      const openaiConfig = (endpointBased as Record<string, unknown>)['/v1/chat/completions'] as Record<string, unknown>;
      if (openaiConfig && (openaiConfig as Record<string, unknown>)['llmSwitch']) {
        const llmSwitchConfig = (openaiConfig as Record<string, unknown>)['llmSwitch'] as Record<string, unknown>;
        return {
          type: String(llmSwitchConfig.type || 'llmswitch-openai-openai'),
          config: (llmSwitchConfig.config as Record<string, unknown>) || {}
        };
      }
    }
    
    return undefined;
  }
  /**
   * Assemble from a merged-config.json file path
   */
  static async assembleFromFile(mergedConfigPath: string): Promise<AssembledPipelines> {
    const abs = mergedConfigPath.startsWith('.')
      ? path.resolve(process.cwd(), mergedConfigPath)
      : mergedConfigPath;
    const content = await fs.readFile(abs, 'utf-8');
    const mergedConfig: MergedConfig = JSON.parse(content);
    return this.assemble(mergedConfig);
  }

  /**
   * Assemble from an in-memory merged configuration object
   */
  static async assemble(mergedConfig: unknown): Promise<AssembledPipelines> {
    // New logic: consume routeTargets/pipelineConfigs from compatibilityConfig (primary)
    // Fallbacks are kept temporarily for migration and will be removed after validation
    const mc = this.asRecord(mergedConfig);
    const cc = this.asRecord(mc.compatibilityConfig);
    const routeTargets = (this.asRecord(cc.routeTargets)) as Record<string, unknown[]>;
    const pipelineConfigs = (this.asRecord(cc.pipelineConfigs)) as Record<string, unknown>;
    
    // Also check for top-level pipelineConfigs if compatibilityConfig.pipelineConfigs is empty
    const topLevelPipelineConfigs = (this.asRecord(mc.pipelineConfigs)) as Record<string, unknown>;
    
    // Merge top-level pipelineConfigs if they exist
    if (Object.keys(topLevelPipelineConfigs).length > 0) {
      for (const [key, config] of Object.entries(topLevelPipelineConfigs)) {
        if (!pipelineConfigs[key]) {
          pipelineConfigs[key] = config;
        } else {
          // Deep merge with existing config
          const existing = this.asRecord(pipelineConfigs[key]);
          const newConfig = this.asRecord(config);
          
          // Create a new merged config
          const merged: Record<string, unknown> = {};
          
          // Copy all properties from existing
          for (const [prop, value] of Object.entries(existing)) {
            merged[prop] = value;
          }
          
          // Merge properties from new config
          for (const [prop, value] of Object.entries(newConfig)) {
            if (prop === 'llmSwitch' && existing[prop]) {
              // Special handling for llmSwitch - merge the nested config
              const existingLlmSwitch = this.asRecord(existing[prop]);
              const newLlmSwitch = this.asRecord(value);
              merged[prop] = {
                ...existingLlmSwitch,
                ...newLlmSwitch,
                config: {
                  ...(existingLlmSwitch.config || {}),
                  ...(newLlmSwitch.config || {})
                }
              };
            } else {
              merged[prop] = value;
            }
          }
          
          pipelineConfigs[key] = merged;
        }
      }
    }

    // Normalized providers info from compatibility engine
    const normalizedProviders: Record<string, unknown> =
      this.asRecord(
        this.asRecord(
          this.asRecord(cc.normalizedConfig).virtualrouter
        ).providers
      );

    const modulesRec = this.asRecord(mc.modules);
    const vrCfg = this.asRecord(this.asRecord(modulesRec.virtualrouter).config);
    const inputProtocol = String(
      this.asRecord(this.asRecord(this.asRecord(cc.normalizedConfig).virtualrouter)).inputProtocol ||
      vrCfg.inputProtocol ||
      'openai'
    ).toLowerCase();

    const defaultLlmSwitch: ModuleConfig = {
      // Use unified LLMSwitch by default to auto-detect by endpoint
      type: 'llmswitch-unified',
      config: {}
    };

    // 端点特定的LLMSwitch选择
    const selectLLMSwitchForRoute = (_routeName: string): ModuleConfig => {
      // Route-based default now unified as well; endpoint decides inside the module
      return { type: 'llmswitch-unified', config: {} };
    };

    type PcShape = {
      provider?: { type?: string; baseURL?: string; baseUrl?: string; auth?: unknown };
      model?: { actualModelId?: string; maxTokens?: number; maxContext?: number };
      protocols?: { input?: string; output?: string };
      llmSwitch?: { type?: string; config?: Record<string, unknown>; enabled?: boolean };
      workflow?: { type?: string; enabled?: boolean; config?: Record<string, unknown> };
      compatibility?: { type?: string; config?: Record<string, unknown> };
      keyConfig?: { actualKey?: string; keyType?: string };
      __attachAuth?: () => Promise<void>;
    };

    const buildPcFromNormalized = (provId: string, mdlId: string): PcShape => {
      const np = PipelineAssembler.asRecord(normalizedProviders[provId]);
      const modelCfg = PipelineAssembler.asRecord(PipelineAssembler.asRecord(np.models)[mdlId]);
      const compat = PipelineAssembler.asRecord(modelCfg.compatibility || np.compatibility);
      let apiKey = Array.isArray(np.apiKey) && (np.apiKey as unknown[]).length ? String((np.apiKey as unknown[])[0]).trim() : '';
      const pid = String(provId || '').toLowerCase();
      const unifiedType = ((): string => {
        // Unify only ModelScope to openai-provider
        if (pid === 'modelscope') { return 'openai-provider'; }
        // Preserve explicit openai-provider
        const t = String(np.type || '').toLowerCase();
        if (t === 'openai-provider') { return 'openai-provider'; }
        // Map GLM family to dedicated provider module
        if (pid === 'glm' || t === 'glm') { return 'glm-http-provider'; }
        return String(np.type || provId);
      })();
      const provider: Record<string, unknown> = {
        type: unifiedType,
        baseURL: (np.baseURL as string | undefined) || (np.baseUrl as string | undefined),
        // auth added below after potential secret resolution
      };
      const model: Record<string, unknown> = {
        actualModelId: mdlId,
        maxTokens: modelCfg.maxTokens as number | undefined,
        maxContext: modelCfg.maxContext as number | undefined,
      };
      const pc: PcShape = {
        provider,
        model,
        protocols: { input: inputProtocol || 'openai', output: 'openai' },
        llmSwitch: defaultLlmSwitch
      };
      const attachAuth = async () => {
        console.log(`[PipelineAssembler] DEBUG - Resolving auth for ${provId}:`);
        console.log(`- initial apiKey exists: ${!!apiKey}`);
        console.log(`- initial apiKey is redacted: ${apiKey === '***REDACTED***'}`);
        if (!apiKey || apiKey === '***REDACTED***') {
          console.log(`- calling resolveInlineApiKey for ${provId}...`);
          apiKey = (await resolveInlineApiKey(provId)) || '';
          console.log(`- resolved apiKey length: ${apiKey?.length || 0}`);
          console.log(`- resolved apiKey prefix: ${apiKey?.substring(0, 10) || 'EMPTY'}...`);
        }
        if (apiKey) {
          pc.provider = pc.provider || {};
          (pc.provider as Record<string, unknown>).auth = { type: 'apikey', apiKey };
          console.log(`- auth set successfully for ${provId}`);
        } else {
          console.log(`- ERROR: No API key found for ${provId}`);
        }
      };
      // Attach auth synchronously best-effort (will complete before use in practice)
      // Note: assemble is async; we can await later before using pc
      (pc as Record<string, unknown>).__attachAuth = attachAuth;
      if (compat && (compat as Record<string, unknown>)['type']) {
        const ctype = String((compat as Record<string, unknown>)['type'] || '');
        pc.compatibility = { type: ctype || 'passthrough-compatibility', config: (compat as Record<string, unknown>)['config'] as Record<string, unknown> || {} };
      }
      return pc;
    };

    // Minimal debug to aid diagnostics during rollout
    console.log('[PipelineAssembler] using new config shape:', {
      routeKeys: Object.keys(routeTargets || {}),
      pipelineKeys: Object.keys(pipelineConfigs || {}).length,
    });

    // Enhanced debug for routeTargets
    console.log('[PipelineAssembler] DEBUG - Route targets analysis:');
    console.log('- mergedConfig.compatibilityConfig exists:', !!(mc as Record<string, unknown>)['compatibilityConfig']);
    console.log('- compatibilityConfig keys:', Object.keys(cc || {}));
    console.log('- routeTargets type:', typeof routeTargets);
    console.log('- routeTargets keys:', Object.keys(routeTargets || {}));
    console.log('- routeTargets default sample:', JSON.stringify((routeTargets as Record<string, unknown>)?.['default'] || 'NO DEFAULT', null, 2));

    const pipelines: PipelineConfig[] = [];
    const routePools: Record<string, string[]> = {};

    // Track created pipelines to avoid duplicates - key is target identifier
    const createdPipelines = new Map<string, PipelineConfig>();

    // For each route category, build pipelines for all targets
    for (const [routeName, targets] of Object.entries(routeTargets as Record<string, unknown[]>)) {
      const targetList: unknown[] = Array.isArray(targets) && Array.isArray((targets as unknown[])[0])
        ? (targets as unknown[]).flat()
        : (targets as unknown[]);
      console.log(`[PipelineAssembler] DEBUG - Processing route: ${routeName} with ${targetList.length} targets`);
      routePools[routeName] = [];
      for (const target of targetList) {
        console.log(`[PipelineAssembler] DEBUG - Processing target:`, target);

        // Handle both string format "provider.model.key" and object format {providerId, modelId, keyId}
        let providerId: string, modelId: string, keyId: string;

        if (typeof target === 'string') {
          // Parse string format: "glm.glm-4.5.key1"
          const parts = target.split('.');
          providerId = parts[0] || 'undefined';
          modelId = parts[1] || 'undefined';
          keyId = parts[2] || 'undefined';
        } else if (target && typeof target === 'object') {
          const tobj = target as { providerId?: string; modelId?: string; keyId?: string };
          providerId = tobj.providerId || 'undefined';
          modelId = tobj.modelId || 'undefined';
          keyId = tobj.keyId || 'undefined';
        } else {
          providerId = 'undefined';
          modelId = 'undefined';
          keyId = 'undefined';
        }

        // Unique target identifier based on provider+model+key (not route)
        const targetKey = `${providerId}.${modelId}.${keyId}`;
        console.log(`[PipelineAssembler] DEBUG - Looking for pipeline config with key: ${targetKey}`);
        console.log(`[PipelineAssembler] DEBUG - Available pipeline config keys:`, Object.keys(pipelineConfigs));

        let pc = buildPcFromNormalized(providerId, modelId) as PcShape;
        
        // If there's a custom pipeline config, merge it with the default
        const customConfig = pipelineConfigs[targetKey] as Record<string, unknown>;
        if (customConfig) {
          console.log(`[PipelineAssembler] DEBUG - Merging custom pipeline config:`, customConfig);
          
          // Merge llmSwitch config if present
          if (customConfig.llmSwitch) {
            pc.llmSwitch = customConfig.llmSwitch as PcShape['llmSwitch'];
          }
          
          // Merge other configurations as needed
          if (customConfig.provider) {
            pc.provider = { ...pc.provider, ...customConfig.provider } as PcShape['provider'];
          }
          
          if (customConfig.model) {
            pc.model = { ...pc.model, ...customConfig.model } as PcShape['model'];
          }
          
          if (customConfig.compatibility) {
            pc.compatibility = { ...pc.compatibility, ...customConfig.compatibility } as PcShape['compatibility'];
          }
          
          if (customConfig.workflow) {
            pc.workflow = { ...pc.workflow, ...customConfig.workflow } as PcShape['workflow'];
          }
        }
        
        // Ensure auth is resolved if builder provided async hook
        if (pc.__attachAuth) {
          await pc.__attachAuth();
          delete pc.__attachAuth;
        }
        console.log(`[PipelineAssembler] DEBUG - Final pipeline config:`, pc);

        let pipeline: PipelineConfig;

        // Check if this target has already been created
        if (createdPipelines.has(targetKey)) {
          // Reuse existing pipeline
          pipeline = createdPipelines.get(targetKey)!;
        } else {
          // Create new pipeline for this target

          // DEBUG: Log pipeline config structure
          console.log(`[PipelineAssembler] DEBUG - Pipeline config for ${targetKey}:`, JSON.stringify(pc, null, 2));

          // Provider module type equals to provider.type from config (as requested)
          const providerType: string = pc?.provider?.type || 'generic-http';
          // Prefer explicit override baseUrl (pipelineConfigs) over normalized baseURL
          const providerBaseUrl: string | undefined = (pc?.provider as any)?.baseUrl || (pc?.provider as any)?.baseURL;
          const actualModelId: string | undefined = pc?.model?.actualModelId || modelId;
          const maxTokens: number | undefined = pc?.model?.maxTokens;
          const maxContext: number | undefined = pc?.model?.maxContext;

          // DEBUG: Log extracted provider config
          console.log(`[PipelineAssembler] DEBUG - Extracted provider config:`, {
            providerType,
            providerBaseUrl,
            actualModelId,
            maxTokens,
            maxContext,
            providerField: pc?.provider,
            modelField: pc?.model
          });

          // Workflow: 若用户提供则使用，否则可选
          const workflowDecl = pc?.workflow as { type?: string; enabled?: boolean; config?: Record<string, unknown> } | undefined;
          const workflow: ModuleConfig | undefined = workflowDecl?.type
            ? { type: workflowDecl.type, enabled: workflowDecl.enabled !== false, config: workflowDecl.config || {} }
            : { type: 'streaming-control', config: { streamingToNonStreaming: true } };

          // Compatibility must be specified by config
          // Compatibility: 由provider配置的compatibility决定；未配置则使用passthrough
          const compatDecl = pc?.compatibility as { type?: string; config?: Record<string, unknown> } | undefined;
          const compatType: string | undefined = compatDecl?.type;
          const compatCfg: Record<string, unknown> = compatDecl?.config || {};
          const compatibility: ModuleConfig = compatType
            ? { type: compatType, config: compatCfg }
            : { type: 'passthrough-compatibility', config: {} };

          const providerConfigObj: Record<string, unknown> = {};
          // Generic providers expect a vendor type hint for downstream compatibility modules
          // Use providerId as the vendor type (e.g., 'glm', 'qwen', 'iflow', 'modelscope')
          providerConfigObj.type = providerId;
          if (providerBaseUrl) {providerConfigObj.baseUrl = providerBaseUrl;}
          if (actualModelId) {providerConfigObj.model = actualModelId;}
          if (typeof maxTokens === 'number') {providerConfigObj.maxTokens = maxTokens;}
          if (typeof maxContext === 'number') {providerConfigObj.context = maxContext;}

          // Configure authentication based on authentication type
          if (pc?.keyConfig?.actualKey) {
            const authType = pc.keyConfig.keyType || 'apiKey';

            if (authType === 'apiKey') {
              providerConfigObj.auth = {
                type: 'apikey',
                apiKey: pc.keyConfig.actualKey
              };
            } else if (authType === 'authFile') {
              // Handle auth file based authentication
              providerConfigObj.auth = {
                type: 'bearer',
                token: pc.keyConfig.actualKey
              };
            }
          } else {
            // Carry auth from pipelineConfigs if present for other auth types
            if (pc?.provider && (pc.provider as Record<string, unknown>).auth) {
              providerConfigObj.auth = (pc.provider as Record<string, unknown>).auth;
            }
          }

          const provider: ModuleConfig = {
            type: providerType,
            config: providerConfigObj
          };

          // 使用配置中的LLMSwitch，如果配置中没有则使用路由基础的LLMSwitch选择
          // 注意：如果配置了unified LLMSwitch，优先使用它而不是路由基础的LLMSwitch
          let llmSwitch: ModuleConfig;
          if (pc.llmSwitch && pc.llmSwitch.type === 'llmswitch-unified') {
            // 如果配置了unified LLMSwitch，使用它
            llmSwitch = {
              type: pc.llmSwitch.type || 'llmswitch-unified',
              config: pc.llmSwitch.config || {},
              enabled: pc.llmSwitch.enabled !== false
            };
            console.log(`[PipelineAssembler] DEBUG - Using unified LLMSwitch: ${JSON.stringify(llmSwitch)}`);
          } else if (pc.llmSwitch) {
            // 如果配置了其他LLMSwitch，使用它
            llmSwitch = {
              type: pc.llmSwitch.type || 'llmswitch-openai-openai',
              config: pc.llmSwitch.config || {},
              enabled: pc.llmSwitch.enabled !== false
            };
            console.log(`[PipelineAssembler] DEBUG - Using configured LLMSwitch: ${JSON.stringify(llmSwitch)}`);
          } else {
            // 否则使用路由基础的LLMSwitch选择
            llmSwitch = selectLLMSwitchForRoute(routeName);
            console.log(`[PipelineAssembler] DEBUG - Using route-based LLMSwitch for ${routeName}: ${JSON.stringify(llmSwitch)}`);
          }

          // Unique pipeline ID based on target, not route - enables reuse across categories
          const pipelineId = `${providerId}_${keyId}.${modelId}`;

          const modulesBlock: Record<string, unknown> = { llmSwitch, compatibility, provider };
          if (workflow) { modulesBlock.workflow = workflow; }

          pipeline = {
            id: pipelineId,
            provider: { type: providerType },
            modules: modulesBlock,
            settings: { debugEnabled: true }
          } as PipelineConfig;

          pipelines.push(pipeline);
          createdPipelines.set(targetKey, pipeline);
        }

        // Link this route to the pipeline (either newly created or reused)
        routePools[routeName].push(pipeline.id);
      }
    }

    const managerConfig: PipelineManagerConfig = {
      pipelines,
      settings: { debugLevel: 'basic', defaultTimeout: 30000, maxRetries: 2 }
    };

    const dummyErrorCenter: { handleError: () => Promise<void>, createContext: () => unknown, getStatistics: () => unknown } = { handleError: async () => {}, createContext: () => ({}), getStatistics: () => ({}) };
    const dummyDebugCenter: { logDebug: () => void, logError: () => void, logModule: () => void, processDebugEvent: () => void, getLogs: () => unknown[] } = { logDebug: () => {}, logError: () => {}, logModule: () => {}, processDebugEvent: () => {}, getLogs: () => [] };

    const manager = new PipelineManager(managerConfig, dummyErrorCenter, dummyDebugCenter);
    await manager.initialize();
    return { manager, routePools };
  }

  // No inference: compatibility is required in config per pipeline.
}
