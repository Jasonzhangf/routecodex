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

    // For each route category, build pipelines for all targets
    for (const [routeName, targets] of Object.entries(routeTargets as Record<string, any[]>)) {
      routePools[routeName] = [];
      for (const target of targets) {
        const providerId = target.providerId;
        const modelId = target.modelId;
        const keyId = target.keyId;
        const pipelineKey = `${providerId}.${modelId}.${keyId}`;
        const pc = pipelineConfigs[pipelineKey] || {};

        // Provider module type equals to provider.type from config (as requested)
        const providerType: string = pc?.provider?.type || 'generic-http';
        const providerBaseUrl: string | undefined = pc?.provider?.baseURL || pc?.provider?.baseUrl;
        const actualModelId: string | undefined = pc?.model?.actualModelId || modelId;
        const maxTokens: number | undefined = pc?.model?.maxTokens;
        const maxContext: number | undefined = pc?.model?.maxContext;

        const llmSwitchDecl = pc?.llmSwitch;
        if (!llmSwitchDecl?.type) {
          throw new Error(`llmSwitch.type missing in pipelineConfigs for key ${pipelineKey}`);
        }
        const llmSwitch: ModuleConfig = {
          type: llmSwitchDecl.type,
          config: llmSwitchDecl.config || {}
        };

        const workflowDecl = pc?.workflow;
        if (!workflowDecl?.type) {
          throw new Error(`workflow.type missing in pipelineConfigs for key ${pipelineKey}`);
        }
        const workflow: ModuleConfig = {
          type: workflowDecl.type,
          enabled: workflowDecl.enabled !== false,
          config: workflowDecl.config || {}
        };

        // Compatibility must be specified by config
        const compatType: string | undefined = pc?.compatibility?.type;
        const compatCfg: Record<string, any> = pc?.compatibility?.config || {};
        if (!compatType) {
          throw new Error(`compatibility.type missing in pipelineConfigs for key ${pipelineKey}`);
        }
        const compatibility: ModuleConfig = { type: compatType, config: compatCfg };

        const providerConfigObj: Record<string, any> = {};
        if (providerBaseUrl) providerConfigObj.baseUrl = providerBaseUrl;
        if (actualModelId) providerConfigObj.model = actualModelId;
        if (typeof maxTokens === 'number') providerConfigObj.maxTokens = maxTokens;
        if (typeof maxContext === 'number') providerConfigObj.context = maxContext;
        // Carry auth from pipelineConfigs if present
        if (pc?.provider && (pc.provider as any).auth) {
          providerConfigObj.auth = (pc.provider as any).auth;
        }

        const provider: ModuleConfig = {
          type: providerType,
          config: providerConfigObj
        };

        // Compose a unique providerId for PipelineManager selection: <route>_<provider>_<key> . <model>
        const providerIdComposite = `${routeName}_${providerId}_${keyId}`;
        const pipelineId = `${providerIdComposite}.${modelId}`;
        routePools[routeName].push(pipelineId);

        const pipeline: PipelineConfig = {
          id: pipelineId,
          provider: { type: providerType },
          modules: { llmSwitch, workflow, compatibility, provider },
          settings: { debugEnabled: true }
        } as any;

        pipelines.push(pipeline);
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
