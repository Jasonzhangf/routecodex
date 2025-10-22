import type { LLMSwitchModule, ModuleConfig, ModuleDependencies } from '../../interfaces/pipeline-interfaces.js';
import type { SharedPipelineRequest, SharedPipelineResponse } from '../../../../types/shared-dtos.js';
import type { PipelineDebugLogger } from '../../interfaces/pipeline-interfaces.js';
import {
  buildChatRequestFromResponses,
  buildResponsesPayloadFromChat,
  captureResponsesContext,
  extractRequestIdFromResponse,
  type ResponsesRequestContext
} from './conversion/responses/responses-openai-bridge.js';

export class ResponsesToChatLLMSwitch implements LLMSwitchModule {
  readonly id: string;
  readonly type = 'llmswitch-response-chat';
  readonly protocol = 'openai-responses';
  readonly config: ModuleConfig;

  private isInitialized = false;
  private logger: PipelineDebugLogger;
  private requestContext: Map<string, ResponsesRequestContext> = new Map();
  private chatReqValidator: ((v: unknown) => boolean) | null = null;
  private responsesValidator: ((v: unknown) => boolean) | null = null;

  constructor(config: ModuleConfig, dependencies: ModuleDependencies) {
    this.config = config;
    this.id = `llmswitch-response-chat-${Date.now()}`;
    this.logger = dependencies.logger;
  }

  async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }
    this.isInitialized = true;

    try {
      const AjvMod: any = await import('ajv');
      const ajv = new AjvMod.default({ allErrors: true, strict: false });
      const chatSchema = {
        type: 'object',
        required: ['model', 'messages'],
        additionalProperties: true,
        properties: {
          model: { type: 'string', minLength: 1 },
          stream: { type: 'boolean' },
          messages: {
            type: 'array',
            minItems: 1,
            items: {
              type: 'object',
              required: ['role'],
              additionalProperties: true,
              properties: {
                role: { enum: ['system', 'user', 'assistant', 'tool'] },
                content: { anyOf: [{ type: 'string' }, { type: 'null' }, { type: 'object' }, { type: 'array' }] },
                tool_calls: { type: 'array' }
              }
            }
          },
          tools: { type: 'array' }
        }
      } as const;
      const responsesSchema = {
        type: 'object',
        required: ['object', 'model', 'output'],
        additionalProperties: true,
        properties: {
          object: { const: 'response' },
          model: { type: 'string' },
          status: { enum: ['in_progress', 'completed'] },
          output_text: { type: 'string' },
          output: { type: 'array' },
          required_action: { type: 'object' }
        }
      } as const;
      this.chatReqValidator = ajv.compile(chatSchema);
      this.responsesValidator = ajv.compile(responsesSchema);
    } catch {
      /* optional runtime validation */
    }
  }

  async processIncoming(requestParam: SharedPipelineRequest | any): Promise<SharedPipelineRequest> {
    if (!this.isInitialized) {
      await this.initialize();
    }

    const isDto = requestParam && typeof requestParam === 'object' && 'data' in requestParam && 'route' in requestParam;
    const dto = isDto ? (requestParam as SharedPipelineRequest) : null;
    const payload = isDto ? (dto!.data as Record<string, unknown>) : (requestParam as Record<string, unknown>);

    const context = captureResponsesContext(payload, dto ?? undefined);
    const { request: chatRequest, toolsNormalized } = buildChatRequestFromResponses(payload, context);
    if (toolsNormalized) {
      context.toolsNormalized = toolsNormalized;
    }
    if (context.requestId) {
      this.requestContext.set(context.requestId, context);
    }

    try {
      if (this.chatReqValidator && !this.chatReqValidator(chatRequest)) {
        throw new Error('Responses→Chat produced invalid Chat request');
      }
    } catch {
      /* soft validation */
    }

    const stamped = {
      ...chatRequest,
      _metadata: {
        ...(chatRequest as any)._metadata || {},
        switchType: this.type,
        timestamp: Date.now(),
        entryProtocol: 'responses',
        targetProtocol: 'openai'
      }
    } as Record<string, unknown>;

    this.logger.logTransformation(this.id, 'responses-to-chat-request', payload, stamped);

    if (isDto) {
      return {
        ...dto!,
        data: stamped,
        metadata: {
          ...(dto!.metadata || {}),
          rccResponsesContext: context
        }
      };
    }

    return {
      data: stamped,
      route: {
        providerId: 'unknown',
        modelId: 'unknown',
        requestId: context.requestId || `req_${Date.now()}`,
        timestamp: Date.now()
      },
      metadata: { rccResponsesContext: context },
      debug: { enabled: false, stages: {} }
    } satisfies SharedPipelineRequest;
  }

  async processOutgoing(responseParam: SharedPipelineResponse | any): Promise<SharedPipelineResponse | any> {
    if (!this.isInitialized) {
      await this.initialize();
    }

    const isDto = responseParam && typeof responseParam === 'object' && 'data' in responseParam && 'metadata' in responseParam;
    const payload = isDto ? (responseParam as SharedPipelineResponse).data : responseParam;

    const requestId = extractRequestIdFromResponse(responseParam);
    const context = requestId ? this.requestContext.get(requestId) : undefined;
    if (requestId && context) {
      this.requestContext.delete(requestId);
    }

    let converted = payload;
    if (context && context.isResponsesPayload) {
      converted = buildResponsesPayloadFromChat(payload, context);
      try {
        if (this.responsesValidator && !this.responsesValidator(converted)) {
          throw new Error('Chat→Responses produced invalid Responses payload');
        }
      } catch {
        /* soft validation */
      }
    }

    this.logger.logTransformation(this.id, 'chat-to-responses', payload, converted);

    if (isDto) {
      const baseMeta = { ...((responseParam as SharedPipelineResponse).metadata || {}) } as Record<string, unknown>;
      if (context && context.isResponsesPayload) {
        (baseMeta as any).responsesStatus = (converted as any)?.status || 'completed';
      }
      return { ...(responseParam as SharedPipelineResponse), data: converted, metadata: baseMeta as any };
    }

    return converted;
  }

  async transformRequest(request: unknown): Promise<unknown> {
    const dto = await this.processIncoming(request as any);
    return dto.data;
  }

  async transformResponse(response: unknown): Promise<unknown> {
    const converted = buildResponsesPayloadFromChat(response, undefined);
    try {
      if (this.responsesValidator && !this.responsesValidator(converted)) {
        throw new Error('Chat→Responses produced invalid Responses payload');
      }
    } catch {
      /* soft validation */
    }
    return converted;
  }

  async cleanup(): Promise<void> {
    this.requestContext.clear();
    this.isInitialized = false;
  }

  async dispose(): Promise<void> {
    await this.cleanup();
  }

  getStats(): Record<string, unknown> {
    return {
      type: this.type,
      initialized: this.isInitialized,
      trackedRequests: this.requestContext.size,
      timestamp: Date.now()
    };
  }
}
