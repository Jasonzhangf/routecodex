import type { ConversionCodec, ConversionContext, ConversionProfile } from '../../../types.js';
import type { JsonObject } from '../../../hub/types/json.js';
import type { ProtocolPipelineContext } from '../../hooks/protocol-hooks.js';
import {
  ProtocolConversionPipeline,
  type ProtocolInboundPipelineOptions,
  type ProtocolOutboundPipelineOptions
} from '../../index.js';
import type { ProtocolPipelineHooks } from '../../hooks/protocol-hooks.js';
import { buildAdapterContextFromPipeline } from '../../hooks/adapter-context.js';
import type { FormatEnvelope } from '../../../hub/types/format-envelope.js';
import { runStandardChatRequestFilters } from '../../../index.js';
import { ConversionMetaBag, type ConversionMetaRecord } from '../../meta/meta-bag.js';
import type { CanonicalChatRequest } from '../../schema/index.js';
import { chatEnvelopeToStandardizedWithNative } from '../../../../router/virtual-router/engine-selection/native-hub-pipeline-req-inbound-semantics.js';
import { parseReqInboundFormatEnvelopeWithNative } from '../../../../router/virtual-router/engine-selection/native-hub-pipeline-edge-stage-semantics.js';
import { mapOpenaiChatToChatWithNative } from '../../../../router/virtual-router/engine-selection/native-hub-pipeline-semantic-mappers.js';
import {
  canonicalizeOpenAIChatResponse,
  convertStandardizedToOpenAIChat as convertCanonicalToOpenAIChat,
  DEFAULT_OPENAI_ENDPOINT,
  OPENAI_PROTOCOL
} from './shared/openai-chat-helpers.js';

function assertJsonObject(value: unknown, stage: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`OpenAI pipeline codec requires JSON payload at ${stage}`);
  }
  return value as JsonObject;
}

function restoreToolCallIndexes(targetMessages: unknown, sourceMessages: unknown): void {
  if (!Array.isArray(targetMessages) || !Array.isArray(sourceMessages)) {
    return;
  }
  const sourceIndexMap = new Map<string, number>();
  for (const message of sourceMessages) {
    if (!message || typeof message !== 'object') continue;
    const toolCalls = (message as Record<string, unknown>).tool_calls;
    if (!Array.isArray(toolCalls)) continue;
    toolCalls.forEach((toolCall) => {
      if (!toolCall || typeof toolCall !== 'object') return;
      const id = typeof (toolCall as Record<string, unknown>).id === 'string'
        ? String((toolCall as Record<string, unknown>).id)
        : undefined;
      if (!id || sourceIndexMap.has(id)) return;
      const idxValue = (toolCall as Record<string, unknown>).index;
      if (typeof idxValue !== 'number') return;
      sourceIndexMap.set(id, idxValue);
    });
  }
  for (const message of targetMessages) {
    if (!message || typeof message !== 'object') continue;
    const toolCalls = (message as Record<string, unknown>).tool_calls;
    if (!Array.isArray(toolCalls)) continue;
    toolCalls.forEach((toolCall) => {
      if (!toolCall || typeof toolCall !== 'object') return;
      const id = typeof (toolCall as Record<string, unknown>).id === 'string'
        ? String((toolCall as Record<string, unknown>).id)
        : undefined;
      if (!id) return;
      const sourceIndex = sourceIndexMap.get(id);
      if (sourceIndex === undefined) return;
      (toolCall as Record<string, unknown>).index = sourceIndex;
    });
  }
}

function createOpenAIHooks(): ProtocolPipelineHooks<JsonObject, JsonObject> {
  return {
    id: 'openai-openai-v2',
    protocol: OPENAI_PROTOCOL,
    inbound: {
      parse: async ({ wire, context }) => {
        const adapterContext = buildAdapterContextFromPipeline(context, {
          defaultEntryEndpoint: DEFAULT_OPENAI_ENDPOINT,
          overrideProtocol: OPENAI_PROTOCOL
        });
        const formatEnvelope = parseReqInboundFormatEnvelopeWithNative({
          rawRequest: wire as unknown as Record<string, unknown>,
          protocol: OPENAI_PROTOCOL
        }) as unknown as FormatEnvelope<JsonObject>;
        const chatEnvelope = mapOpenaiChatToChatWithNative(
          (formatEnvelope.payload ?? {}) as Record<string, unknown>,
          adapterContext as unknown as Record<string, unknown>
        );
        const canonical = chatEnvelopeToStandardizedWithNative({
          chatEnvelope: chatEnvelope as Record<string, unknown>,
          adapterContext: adapterContext as unknown as Record<string, unknown>,
          endpoint: adapterContext.entryEndpoint ?? DEFAULT_OPENAI_ENDPOINT,
          requestId: adapterContext.requestId
        });
        return { canonical: canonical as unknown as CanonicalChatRequest };
      }
    },
    outbound: {
      serialize: async ({ canonical }) => {
        return { payload: assertJsonObject(canonical, 'openai_outbound_serialize') };
      }
    }
  };
}

function buildPipelineContext(profile: ConversionProfile, context: ConversionContext): ProtocolPipelineContext {
  return {
    requestId: context.requestId,
    entryEndpoint: context.entryEndpoint ?? context.endpoint ?? DEFAULT_OPENAI_ENDPOINT,
    providerProtocol: profile.incomingProtocol ?? context.targetProtocol ?? OPENAI_PROTOCOL,
    targetProtocol: profile.outgoingProtocol ?? context.targetProtocol ?? OPENAI_PROTOCOL,
    profileId: profile.id,
    stream: context.stream,
    metadata: context.metadata
  };
}

export class OpenAIOpenAIPipelineCodec implements ConversionCodec {
  readonly id = 'openai-openai-v2';
  private readonly pipeline: ProtocolConversionPipeline<JsonObject, JsonObject>;
  private readonly requestMetaStore = new Map<string, ConversionMetaRecord>();
  private initialized = false;

  constructor() {
    this.pipeline = new ProtocolConversionPipeline(createOpenAIHooks());
  }

  async initialize(): Promise<void> {
    this.initialized = true;
  }

  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error('OpenAIOpenAIPipelineCodec must be initialized before use');
    }
  }

  private stashMeta(requestId: string, bag: ConversionMetaBag): void {
    this.requestMetaStore.set(requestId, bag.snapshot());
  }

  private consumeMeta(requestId: string): ConversionMetaRecord | undefined {
    const stored = this.requestMetaStore.get(requestId);
    if (stored) {
      this.requestMetaStore.delete(requestId);
      return stored;
    }
    return undefined;
  }

  async convertRequest(payload: unknown, profile: ConversionProfile, context: ConversionContext): Promise<JsonObject> {
    this.ensureInitialized();
    const inboundContext = buildPipelineContext(profile, context);
    const requestId = context.requestId ?? inboundContext.requestId ?? `req_${Date.now()}`;
    inboundContext.requestId = requestId;

    const inboundPayload = assertJsonObject(payload, 'openai_inbound_request');
    const inboundOptions: ProtocolInboundPipelineOptions<JsonObject> = {
      payload: inboundPayload,
      context: inboundContext
    };
    const inbound = await this.pipeline.convertInbound(inboundOptions);
    this.stashMeta(requestId, inbound.meta);

    const openaiPayload = await convertCanonicalToOpenAIChat(inbound.canonical as CanonicalChatRequest, inbound.context);
    if (!Array.isArray((openaiPayload as Record<string, unknown>).tools) && Array.isArray((inboundPayload as Record<string, unknown>).tools)) {
      (openaiPayload as Record<string, unknown>).tools = (inboundPayload as Record<string, unknown>).tools;
    }
    if (
      (openaiPayload as Record<string, unknown>).tool_choice === undefined &&
      (inboundPayload as Record<string, unknown>).tool_choice !== undefined
    ) {
      (openaiPayload as Record<string, unknown>).tool_choice = (inboundPayload as Record<string, unknown>).tool_choice;
    }
    const filterContext: ConversionContext = {
      ...context,
      requestId,
      entryEndpoint: context.entryEndpoint ?? DEFAULT_OPENAI_ENDPOINT,
      endpoint: context.endpoint ?? DEFAULT_OPENAI_ENDPOINT
    };
    const filtered = await runStandardChatRequestFilters(openaiPayload, profile, filterContext);
    if (filtered && typeof filtered === 'object') {
      restoreToolCallIndexes((filtered as Record<string, unknown>).messages, (inboundPayload as Record<string, unknown>).messages);
    }
    return filtered;
  }

  async convertResponse(payload: unknown, profile: ConversionProfile, context: ConversionContext): Promise<JsonObject> {
    this.ensureInitialized();
    const pipelineContext = buildPipelineContext(profile, context);
    const requestId = context.requestId ?? pipelineContext.requestId ?? `req_${Date.now()}`;
    pipelineContext.requestId = requestId;
    const storedMeta = this.consumeMeta(requestId);

    const sanitized = await canonicalizeOpenAIChatResponse(
      assertJsonObject(payload, 'openai_chat_response'),
      context
    );
    const outboundOptions: ProtocolOutboundPipelineOptions<JsonObject> = {
      canonical: sanitized,
      context: pipelineContext,
      meta: storedMeta
    };
    const outbound = await this.pipeline.convertOutbound(outboundOptions);
    return outbound.payload;
  }
}
