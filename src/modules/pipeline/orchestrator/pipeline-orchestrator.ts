import { PipelineBlueprintManager } from './pipeline-blueprint-manager.js';
import type { PipelineBlueprint, PipelinePhase, ResolveOptions } from './types.js';
import { PipelineContext, type PipelineMetadata } from './pipeline-context.js';

export interface PipelineOrchestratorOptions {
  configPath?: string;
  baseDir?: string;
}

export interface PipelineResolveOptions extends ResolveOptions {
  phase?: PipelinePhase;
}

/**
 * PipelineOrchestrator 负责在 host 层解析 pipeline-config，
 * 并在请求/响应入口按照 endpoint + providerProtocol + processMode 命中唯一 blueprint。
 */
export class PipelineOrchestrator {
  private readonly manager: PipelineBlueprintManager;
  private readonly options: PipelineOrchestratorOptions;
  private ready = false;

  constructor(options: PipelineOrchestratorOptions = {}) {
    this.manager = new PipelineBlueprintManager();
    this.options = options;
  }

  async initialize(force = false): Promise<void> {
    if (this.ready && !force) return;
    await this.manager.ensureLoaded({
      configPath: this.options.configPath,
      baseDir: this.options.baseDir,
      force
    });
    this.ready = true;
  }

  async resolve(entryEndpoint: string, opts: PipelineResolveOptions = {}): Promise<PipelineBlueprint | null> {
    if (!this.ready) {
      await this.initialize();
    }
    return this.manager.resolve(entryEndpoint, opts);
  }

  async getPipelineById(pipelineId: string): Promise<PipelineBlueprint | null> {
    if (!this.ready) {
      await this.initialize();
    }
    return this.manager.getById(pipelineId);
  }

  async listBlueprints(): Promise<PipelineBlueprint[]> {
    if (!this.ready) {
      await this.initialize();
    }
    return this.manager.listBlueprints();
  }

  getSourcePath(): string | undefined {
    return this.manager.getSourcePath();
  }

  createContext(
    blueprint: PipelineBlueprint,
    phase: PipelinePhase,
    metadata: PipelineMetadata
  ): PipelineContext {
    return new PipelineContext(blueprint, phase, metadata);
  }
}
