import type { ConversionCodec, ConversionContext, ConversionProfile } from '../../../types.js';
import type { JsonObject } from '../../../hub/types/json.js';
import type { ProtocolPipelineContext } from '../../hooks/protocol-hooks.js';
import { runStandardChatRequestFilters } from '../../../index.js';
import {
  buildChatRequestFromResponses,
  buildResponsesPayloadFromChat,
  collectResponsesRequestParameters,
  captureResponsesContext,
  type ResponsesRequestContext
} from '../../../responses/responses-openai-bridge.js';
import { ConversionMetaBag, type ConversionMetaRecord } from '../../meta/meta-bag.js';
import {
  canonicalizeOpenAIChatResponse,
  convertStandardizedToOpenAIChat as convertCanonicalToOpenAIChat,
  DEFAULT_OPENAI_ENDPOINT,
  OPENAI_PROTOCOL
} from './shared/openai-chat-helpers.js';
import { buildAdapterContextFromPipeline } from '../../hooks/adapter-context.js';
import { chatEnvelopeToStandardizedWithNative } from '../../../../router/virtual-router/engine-selection/native-hub-pipeline-req-inbound-semantics.js';
import { standardizedToChatEnvelopeWithNative } from '../../../../router/virtual-router/engine-selection/native-hub-pipeline-req-outbound-semantics.js';

const DEFAULT_RESPONSES_ENDPOINT = '/v1/responses';
const RESPONSES_PROTOCOL = 'openai-responses';

function formatUnknownError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack || `${error.name}: ${error.message}`;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function logResponsesOpenAiPipelineNonBlocking(
  stage: string,
  error: unknown,
  details: Record<string, unknown> = {}
): void {
  try {
    const detailSuffix = Object.keys(details).length ? ` details=${JSON.stringify(details)}` : '';
    console.warn(`[responses-openai-pipeline] ${stage} failed (non-blocking): ${formatUnknownError(error)}${detailSuffix}`);
  } catch {
    // Never throw from non-blocking logging.
  }
}

function assertJsonObject(value: unknown, stage: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Responses pipeline codec requires JSON payload at ${stage}`);
  }
  return value as JsonObject;
}

function sanitizeResponsesMessages(payload: JsonObject): void {
  const messages = Array.isArray((payload as any)?.messages) ? ((payload as any).messages as Array<Record<string, unknown>>) : [];
  if (!messages.length) return;
  const sanitized: Array<Record<string, unknown>> = [];
  let counter = 0;
  const normalizeId = (raw: unknown): string | undefined => {
    if (typeof raw !== 'string') return undefined;
    const trimmed = raw.trim();
    if (!trimmed.length) return undefined;
    if (trimmed.startsWith('fc_')) return trimmed;
    const stripped = trimmed.replace(/^call[_-]?/i, '');
    const normalized = stripped.length ? stripped : trimmed;
    return normalized.startsWith('fc_') ? normalized : `fc_${normalized}`;
  };
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;
    const role = String(message.role || '').toLowerCase();
    if (role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length) {
      message.tool_calls = message.tool_calls.map((call: any) => {
        if (!call || typeof call !== 'object') return call;
        const existing = normalizeId(call.id) ?? normalizeId(call.call_id) ?? `fc_function_call_${counter++}`;
        if (existing) {
          call.id = existing;
        }
        if (call.call_id !== undefined) delete call.call_id;
        if (call.tool_call_id !== undefined) delete call.tool_call_id;
        return call;
      });
      sanitized.push(message);
      continue;
    }
    if (role === 'tool') {
      const clone: Record<string, unknown> = { ...message };
      const normalizedToolId = normalizeId(clone.tool_call_id ?? clone.call_id);
      if (normalizedToolId) {
        clone.tool_call_id = normalizedToolId;
      } else if (typeof clone.tool_call_id === 'string') {
        const trimmed = clone.tool_call_id.trim();
        if (!trimmed.length) {
          delete clone.tool_call_id;
        } else {
          clone.tool_call_id = trimmed;
        }
      }
      if ('call_id' in clone) delete clone.call_id;
      if ('id' in clone) delete clone.id;
      sanitized.push(clone);
      continue;
    }
    sanitized.push(message);
  }
  (payload as any).messages = sanitized;
}

function cloneResponsesContext(context: ResponsesRequestContext): JsonObject {
  try {
    return JSON.parse(JSON.stringify(context ?? {})) as JsonObject;
  } catch {
    return {};
  }
}

function restoreResponsesContext(value?: JsonObject): ResponsesRequestContext | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  return value as unknown as ResponsesRequestContext;
}

function captureToolResults(payload: JsonObject): Array<{ tool_call_id?: string; output?: string }> {
  const results: Array<{ tool_call_id?: string; output?: string }> = [];
  const inputArr = Array.isArray((payload as any)?.input) ? (((payload as any).input as any[])) : [];
  for (const it of inputArr) {
    if (!it || typeof it !== 'object') continue;
    const t = String((it as any).type || '').toLowerCase();
    if (t === 'tool_result' || t === 'tool_message' || t === 'function_call_output') {
      const tool_call_id = (it as any).tool_call_id || (it as any).call_id || (it as any).tool_use_id;
      let output: string | undefined = undefined;
      const rawOut = (it as any).output;
      if (typeof rawOut === 'string') output = rawOut;
      else if (rawOut && typeof rawOut === 'object') {
        try {
          output = JSON.stringify(rawOut);
        } catch (error) {
          logResponsesOpenAiPipelineNonBlocking('capture_tool_results.stringify_output', error, {
            itemType: t,
            toolCallId: typeof tool_call_id === 'string' ? tool_call_id : undefined
          });
        }
      }
      results.push({ tool_call_id, output });
    }
  }
  return results;
}

function buildPipelineContext(profile: ConversionProfile, context: ConversionContext): ProtocolPipelineContext {
  return {
    requestId: context.requestId,
    entryEndpoint: context.entryEndpoint ?? context.endpoint ?? DEFAULT_RESPONSES_ENDPOINT,
    providerProtocol: profile.incomingProtocol ?? RESPONSES_PROTOCOL,
    targetProtocol: profile.outgoingProtocol ?? context.targetProtocol ?? OPENAI_PROTOCOL,
    profileId: profile.id,
    stream: context.stream,
    metadata: context.metadata
  };
}

export class ResponsesOpenAIPipelineCodec implements ConversionCodec {
  readonly id = 'responses-openai-v2';
  private readonly requestMetaStore = new Map<string, ConversionMetaRecord>();
  private initialized = false;

  async initialize(): Promise<void> {
    this.initialized = true;
  }

  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error('ResponsesOpenAIPipelineCodec must be initialized before use');
    }
  }

  private stashMeta(requestId: string, bag: ConversionMetaBag): void {
    this.requestMetaStore.set(requestId, bag.snapshot());
  }

  async convertRequest(payload: unknown, profile: ConversionProfile, context: ConversionContext): Promise<JsonObject> {
    this.ensureInitialized();
    const inboundContext = buildPipelineContext(profile, context);
    const requestId = context.requestId ?? inboundContext.requestId ?? `req_${Date.now()}`;
    inboundContext.requestId = requestId;
    const wire = assertJsonObject(payload, 'responses_inbound_request');

    const responsesContext = captureResponsesContext(wire, { route: { requestId } });
    const built = buildChatRequestFromResponses(wire, responsesContext);
    if (built.toolsNormalized) {
      responsesContext.toolsNormalized = built.toolsNormalized;
    }
    const captured = captureToolResults(wire);
    if (captured.length) {
      (responsesContext as Record<string, unknown>).__captured_tool_results = captured;
    }

    const adapterContext = buildAdapterContextFromPipeline(inboundContext, {
      defaultEntryEndpoint: DEFAULT_RESPONSES_ENDPOINT,
      overrideProtocol: RESPONSES_PROTOCOL
    });
    const requestParameters =
      collectResponsesRequestParameters(built.request as Record<string, unknown>, {
        streamHint:
          typeof (built.request as Record<string, unknown>).stream === 'boolean'
            ? ((built.request as Record<string, unknown>).stream as boolean)
            : undefined
      }) ?? {};
    const chatEnvelope = standardizedToChatEnvelopeWithNative({
      request: {
        model: (built.request as Record<string, unknown>).model,
        messages: (built.request as Record<string, unknown>).messages,
        tools: (built.request as Record<string, unknown>).tools ?? [],
        parameters: requestParameters,
        metadata: {}
      } as unknown as JsonObject,
      adapterContext: adapterContext as unknown as Record<string, unknown>
    });
    const canonical = chatEnvelopeToStandardizedWithNative({
      chatEnvelope: chatEnvelope as unknown as Record<string, unknown>,
      adapterContext: adapterContext as unknown as Record<string, unknown>,
      endpoint: adapterContext.entryEndpoint ?? DEFAULT_RESPONSES_ENDPOINT,
      requestId
    });

    const meta = new ConversionMetaBag();
    meta.set('responsesContext', cloneResponsesContext(responsesContext));
    this.stashMeta(requestId, meta);

    const openaiPayload = await convertCanonicalToOpenAIChat(canonical as any, inboundContext);
    const filterContext: ConversionContext = {
      ...context,
      requestId,
      entryEndpoint: context.entryEndpoint ?? DEFAULT_RESPONSES_ENDPOINT,
      endpoint: context.endpoint ?? DEFAULT_RESPONSES_ENDPOINT
    };
    const filtered = await runStandardChatRequestFilters(openaiPayload, profile, filterContext);
    if (Object.keys(requestParameters).length) {
      (filtered as Record<string, unknown>).parameters = {
        ...requestParameters,
        ...(((filtered as Record<string, unknown>).parameters &&
          typeof (filtered as Record<string, unknown>).parameters === 'object' &&
          !Array.isArray((filtered as Record<string, unknown>).parameters))
          ? ((filtered as Record<string, unknown>).parameters as Record<string, unknown>)
          : {})
      };
    }
    sanitizeResponsesMessages(filtered as JsonObject);
    return filtered;
  }

  async convertResponse(payload: unknown, profile: ConversionProfile, context: ConversionContext): Promise<JsonObject> {
    this.ensureInitialized();
    const pipelineContext = buildPipelineContext(profile, context);
    const requestId = context.requestId ?? pipelineContext.requestId ?? `req_${Date.now()}`;
    pipelineContext.requestId = requestId;
    const storedMeta = this.requestMetaStore.get(requestId);
    if (storedMeta) {
      this.requestMetaStore.delete(requestId);
    }
    const stored = storedMeta?.responsesContext as JsonObject | undefined;
    const responsesContext = restoreResponsesContext(stored);

    const sanitized = await canonicalizeOpenAIChatResponse(
      assertJsonObject(payload, 'responses_openai_response'),
      context
    );
    return assertJsonObject(
      buildResponsesPayloadFromChat(sanitized, responsesContext),
      'responses_outbound_serialize'
    );
  }
}
