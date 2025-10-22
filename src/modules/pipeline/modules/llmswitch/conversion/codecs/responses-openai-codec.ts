import type { ModuleDependencies } from '../../../../interfaces/pipeline-interfaces.js';
import type { ConversionCodec, ConversionContext, ConversionProfile } from '../types.js';
import type { SharedPipelineRequest, SharedPipelineResponse } from '../../../../../../types/shared-dtos.js';
import { ResponsesToChatLLMSwitch } from '../../llmswitch-response-chat.js';

export class ResponsesOpenAIConversionCodec implements ConversionCodec {
  readonly id = 'responses-openai';
  private readonly adapter: ResponsesToChatLLMSwitch;
  private initialized = false;

  constructor(private readonly dependencies: ModuleDependencies) {
    this.adapter = new ResponsesToChatLLMSwitch(
      { type: 'llmswitch-response-chat', config: {} },
      dependencies
    );
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }
    await this.adapter.initialize();
    this.initialized = true;
  }

  async convertRequest(payload: any, profile: ConversionProfile, context: ConversionContext): Promise<any> {
    await this.ensureInit();
    const dto: SharedPipelineRequest = {
      data: payload,
      route: {
        providerId: 'unknown',
        modelId: (payload && typeof payload === 'object' && (payload as any).model) ? String((payload as any).model) : 'unknown',
        requestId: context.requestId ?? `req_${Date.now()}`,
        timestamp: Date.now()
      },
      metadata: {
        endpoint: context.endpoint ?? context.entryEndpoint,
        entryEndpoint: context.entryEndpoint,
        targetProtocol: profile.outgoingProtocol
      },
      debug: { enabled: false, stages: {} }
    };
    const transformed = await this.adapter.processIncoming(dto);
    return transformed.data;
  }

  async convertResponse(payload: any, profile: ConversionProfile, context: ConversionContext): Promise<any> {
    await this.ensureInit();
    const dto: SharedPipelineResponse = {
      data: payload,
      metadata: {
        requestId: context.requestId ?? `req_${Date.now()}`,
        pipelineId: context.metadata?.pipelineId as string ?? 'conversion-router',
        processingTime: 0,
        stages: []
      }
    } as SharedPipelineResponse;
    const transformed = await this.adapter.processOutgoing(dto);
    if (transformed && typeof transformed === 'object' && 'data' in transformed) {
      return (transformed as SharedPipelineResponse).data;
    }
    return transformed;
  }

  private async ensureInit(): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }
  }
}
