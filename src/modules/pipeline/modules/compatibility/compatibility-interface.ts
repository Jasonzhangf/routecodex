import type { UnknownObject } from '../../../../types/common-types.js';

/**
 * 兼容性上下文接口
 */
export interface CompatibilityContext {
  compatibilityId: string;
  profileId: string;
  providerType: string;
  direction: 'incoming' | 'outgoing';
  stage: string;
  requestId: string;
  executionId: string;
  timestamp: number;
  startTime: number;
  metadata: {
    dataSize: number;
    dataKeys: string[];
    [key: string]: any;
  };
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