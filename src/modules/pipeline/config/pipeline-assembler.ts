/**
 * Pipeline Assembler
 *
 * Reads merged-config.json and assembles a static pool of pipelines per route category.
 * Combines the role of a factory (LLMSwitch selection stays simple here) and an assembler
 * (build all pipelines from configuration), without hardcoding module parameters.
 */

import fs from 'fs/promises';
import path from 'path';
import { homedir } from 'os';
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
  static async assemble(mergedConfig: any): Promise<AssembledPipelines> {
    // New logic: consume routeTargets/pipelineConfigs from compatibilityConfig (primary)
    // Fallbacks are kept temporarily for migration and will be removed after validation
    const routeTargets = (mergedConfig?.compatibilityConfig?.routeTargets || {}) as Record<string, unknown[]>;
    const pipelineConfigs = (mergedConfig?.compatibilityConfig?.pipelineConfigs || {}) as Record<string, any>;

    // Normalized providers info from compatibility engine
    const normalizedProviders: Record<string, any> =
      (mergedConfig?.compatibilityConfig?.normalizedConfig?.virtualrouter?.providers as Record<string, any>) || {};

    const inputProtocol = String(
      mergedConfig?.compatibilityConfig?.normalizedConfig?.virtualrouter?.inputProtocol ||
      mergedConfig?.modules?.virtualrouter?.config?.inputProtocol ||
      'openai'
    ).toLowerCase();

    const defaultLlmSwitch: ModuleConfig = {
      type: inputProtocol === 'anthropic' ? 'llmswitch-anthropic-openai' : 'llmswitch-openai-openai',
      config: {}
    };

    const buildPcFromNormalized = (provId: string, mdlId: string): any => {
      const np = normalizedProviders[provId] || {};
      const modelCfg = (np.models || {})[mdlId] || {};
      const compat = modelCfg.compatibility || np.compatibility || null;
      let apiKey = Array.isArray(np.apiKey) && np.apiKey.length ? String(np.apiKey[0]).trim() : '';
      const pid = String(provId || '').toLowerCase();
      const unifiedType = ((): string => {
        // Unify only ModelScope to openai-provider
        if (pid === 'modelscope') { return 'openai-provider'; }
        // Preserve explicit openai-provider
        const t = String(np.type || '').toLowerCase();
        if (t === 'openai-provider') { return 'openai-provider'; }
        // Map GLM family to dedicated provider module
        if (pid === 'glm' || t === 'glm') { return 'glm-http-provider'; }
        return (np.type || provId);
      })();
      const provider: any = {
        type: unifiedType,
        baseURL: np.baseURL || np.baseUrl,
        // auth added below after potential secret resolution
      };
      const model: any = {
        actualModelId: mdlId,
        maxTokens: modelCfg.maxTokens,
        maxContext: modelCfg.maxContext
      };
      const pc: any = {
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
          pc.provider.auth = { type: 'apikey', apiKey };
          console.log(`- auth set successfully for ${provId}`);
        } else {
          console.log(`- ERROR: No API key found for ${provId}`);
        }
      };
      // Attach auth synchronously best-effort (will complete before use in practice)
      // Note: assemble is async; we can await later before using pc
      (pc as any).__attachAuth = attachAuth;
      if (compat && compat.type) {
        pc.compatibility = { type: compat.type, config: compat.config || {} };
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
    console.log('- mergedConfig.compatibilityConfig exists:', !!mergedConfig?.compatibilityConfig);
    console.log('- compatibilityConfig keys:', Object.keys(mergedConfig?.compatibilityConfig || {}));
    console.log('- routeTargets type:', typeof routeTargets);
    console.log('- routeTargets keys:', Object.keys(routeTargets || {}));
    console.log('- routeTargets default sample:', JSON.stringify(routeTargets?.default || 'NO DEFAULT', null, 2));

    const pipelines: PipelineConfig[] = [];
    const routePools: Record<string, string[]> = {};

    // Track created pipelines to avoid duplicates - key is target identifier
    const createdPipelines = new Map<string, PipelineConfig>();

    // For each route category, build pipelines for all targets
    for (const [routeName, targets] of Object.entries(routeTargets as Record<string, unknown[]>)) {
      const targetList: any[] = Array.isArray(targets) && Array.isArray((targets as unknown[])[0])
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
        } else {
          // Object format
          providerId = target.providerId || 'undefined';
          modelId = target.modelId || 'undefined';
          keyId = target.keyId || 'undefined';
        }

        // Unique target identifier based on provider+model+key (not route)
        const targetKey = `${providerId}.${modelId}.${keyId}`;
        console.log(`[PipelineAssembler] DEBUG - Looking for pipeline config with key: ${targetKey}`);
        console.log(`[PipelineAssembler] DEBUG - Available pipeline config keys:`, Object.keys(pipelineConfigs));

        const pc = pipelineConfigs[targetKey] || buildPcFromNormalized(providerId, modelId);
        // Ensure auth is resolved if builder provided async hook
        if ((pc as any).__attachAuth) {
          await (pc as any).__attachAuth();
          delete (pc as any).__attachAuth;
        }
        console.log(`[PipelineAssembler] DEBUG - Found pipeline config:`, pc);

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
          const providerBaseUrl: string | undefined = pc?.provider?.baseURL || pc?.provider?.baseUrl;
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

          // LLM Switch: 由 inputProtocol 决定，若用户已显式提供则使用用户配置
          const llmSwitchDecl = pc?.llmSwitch;
          let llmSwitch: ModuleConfig | undefined;
          if (llmSwitchDecl?.type) {
            llmSwitch = { type: llmSwitchDecl.type, config: llmSwitchDecl.config || {} };
          } else {
            const inputProtocol = (mergedConfig?.modules?.virtualrouter?.config?.inputProtocol || 'openai').toLowerCase();
            if (inputProtocol === 'anthropic') {
              llmSwitch = { type: 'llmswitch-anthropic-openai', config: {} };
            } else {
              llmSwitch = { type: 'llmswitch-openai-openai', config: {} };
            }
          }

          // Workflow: 若用户提供则使用，否则可选
          const workflowDecl = pc?.workflow;
          const workflow: ModuleConfig | undefined = workflowDecl?.type
            ? { type: workflowDecl.type, enabled: workflowDecl.enabled !== false, config: workflowDecl.config || {} }
            : { type: 'streaming-control', config: { streamingToNonStreaming: true } };

          // Compatibility must be specified by config
          // Compatibility: 由provider配置的compatibility决定；未配置则使用passthrough
          const compatType: string | undefined = pc?.compatibility?.type;
          const compatCfg: Record<string, any> = pc?.compatibility?.config || {};
          const compatibility: ModuleConfig = compatType
            ? { type: compatType, config: compatCfg }
            : { type: 'passthrough-compatibility', config: {} };

          const providerConfigObj: Record<string, any> = {};
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
            if (pc?.provider && (pc.provider as any).auth) {
              providerConfigObj.auth = (pc.provider as any).auth;
            }
          }

          const provider: ModuleConfig = {
            type: providerType,
            config: providerConfigObj
          };

          // Unique pipeline ID based on target, not route - enables reuse across categories
          const pipelineId = `${providerId}_${keyId}.${modelId}`;

          const modulesBlock: any = { llmSwitch, compatibility, provider };
          if (workflow) { modulesBlock.workflow = workflow; }

          pipeline = {
            id: pipelineId,
            provider: { type: providerType },
            modules: modulesBlock,
            settings: { debugEnabled: true }
          } as any;

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

    const dummyErrorCenter: any = { handleError: async () => {}, createContext: () => ({}), getStatistics: () => ({}) };
    const dummyDebugCenter: any = { logDebug: () => {}, logError: () => {}, logModule: () => {}, processDebugEvent: () => {}, getLogs: () => [] };

    const manager = new PipelineManager(managerConfig, dummyErrorCenter, dummyDebugCenter);
    await manager.initialize();
    return { manager, routePools };
  }

  // No inference: compatibility is required in config per pipeline.
}
