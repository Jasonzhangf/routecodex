import type { ModuleDependencies } from '../../../../interfaces/pipeline-interfaces.js';
import type { ConversionCodec, ConversionContext, ConversionProfile } from '../types.js';
import type { SharedPipelineRequest, SharedPipelineResponse } from '../../../../../../types/shared-dtos.js';
import { OpenAINormalizerLLMSwitch } from '../../llmswitch-openai-openai.js';

export class OpenAIOpenAIConversionCodec implements ConversionCodec {
  readonly id = 'openai-openai';
  private readonly normalizer: OpenAINormalizerLLMSwitch;
  private initialized = false;

  constructor(private readonly dependencies: ModuleDependencies) {
    this.normalizer = new OpenAINormalizerLLMSwitch(
      { type: 'llmswitch-openai-openai', config: {} },
      dependencies
    );
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }
    if (typeof this.normalizer.initialize === 'function') {
      await this.normalizer.initialize();
    }
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
    const transformed = await this.normalizer.processIncoming(dto);
    return transformed.data;
  }

  async convertResponse(payload: any, profile: ConversionProfile, context: ConversionContext): Promise<any> {
    await this.ensureInit();
    // unwrap nested { data: {...} } wrappers until we reach an object
    // that contains OpenAI chat response fields (e.g., choices)
    const unwrap = (obj: any): any => {
      let cur = obj;
      const guard = new Set<any>();
      while (cur && typeof cur === 'object' && !Array.isArray(cur) && !guard.has(cur)) {
        guard.add(cur);
        if ('choices' in cur || 'id' in cur || 'object' in cur) { break; }
        if ('data' in cur && cur.data && typeof cur.data === 'object') { cur = cur.data; continue; }
        break;
      }
      return cur;
    };
    const unwrapped = unwrap(payload);
    const dto: SharedPipelineResponse = {
      data: unwrapped,
      metadata: {
        requestId: context.requestId ?? `req_${Date.now()}`,
        pipelineId: context.metadata?.pipelineId as string ?? 'conversion-router',
        processingTime: 0,
        stages: []
      }
    } as SharedPipelineResponse;
    const transformed = await this.normalizer.processOutgoing(dto);
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
