/**
 * Module factory functions for creating pipeline modules
 */

import type { ModuleConfig, ModuleDependencies, PipelineModule } from '../interfaces/pipeline-interfaces.js';

/**
 * Create an LLM Switch module
 */
export async function createLLMSwitchModule(
  config: ModuleConfig,
  dependencies: ModuleDependencies
): Promise<PipelineModule> {
  throw new Error('LLM Switch module factory not implemented');
}

/**
 * Create a Compatibility module
 */
export async function createCompatibilityModule(
  config: ModuleConfig,
  dependencies: ModuleDependencies
): Promise<PipelineModule> {
  switch (config.type) {
    case 'passthrough-compatibility':
      const { PassthroughCompatibility } = await import('../modules/compatibility/passthrough-compatibility.js');
      return new PassthroughCompatibility(config, dependencies);
    case 'lmstudio-compatibility':
      const { LMStudioCompatibility } = await import('../modules/compatibility/lmstudio-compatibility.js');
      return new LMStudioCompatibility(config, dependencies);
    case 'qwen-compatibility':
      const { QwenCompatibility } = await import('../modules/compatibility/qwen-compatibility.js');
      return new QwenCompatibility(config, dependencies);
    case 'iflow-compatibility':
      const { iFlowCompatibility } = await import('../modules/compatibility/iflow-compatibility.js');
      return new iFlowCompatibility(config, dependencies);
    default:
      throw new Error(`Unsupported compatibility module type: ${config.type}`);
  }
}

/**
 * Create a Provider module
 */
export async function createProviderModule(
  config: ModuleConfig,
  dependencies: ModuleDependencies
): Promise<PipelineModule> {
  switch (config.type) {
    case 'qwen-provider':
      const { QwenProvider } = await import('../modules/provider/qwen-provider.js');
      return new QwenProvider(config, dependencies);
    case 'lmstudio-http':
      const { LMStudioProviderSimple } = await import('../modules/provider/lmstudio-provider-simple.js');
      return new LMStudioProviderSimple(config, dependencies);
    case 'generic-http':
      const { GenericHTTPProvider } = await import('../modules/provider/generic-http-provider.js');
      return new GenericHTTPProvider(config, dependencies);
    case 'openai-provider':
      const { OpenAIProvider } = await import('../modules/provider/openai-provider.js');
      return new OpenAIProvider(config, dependencies);
    default:
      throw new Error(`Unsupported provider module type: ${config.type}`);
  }
}

/**
 * Create a Workflow module
 */
export async function createWorkflowModule(
  config: ModuleConfig,
  dependencies: ModuleDependencies
): Promise<PipelineModule> {
  throw new Error('Workflow module factory not implemented');
}