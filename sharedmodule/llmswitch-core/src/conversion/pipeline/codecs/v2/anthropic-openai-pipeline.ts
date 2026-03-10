import type { ConversionCodec, ConversionContext, ConversionProfile } from '../../../types.js';
import type { JsonObject } from '../../../hub/types/json.js';
import type { ProtocolPipelineContext } from '../../hooks/protocol-hooks.js';
import { buildAdapterContextFromPipeline } from '../../hooks/adapter-context.js';
import { runStandardChatRequestFilters } from '../../../index.js';
import { buildAnthropicFromOpenAIChat } from '../../../codecs/anthropic-openai-codec.js';
import { buildOpenAIChatFromAnthropicWithNative } from '../../../../router/virtual-router/engine-selection/native-compat-action-semantics.js';
import { chatEnvelopeToStandardizedWithNative } from '../../../../router/virtual-router/engine-selection/native-hub-pipeline-req-inbound-semantics.js';
import { parseReqInboundFormatEnvelopeWithNative } from '../../../../router/virtual-router/engine-selection/native-hub-pipeline-edge-stage-semantics.js';
import { mapOpenaiChatToChatWithNative } from '../../../../router/virtual-router/engine-selection/native-hub-pipeline-semantic-mappers.js';
import {
  canonicalizeOpenAIChatResponse,
  convertStandardizedToOpenAIChat as convertCanonicalToOpenAIChat,
  OPENAI_PROTOCOL
} from './shared/openai-chat-helpers.js';

const DEFAULT_ANTHROPIC_ENDPOINT = '/v1/messages';
const ANTHROPIC_PROTOCOL = 'anthropic-messages';

function assertJsonObject(value: unknown, stage: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Anthropic pipeline codec requires JSON object payload at ${stage}`);
  }
  return value as JsonObject;
}

function normalizeAliasMap(candidate: unknown): Record<string, string> | undefined {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return undefined;
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(candidate)) {
    if (typeof key !== 'string' || typeof value !== 'string') {
      continue;
    }
    const trimmed = key.trim();
    if (!trimmed) {
      continue;
    }
    out[trimmed] = value;
  }
  return Object.keys(out).length ? out : undefined;
}

function buildPipelineContext(profile: ConversionProfile, context: ConversionContext): ProtocolPipelineContext {
  return {
    requestId: context.requestId,
    entryEndpoint: context.entryEndpoint ?? context.endpoint ?? DEFAULT_ANTHROPIC_ENDPOINT,
    providerProtocol: context.targetProtocol ?? profile.incomingProtocol ?? ANTHROPIC_PROTOCOL,
    targetProtocol: profile.outgoingProtocol ?? context.targetProtocol ?? OPENAI_PROTOCOL,
    profileId: profile.id,
    stream: context.stream,
    metadata: context.metadata
  };
}

export class AnthropicOpenAIPipelineCodec implements ConversionCodec {
  readonly id = 'anthropic-openai-v2';
  private readonly requestMetaStore = new Map<string, { aliasMap?: Record<string, string> }>();
  private initialized = false;

  async initialize(): Promise<void> {
    this.initialized = true;
  }

  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error('AnthropicOpenAIPipelineCodec must be initialized before use');
    }
  }

  async convertRequest(payload: unknown, profile: ConversionProfile, context: ConversionContext): Promise<JsonObject> {
    this.ensureInitialized();
    const inboundContext = buildPipelineContext(profile, context);
    const requestId = context.requestId ?? inboundContext.requestId ?? `req_${Date.now()}`;
    inboundContext.requestId = requestId;
    const adapterContext = buildAdapterContextFromPipeline(inboundContext, {
      defaultEntryEndpoint: DEFAULT_ANTHROPIC_ENDPOINT,
      overrideProtocol: ANTHROPIC_PROTOCOL
    });

    const native = buildOpenAIChatFromAnthropicWithNative(
      assertJsonObject(payload, 'anthropic_inbound_request') as unknown as Record<string, unknown>,
      { includeToolCallIds: true }
    );
    const openaiRequest = assertJsonObject(native.request, 'anthropic_request_native');
    const aliasMap = normalizeAliasMap(native.anthropicToolNameMap);
    this.requestMetaStore.set(requestId, { aliasMap });

    const formatEnvelope = parseReqInboundFormatEnvelopeWithNative({
      rawRequest: openaiRequest as unknown as Record<string, unknown>,
      protocol: OPENAI_PROTOCOL
    });
    const chatEnvelope = mapOpenaiChatToChatWithNative(
      ((formatEnvelope as Record<string, unknown>).payload ?? {}) as Record<string, unknown>,
      adapterContext as unknown as Record<string, unknown>
    );
    const canonical = chatEnvelopeToStandardizedWithNative({
      chatEnvelope,
      adapterContext: adapterContext as unknown as Record<string, unknown>,
      endpoint: adapterContext.entryEndpoint ?? DEFAULT_ANTHROPIC_ENDPOINT,
      requestId
    });
    const rebuilt = await convertCanonicalToOpenAIChat(
      canonical as any,
      inboundContext,
      { defaultEndpoint: DEFAULT_ANTHROPIC_ENDPOINT }
    );

    const filterContext: ConversionContext = {
      ...context,
      requestId,
      entryEndpoint: context.entryEndpoint ?? context.endpoint ?? DEFAULT_ANTHROPIC_ENDPOINT,
      endpoint: context.endpoint ?? context.entryEndpoint ?? DEFAULT_ANTHROPIC_ENDPOINT
    };
    return runStandardChatRequestFilters(rebuilt, profile, filterContext);
  }

  async convertResponse(payload: unknown, profile: ConversionProfile, context: ConversionContext): Promise<JsonObject> {
    this.ensureInitialized();
    const pipelineContext = buildPipelineContext(profile, context);
    const requestId = context.requestId ?? pipelineContext.requestId ?? `req_${Date.now()}`;
    pipelineContext.requestId = requestId;
    const stored = this.requestMetaStore.get(requestId);
    this.requestMetaStore.delete(requestId);

    const sanitized = await canonicalizeOpenAIChatResponse(
      assertJsonObject(payload, 'openai_chat_response'),
      context,
      { defaultEndpoint: DEFAULT_ANTHROPIC_ENDPOINT, profile: ANTHROPIC_PROTOCOL }
    );
    return assertJsonObject(
      buildAnthropicFromOpenAIChat(sanitized, {
        toolNameMap: stored?.aliasMap,
        requestId,
        entryEndpoint: pipelineContext.entryEndpoint ?? DEFAULT_ANTHROPIC_ENDPOINT
      }),
      'anthropic_outbound_serialize'
    );
  }
}
