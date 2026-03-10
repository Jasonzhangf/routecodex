import type { JsonObject } from '../../../../hub/types/json.js';
import type { ConversionContext } from '../../../../types.js';
import type { CanonicalChatRequest } from '../../../schema/index.js';
import type { ProtocolPipelineContext } from '../../../hooks/protocol-hooks.js';
import { buildAdapterContextFromPipeline } from '../../../hooks/adapter-context.js';
import { standardizedToChatEnvelopeWithNative } from '../../../../../router/virtual-router/engine-selection/native-hub-pipeline-req-outbound-semantics.js';
import { mapOpenaiChatFromChatWithNative } from '../../../../../router/virtual-router/engine-selection/native-hub-pipeline-semantic-mappers.js';
import { runOpenAIResponseCodecWithNative } from '../../../../../router/virtual-router/engine-selection/native-compat-action-semantics.js';

export const DEFAULT_OPENAI_ENDPOINT = '/v1/chat/completions';
export const OPENAI_PROTOCOL = 'openai-chat';

function ensureJsonObject(value: unknown, stage: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`OpenAI chat helper requires JSON object payload at ${stage}`);
  }
  return value as JsonObject;
}

export async function convertStandardizedToOpenAIChat(
  standardized: CanonicalChatRequest,
  context: ProtocolPipelineContext,
  options?: { defaultEndpoint?: string }
): Promise<JsonObject> {
  const adapterContext = buildAdapterContextFromPipeline(context, {
    defaultEntryEndpoint: options?.defaultEndpoint ?? DEFAULT_OPENAI_ENDPOINT,
    overrideProtocol: OPENAI_PROTOCOL
  });
  const chatEnvelope = standardizedToChatEnvelopeWithNative({
    request: standardized as unknown as JsonObject,
    adapterContext: adapterContext as unknown as Record<string, unknown>
  });
  const formatEnvelope = mapOpenaiChatFromChatWithNative(
    chatEnvelope as unknown as Record<string, unknown>,
    adapterContext as unknown as Record<string, unknown>
  );
  return ensureJsonObject((formatEnvelope as Record<string, unknown>).payload, 'openai_request_build');
}

export async function canonicalizeOpenAIChatResponse(
  payload: JsonObject,
  context: ConversionContext,
  options?: { defaultEndpoint?: string; profile?: string }
): Promise<JsonObject> {
  return ensureJsonObject(
    runOpenAIResponseCodecWithNative(payload as unknown as Record<string, unknown>, {
      requestId: context.requestId ?? `req_${Date.now()}`,
      endpoint: context.entryEndpoint ?? context.endpoint ?? options?.defaultEndpoint ?? DEFAULT_OPENAI_ENDPOINT,
      stream: context.stream === true,
      reasoningMode: (context.metadata as Record<string, unknown> | undefined)?.reasoningMode,
      profile: options?.profile ?? OPENAI_PROTOCOL,
      idPrefixBase: 'reasoning_choice'
    }),
    'openai_response_filters'
  );
}
