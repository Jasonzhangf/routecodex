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
import { QwenHTTPProvider } from '../modules/provider/qwen-http-provider.js';
import { LMStudioProvider } from '../modules/provider/lmstudio-provider.js';
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
  }

  /**
   * Register Provider modules
   */
  private registerProviderModules(): void {
    // Register Qwen HTTP Provider
    this.registry.registerModule('qwen-http', async (config, dependencies) => {
      const module = new QwenHTTPProvider(config, dependencies);
      return module;
    });

    // Register LM Studio Provider
    this.registry.registerModule('lmstudio-http', async (config, dependencies) => {
      const module = new LMStudioProvider(config, dependencies);
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