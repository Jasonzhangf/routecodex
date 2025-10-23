import type { ModuleDependencies } from '../../../../interfaces/pipeline-interfaces.js';
import type { ConversionCodec, ConversionContext, ConversionProfile } from '../types.js';
import type { SharedPipelineRequest, SharedPipelineResponse } from '../../../../../../types/shared-dtos.js';
import { captureResponsesContext, buildChatRequestFromResponses, buildResponsesPayloadFromChat } from 'rcc-llmswitch-core/conversion';

export class ResponsesOpenAIConversionCodec implements ConversionCodec {
  readonly id = 'responses-openai';
  private initialized = false;
  private ctxMap: Map<string, any> = new Map();

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(private readonly dependencies: ModuleDependencies) {}

  async initialize(): Promise<void> { this.initialized = true; }

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
    // Build context and convert to OpenAI Chat request
    const ctx = captureResponsesContext(dto.data as any, dto);
    const { request: chatRequest, toolsNormalized } = buildChatRequestFromResponses(dto.data as any, ctx);
    if (toolsNormalized) ctx.toolsNormalized = toolsNormalized;
    if (context.requestId) this.ctxMap.set(context.requestId, ctx);
    return chatRequest;
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
    const ctx = context.requestId ? this.ctxMap.get(context.requestId) : undefined;
    if (context.requestId) this.ctxMap.delete(context.requestId);
    // Convert provider chat response back to Responses payload using captured context
    return buildResponsesPayloadFromChat(dto.data, ctx);
  }

  private async ensureInit(): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }
  }
}
