import type {
  PipelineRequest,
  PipelineResponse,
  PipelineConfig,
  PipelineManagerConfig,
  PipelineModuleRegistry,
  ModuleFactory,
  ModuleConfig,
  ModuleDependencies,
  PipelineModule,
} from '../interfaces/pipeline-interfaces';
import { ModuleRegistry } from '../registry/module-registry';
import { BasePipeline } from './base-pipeline';

export class PipelineManager {
  readonly id = 'pipeline-manager';
  private pipelines: Map<string, BasePipeline> = new Map();
  private registry: PipelineModuleRegistry;
  private isInitialized = false;

  constructor(private config: PipelineManagerConfig, private errorHandlingCenter: any, private debugCenter: any) {
    this.registry = new ModuleRegistry();
    this.initializeModuleRegistry();
  }

  static async create(config: PipelineManagerConfig, errorHandlingCenter: any, debugCenter: any): Promise<PipelineManager> {
    return new PipelineManager(config, errorHandlingCenter, debugCenter);
  }

  async initialize(): Promise<void> {
    const creations = this.config.pipelines.map(async (pc) => {
      const moduleFactory: ModuleFactory = async (moduleConfig: ModuleConfig, dependencies: ModuleDependencies): Promise<PipelineModule> => {
        return this.registry.createModule(moduleConfig, dependencies);
      };
      const pipeline = new BasePipeline(pc as PipelineConfig, this.errorHandlingCenter, this.debugCenter, moduleFactory);
      await pipeline.initialize();
      this.pipelines.set(pc.id, pipeline);
    });
    await Promise.all(creations);
    this.isInitialized = true;
  }

  getStatus(): any {
    return {
      id: this.id,
      initialized: this.isInitialized,
      pipelines: Array.from(this.pipelines.values()).map(p => p.getStatus()),
    };
  }

  getStatistics(): any { return {}; }

  private generatePipelineId(providerId: string, modelId: string): string {
    // In current assembler we use `${provider}_${key}.${model}`; here we fallback to provider.model
    return `${providerId}_provider.${modelId}`;
  }

  private selectPipeline(providerId: string, modelId: string): BasePipeline {
    // Try exact id used by assembler: `${provider}_${key}.${model}` across routePools resolution is handled externally.
    // Manager just needs to find a pipeline with the given model suffix.
    for (const [id, p] of this.pipelines.entries()) {
      if (id.endsWith(`.${modelId}`) && id.startsWith(`${providerId}_`)) return p;
    }
    // Fallback: provider.model
    const pid = this.generatePipelineId(providerId, modelId);
    const p = this.pipelines.get(pid);
    if (!p) throw new Error(`No pipeline found for ${providerId}.${modelId}`);
    return p;
  }

  async processRequest(request: PipelineRequest): Promise<PipelineResponse> {
    if (!this.isInitialized) throw new Error('PipelineManager is not initialized');
    const p = this.selectPipeline(request.route.providerId, request.route.modelId);
    return await p.processRequest(request);
  }

  private initializeModuleRegistry(): void {
    // Register LLMSwitch from core
    this.registry.registerModule('llmswitch-anthropic-openai', async (config, deps) => {
      const { AnthropicOpenAIConverter } = await import('../modules/llmswitch/llmswitch-anthropic-openai.js');
      return new AnthropicOpenAIConverter(config, deps);
    });
    this.registry.registerModule('llmswitch-openai-openai', async (config, deps) => {
      const { OpenAINormalizerLLMSwitch } = await import('../modules/llmswitch/openai-normalizer.js');
      return new OpenAINormalizerLLMSwitch(config as any, deps as any) as unknown as PipelineModule;
    });
    this.registry.registerModule('llmswitch-unified', async (config, deps) => {
      const { UnifiedLLMSwitch } = await import('../modules/llmswitch/llmswitch-unified.js');
      return new UnifiedLLMSwitch(config, deps) as unknown as PipelineModule;
    });

    // Defer other modules to host implementation via dynamic import (relative to main package dist)
    const importHost = async (rel: string) => {
      // Attempt to resolve from repository root dist relative to pipeline-core/dist/core/*.js
      // From sharedmodule/pipeline-core/dist/core -> up 4 to repo root
      const distPath = ['..','..','..','..','dist','modules','pipeline',...rel.split('/')].join('/');
      try { return await import(distPath as unknown as string); } catch { /* try src as dev fallback */ }
      const srcPath = ['..','..','..','..','src','modules','pipeline',...rel.split('/')].join('/');
      return await import(srcPath as unknown as string);
    };

    this.registry.registerModule('streaming-control', async (config, deps) => {
      const { StreamingControlWorkflow } = await importHost('modules/workflow/streaming-control.js');
      return new StreamingControlWorkflow(config, deps) as unknown as PipelineModule;
    });
    this.registry.registerModule('field-mapping', async (config, deps) => {
      const { FieldMappingCompatibility } = await importHost('modules/compatibility/field-mapping.js');
      return new FieldMappingCompatibility(config, deps) as unknown as PipelineModule;
    });
    this.registry.registerModule('glm-compatibility', async (config, deps) => {
      const { GLMCompatibility } = await importHost('modules/compatibility/glm-compatibility.js');
      return new GLMCompatibility(config, deps) as unknown as PipelineModule;
    });
    this.registry.registerModule('passthrough-compatibility', async (config, deps) => {
      const mod = await importHost('modules/compatibility/passthrough-compatibility.js');
      const Impl = (mod as any).PassthroughCompatibility || (mod as any).default || (mod as any).FieldMappingCompatibility; // fallback
      return new Impl(config, deps) as unknown as PipelineModule;
    });

    // Providers
    this.registry.registerModule('openai-provider', async (config, deps) => {
      const { OpenAIProvider } = await importHost('modules/provider/openai-provider.js');
      return new OpenAIProvider(config, deps) as unknown as PipelineModule;
    });
    this.registry.registerModule('glm-http-provider', async (config, deps) => {
      const { GLMHTTPProvider } = await importHost('modules/provider/glm-http-provider.js');
      return new GLMHTTPProvider(config, deps) as unknown as PipelineModule;
    });
    this.registry.registerModule('qwen-provider', async (config, deps) => {
      const { QwenProvider } = await importHost('modules/provider/qwen-provider.js');
      return new QwenProvider(config, deps) as unknown as PipelineModule;
    });
    this.registry.registerModule('generic-http', async (config, deps) => {
      const { GenericHTTPModule } = await importHost('modules/provider/generic-http.js');
      return new GenericHTTPModule(config, deps) as unknown as PipelineModule;
    });
    this.registry.registerModule('lmstudio-http', async (config, deps) => {
      const { LMStudioHTTPModule } = await importHost('modules/provider/lmstudio-http.js');
      return new LMStudioHTTPModule(config, deps) as unknown as PipelineModule;
    });
  }

  async cleanup(): Promise<void> {
    await Promise.all(Array.from(this.pipelines.values()).map(p => p.cleanup()));
    this.pipelines.clear();
    this.isInitialized = false;
  }
}
