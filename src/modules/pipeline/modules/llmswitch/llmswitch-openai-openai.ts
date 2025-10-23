/**
 * OpenAI Normalizer LLM Switch
 * Standardizes OpenAI requests to ensure proper format before processing.
 */

import type { LLMSwitchModule, ModuleConfig, ModuleDependencies } from '../../interfaces/pipeline-interfaces.js';
import type { SharedPipelineRequest } from '../../../../types/shared-dtos.js';
import { normalizeChatRequest, normalizeChatResponse } from '@routecodex/llmswitch-core/conversion';

/**
 * OpenAI Normalizer LLM Switch Module
 * Ensures OpenAI Chat Completions requests are properly formatted
 */
export class OpenAINormalizerLLMSwitch implements LLMSwitchModule {
  readonly id: string;
  readonly type = 'llmswitch-openai-openai';
  readonly config: ModuleConfig;
  readonly protocol = 'openai';
  private isInitialized = false;

  constructor(config: ModuleConfig, _dependencies: ModuleDependencies) {
    this.id = `llmswitch-openai-openai-${Date.now()}`;
    this.config = config;
  }

  async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }
    this.isInitialized = true;
  }

  async processIncoming(requestParam: any): Promise<SharedPipelineRequest> {
    if (!this.isInitialized) {
      await this.initialize();
    }

    const isDto = requestParam && typeof requestParam === 'object' && 'data' in requestParam && 'route' in requestParam;
    const dto = isDto ? (requestParam as SharedPipelineRequest) : null;
    const payload = isDto ? (dto!.data as any) : (requestParam as any);

    const normalized = normalizeChatRequest(payload);

    const outDto: SharedPipelineRequest = isDto
      ? { ...dto!, data: { ...normalized, _metadata: { switchType: 'llmswitch-openai-openai', timestamp: Date.now(), originalProtocol: 'openai', targetProtocol: 'openai' } } }
      : {
          data: { ...normalized, _metadata: { switchType: 'llmswitch-openai-openai', timestamp: Date.now(), originalProtocol: 'openai', targetProtocol: 'openai' } },
          route: { providerId: 'unknown', modelId: 'unknown', requestId: 'unknown', timestamp: Date.now() },
          metadata: {},
          debug: { enabled: false, stages: {} }
        };
    return outDto;
  }

  async processOutgoing(response: any): Promise<any> {
    // Accept either raw payload or DTO { data, metadata }
    const isDto = response && typeof response === 'object' && 'data' in response && 'metadata' in response;
    const payload = isDto ? (response as any).data : response;
    const normalized = normalizeChatResponse(payload);
    if (isDto) {
      return { ...(response as any), data: normalized };
    }
    return normalized;
  }

  async transformRequest(request: any): Promise<any> {
    return this.processIncoming(request);
  }

  async transformResponse(response: any): Promise<any> {
    return response;
  }

  // normalization moved to sharedmodule/llmswitch-core

  async dispose(): Promise<void> {
    this.isInitialized = false;
  }

  async cleanup(): Promise<void> {
    await this.dispose();
  }

  getStats(): any {
    return {
      type: this.type,
      initialized: this.isInitialized,
      timestamp: Date.now()
    };
  }
}
