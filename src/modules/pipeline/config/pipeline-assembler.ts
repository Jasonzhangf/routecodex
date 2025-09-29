/**
 * Pipeline Assembler
 *
 * Reads merged-config.json and assembles a static pool of pipelines per route category.
 * Combines the role of a factory (LLMSwitch selection stays simple here) and an assembler
 * (build all pipelines from configuration), without hardcoding module parameters.
 */

import fs from 'fs/promises';
import path from 'path';
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
    // Locate virtual router configuration
    const vr = mergedConfig?.modules?.virtualrouter?.config || {};
    const routeTargets = vr.routeTargets || vr.routetargets || {};
    const pipelineConfigs = vr.pipelineConfigs || {};

    const pipelines: PipelineConfig[] = [];
    const routePools: Record<string, string[]> = {};

    // Track created pipelines to avoid duplicates - key is target identifier
    const createdPipelines = new Map<string, PipelineConfig>();

    // For each route category, build pipelines for all targets
    for (const [routeName, targets] of Object.entries(routeTargets as Record<string, any[]>)) {
      routePools[routeName] = [];
      for (const target of targets) {
        const providerId = target.providerId;
        const modelId = target.modelId;
        const keyId = target.keyId;

        // Unique target identifier based on provider+model+key (not route)
        const targetKey = `${providerId}.${modelId}.${keyId}`;
        const pc = pipelineConfigs[targetKey] || {};

        let pipeline: PipelineConfig;

        // Check if this target has already been created
        if (createdPipelines.has(targetKey)) {
          // Reuse existing pipeline
          pipeline = createdPipelines.get(targetKey)!;
        } else {
          // Create new pipeline for this target

          // Provider module type equals to provider.type from config (as requested)
          const providerType: string = pc?.provider?.type || 'generic-http';
          const providerBaseUrl: string | undefined = pc?.provider?.baseURL || pc?.provider?.baseUrl;
          const actualModelId: string | undefined = pc?.model?.actualModelId || modelId;
          const maxTokens: number | undefined = pc?.model?.maxTokens;
          const maxContext: number | undefined = pc?.model?.maxContext;

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
            : undefined;

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
