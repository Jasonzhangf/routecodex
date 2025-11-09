/**
 * iFlow compatibility wrapper (adapter)
 * Bridges legacy factory signature to the new modular implementation under ./iflow/iflow-compatibility.ts
 * Minimal implementation: delegates all calls to the new class; ignores config at construction.
 */
import type { CompatibilityModule, ModuleConfig, ModuleDependencies, TransformationRule } from '../../interfaces/pipeline-interfaces.js';
import type { CompatibilityContext } from './compatibility-interface.js';
import type { UnknownObject } from '../../../../types/common-types.js';
import type { SharedPipelineRequest } from '../../../../types/shared-dtos.js';
import { iFlowCompatibility as Impl } from './iflow/iflow-compatibility.js';

export class iFlowCompatibility implements CompatibilityModule {
  readonly id: string;
  readonly type = 'iflow-compatibility';
  readonly config: ModuleConfig;
  readonly rules: TransformationRule[] = [];
  private impl: Impl;

  constructor(config: ModuleConfig, dependencies: ModuleDependencies) {
    this.config = config;
    this.impl = new Impl(dependencies);
    this.id = `compatibility-iflow-${Date.now()}`;
  }

  async initialize(): Promise<void> {
    await this.impl.initialize();
  }

  private makeContext(direction: 'incoming' | 'outgoing', payload: any): CompatibilityContext {
    const reqId = (payload && typeof payload === 'object' && (payload as any).route?.requestId)
      ? String((payload as any).route.requestId)
      : `req_${Date.now()}`;
    return {
      compatibilityId: this.id,
      profileId: 'iflow-standard',
      providerType: 'iflow',
      direction,
      stage: direction === 'incoming' ? 'request_processing' : 'response_processing',
      requestId: reqId,
      executionId: `exec_${Date.now()}`,
      timestamp: Date.now(),
      startTime: Date.now(),
      metadata: {
        dataSize: (() => { try { return JSON.stringify(payload).length; } catch { return 0; } })(),
        dataKeys: (payload && typeof payload === 'object') ? Object.keys(payload as Record<string, unknown>) : [],
      }
    } as CompatibilityContext;
  }

  async applyTransformations(data: any, _rules: TransformationRule[]): Promise<unknown> {
    // Compatibility adapter: transformations handled inside impl; return data as-is for now
    return data;
  }

  async processIncoming(request: SharedPipelineRequest): Promise<SharedPipelineRequest> {
    const ctx = this.makeContext('incoming', request);
    const out = await this.impl.processIncoming(request as unknown as UnknownObject, ctx);
    return out as unknown as SharedPipelineRequest;
  }

  async processOutgoing(response: any): Promise<unknown> {
    const ctx = this.makeContext('outgoing', response);
    return await this.impl.processOutgoing(response as UnknownObject, ctx);
  }

  async cleanup(): Promise<void> {
    await this.impl.cleanup();
  }
}
