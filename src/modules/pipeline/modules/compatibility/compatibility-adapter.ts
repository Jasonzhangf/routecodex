import type { PipelineModule, ModuleConfig, ModuleDependencies } from '../../interfaces/pipeline-interfaces.js';
import type { CompatibilityModule, CompatibilityContext } from './compatibility-interface.js';

/**
 * 适配器：将CompatibilityModule适配为PipelineModule接口
 * 用于PipelineManager中集成compatibility模块
 */
export class CompatibilityToPipelineAdapter implements PipelineModule {
  readonly id: string;
  readonly type: string;
  readonly config: ModuleConfig;

  private compatibilityModule: CompatibilityModule;

  constructor(compatibilityModule: CompatibilityModule, config: ModuleConfig) {
    this.compatibilityModule = compatibilityModule;
    this.config = config;
    this.id = compatibilityModule.id;
    this.type = compatibilityModule.type;
  }

  async initialize(): Promise<void> {
    return await this.compatibilityModule.initialize();
  }

  async processIncoming(request: any): Promise<unknown> {
    // 从pipeline request中提取真实的元数据
    const pipelineRequestId = request.route?.requestId || request.requestId || `req_${Date.now()}`;
    const entryEndpoint = request.metadata?.entryEndpoint || request.route?.entryEndpoint || '';

    // 创建CompatibilityContext
    const context: CompatibilityContext = {
      compatibilityId: this.compatibilityModule.id,
      profileId: `${this.compatibilityModule.providerType || 'default'}-${this.type}`,
      providerType: this.compatibilityModule.providerType || this.type,
      direction: 'incoming',
      stage: 'request_processing',
      requestId: pipelineRequestId,
      executionId: `exec_${Date.now()}`,
      timestamp: Date.now(),
      startTime: Date.now(),
      entryEndpoint, // 在顶层设置entryEndpoint
      metadata: {
        dataSize: JSON.stringify(request).length,
        dataKeys: Object.keys(request),
        config: this.config,
        ...request.metadata
      }
    };

    return await this.compatibilityModule.processIncoming(request, context);
  }

  async processOutgoing(response: any): Promise<unknown> {
    // 从response中提取真实的元数据
    const pipelineRequestId = response.route?.requestId || response.requestId || response.metadata?.requestId || `req_${Date.now()}`;
    const entryEndpoint = response.metadata?.entryEndpoint || response.route?.entryEndpoint || '';

    // 创建CompatibilityContext
    const context: CompatibilityContext = {
      compatibilityId: this.compatibilityModule.id,
      profileId: `${this.compatibilityModule.providerType || 'default'}-${this.type}`,
      providerType: this.compatibilityModule.providerType || this.type,
      direction: 'outgoing',
      stage: 'response_processing',
      requestId: pipelineRequestId,
      executionId: `exec_${Date.now()}`,
      timestamp: Date.now(),
      startTime: Date.now(),
      entryEndpoint, // 在顶层设置entryEndpoint
      metadata: {
        dataSize: JSON.stringify(response).length,
        dataKeys: Object.keys(response),
        config: this.config,
        ...response.metadata
      }
    };

    return await this.compatibilityModule.processOutgoing(response, context);
  }

  async cleanup(): Promise<void> {
    return await this.compatibilityModule.cleanup();
  }
}