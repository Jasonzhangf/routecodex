/**
 * Pipeline Module Registrar
 *
 * Handles registration of all pipeline modules including
 * LM Studio specific modules.
 */

import { PipelineModuleRegistryImpl } from './pipeline-registry.js';
import { OpenAIPassthroughLLMSwitch } from '../modules/llmswitch/openai-passthrough.js';
import { StreamingControlWorkflow } from '../modules/workflow/streaming-control.js';
import { FieldMappingCompatibility } from '../modules/compatibility/field-mapping.js';
import { LMStudioCompatibility } from '../modules/compatibility/lmstudio-compatibility.js';
import { QwenCompatibility } from '../modules/compatibility/qwen-compatibility.js';

import { LMStudioProviderSimple } from '../modules/provider/lmstudio-provider-simple.js';
import { GenericHTTPProvider } from '../modules/provider/generic-http-provider.js';

/**
 * Module registrar for pipeline components
 */
export class PipelineModuleRegistrar {
  private registry: PipelineModuleRegistryImpl;

  constructor(registry: PipelineModuleRegistryImpl) {
    this.registry = registry;
  }

  /**
   * Register all default modules
   */
  registerAllModules(): void {
    this.registerLLMSwitchModules();
    this.registerWorkflowModules();
    this.registerCompatibilityModules();
    this.registerProviderModules();
  }

  /**
   * Register LLM Switch modules
   */
  private registerLLMSwitchModules(): void {
    // Register OpenAI Passthrough module
    this.registry.registerModule('openai-passthrough', async (config, dependencies) => {
      const module = new OpenAIPassthroughLLMSwitch(config, dependencies);
      return module;
    });
  }

  /**
   * Register Workflow modules
   */
  private registerWorkflowModules(): void {
    // Register Streaming Control module
    this.registry.registerModule('streaming-control', async (config, dependencies) => {
      const module = new StreamingControlWorkflow(config, dependencies);
      return module;
    });
  }

  /**
   * Register Compatibility modules
   */
  private registerCompatibilityModules(): void {
    // Register Field Mapping module
    this.registry.registerModule('field-mapping', async (config, dependencies) => {
      const module = new FieldMappingCompatibility(config, dependencies);
      return module;
    });

    // Register LM Studio Compatibility module
    this.registry.registerModule('lmstudio-compatibility', async (config, dependencies) => {
      const module = new LMStudioCompatibility(config, dependencies);
      return module;
    });

    // Register Qwen Compatibility module
    this.registry.registerModule('qwen-compatibility', async (config, dependencies) => {
      const module = new QwenCompatibility(config, dependencies);
      return module;
    });
  }

  /**
   * Register Provider modules
   */
  private registerProviderModules(): void {
    // Register Qwen Provider (full OAuth-aware implementation)
    this.registry.registerModule('qwen-provider', async (config, dependencies) => {
      const { QwenProvider } = await import('../modules/provider/qwen-provider.js');
      return new QwenProvider(config, dependencies);
    });

    // Register LM Studio HTTP Provider (simple HTTP client to LM Studio REST)
    this.registry.registerModule('lmstudio-http', async (config, dependencies) => {
      const module = new LMStudioProviderSimple(config, dependencies);
      return module;
    });

    // Register Generic HTTP Provider
    this.registry.registerModule('generic-http', async (config, dependencies) => {
      const module = new GenericHTTPProvider(config, dependencies);
      return module;
    });
  }

  /**
   * Get registered module types
   */
  getRegisteredTypes(): string[] {
    return this.registry.getAvailableTypes();
  }

  /**
   * Check if a module type is registered
   */
  isModuleRegistered(type: string): boolean {
    return this.registry.hasModule(type);
  }

  /**
   * Get registry statistics
   */
  getRegistryStatistics() {
    return this.registry.getStatistics();
  }
}

/**
 * Create and initialize module registrar
 */
export function createModuleRegistrar(registry: PipelineModuleRegistryImpl): PipelineModuleRegistrar {
  const registrar = new PipelineModuleRegistrar(registry);
  registrar.registerAllModules();
  return registrar;
}

/**
 * Module Registrar alias for backward compatibility
 */
export { PipelineModuleRegistrar as ModuleRegistrar };
