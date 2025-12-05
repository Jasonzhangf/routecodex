import type { UnknownObject } from '../../modules/pipeline/types/common-types.js';

export interface CompatibilityMetadata extends Record<string, unknown> {
  dataSize: number;
  dataKeys: string[];
}

/**
 * 兼容性上下文接口
 */
export interface CompatibilityContext {
  compatibilityId: string;
  profileId: string;
  providerType: string;
  providerFamily?: string;
  providerId?: string;
  direction: 'incoming' | 'outgoing';
  stage: string;
  requestId: string;
  executionId: string;
  timestamp: number;
  startTime: number;
  entryEndpoint?: string; // 端点信息，用于BaseCompatibility决策
  metadata: CompatibilityMetadata;
}

/**
 * 兼容性模块接口
 */
export interface CompatibilityModule {
  readonly id: string;
  readonly type: string;
  readonly providerType?: string;

  initialize(): Promise<void>;
  processIncoming(request: UnknownObject, context: CompatibilityContext): Promise<UnknownObject>;
  processOutgoing(response: UnknownObject, context: CompatibilityContext): Promise<UnknownObject>;
  cleanup(): Promise<void>;
}
