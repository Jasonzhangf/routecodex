import type { PipelineModule, ModuleConfig } from '../../modules/pipeline/interfaces/pipeline-interfaces.js';
import type { SharedPipelineRequest } from '../../types/shared-dtos.js';
import type { UnknownObject } from '../../modules/pipeline/types/common-types.js';
import type { CompatibilityModule, CompatibilityContext } from './compatibility-interface.js';

type PipelineRequestLike = Partial<SharedPipelineRequest> & UnknownObject;

function isRecord(value: unknown): value is UnknownObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getStringProperty(source: UnknownObject | undefined, key: string): string | undefined {
  if (!source) {
    return undefined;
  }
  const value = source[key];
  return typeof value === 'string' ? value : undefined;
}

function normalizeMetadata(value: unknown): UnknownObject | undefined {
  return isRecord(value) ? value : undefined;
}

function safeJsonSize(payload: UnknownObject): number {
  try {
    return JSON.stringify(payload).length;
  } catch {
    return 0;
  }
}

/**
 * 适配器：将CompatibilityModule适配为PipelineModule接口
 * 用于PipelineManager中集成compatibility模块
 */
export class CompatibilityToPipelineAdapter implements PipelineModule<UnknownObject, UnknownObject> {
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

  async processIncoming(request: UnknownObject): Promise<UnknownObject> {
    const pipelineRequest = request as PipelineRequestLike;
    const route = isRecord(pipelineRequest.route) ? pipelineRequest.route : undefined;
    const metadataObj = normalizeMetadata(pipelineRequest.metadata);
    const pipelineRequestId =
      getStringProperty(route, 'requestId') ||
      getStringProperty(pipelineRequest, 'requestId') ||
      `req_${Date.now()}`;
    const entryEndpoint =
      getStringProperty(metadataObj, 'entryEndpoint') ||
      getStringProperty(route, 'entryEndpoint') ||
      '';

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
      entryEndpoint,
      metadata: {
        dataSize: safeJsonSize(pipelineRequest),
        dataKeys: Object.keys(pipelineRequest),
        config: this.config,
        ...(metadataObj || {})
      }
    };

    return await this.compatibilityModule.processIncoming(pipelineRequest, context);
  }

  async processOutgoing(response: UnknownObject): Promise<UnknownObject> {
    const responseRoute = isRecord(response.route) ? response.route : undefined;
    const responseMetadata = normalizeMetadata(response.metadata);
    const pipelineRequestId =
      getStringProperty(responseRoute, 'requestId') ||
      getStringProperty(response, 'requestId') ||
      getStringProperty(responseMetadata, 'requestId') ||
      `req_${Date.now()}`;
    const entryEndpoint =
      getStringProperty(responseMetadata, 'entryEndpoint') ||
      getStringProperty(responseRoute, 'entryEndpoint') ||
      '';

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
      entryEndpoint,
      metadata: {
        dataSize: safeJsonSize(response),
        dataKeys: Object.keys(response),
        config: this.config,
        ...(responseMetadata || {})
      }
    };

    return await this.compatibilityModule.processOutgoing(response, context);
  }

  async cleanup(): Promise<void> {
    return await this.compatibilityModule.cleanup();
  }
}
