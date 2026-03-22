import type { AdapterContext, ChatEnvelope, MissingField } from '../../types/chat-envelope.js';
import { isJsonObject, jsonClone, type JsonObject, type JsonValue } from '../../types/json.js';
import { buildOpenAIChatFromAnthropic } from '../../../codecs/anthropic-openai-codec.js';
import { extractMetadataPassthrough } from '../../../metadata-passthrough.js';
import { buildAnthropicToolAliasMapWithNative } from '../../../../router/virtual-router/engine-selection/native-chat-process-governance-semantics.js';
import { ChatSemanticMapper } from './chat-mapper.js';
import {
  cloneAnthropicSystemBlocks,
  ensureSemantics,
  ensureToolsSemanticsNode,
  markExplicitEmptyTools
} from './anthropic-semantics-audit.js';
import {
  collectAnthropicParameters,
  PASSTHROUGH_METADATA_PREFIX,
  PASSTHROUGH_PARAMETERS,
  type AnthropicPayload
} from './anthropic-mapper-config.js';

export async function buildAnthropicChatEnvelopeFromPayload(
  payload: AnthropicPayload,
  ctx: AdapterContext,
  chatMapper: ChatSemanticMapper,
): Promise<ChatEnvelope> {
  const missing: MissingField[] = [];
  if (!Array.isArray(payload.messages)) missing.push({ path: 'messages', reason: 'absent' });
  if (typeof payload.model !== 'string') missing.push({ path: 'model', reason: 'absent' });
  const passthrough = extractMetadataPassthrough(payload.metadata, {
    prefix: PASSTHROUGH_METADATA_PREFIX,
    keys: PASSTHROUGH_PARAMETERS
  });

  const openaiPayload = buildOpenAIChatFromAnthropic(payload);
  const canonicalContext: AdapterContext = {
    ...ctx,
    providerProtocol: 'openai-chat',
    entryEndpoint: ctx.entryEndpoint || '/v1/chat/completions'
  };
  const chatEnvelope = await chatMapper.toChat(
    {
      protocol: 'openai-chat',
      direction: 'request',
      payload: openaiPayload as JsonObject
    },
    canonicalContext
  );

  const metadata: ChatEnvelope['metadata'] = chatEnvelope.metadata ?? { context: canonicalContext };
  chatEnvelope.metadata = metadata;
  metadata.context = canonicalContext;
  const semantics = ensureSemantics(chatEnvelope);
  if (!semantics.system || !isJsonObject(semantics.system)) {
    semantics.system = {};
  }
  if (!semantics.providerExtras || !isJsonObject(semantics.providerExtras)) {
    semantics.providerExtras = {};
  }
  const systemBlocks = cloneAnthropicSystemBlocks(payload.system);
  if (systemBlocks) {
    (semantics.system as JsonObject).blocks = jsonClone(systemBlocks as JsonValue) as JsonValue;
  }
  if (payload.tools && Array.isArray(payload.tools) && payload.tools.length === 0) {
    markExplicitEmptyTools(chatEnvelope);
  }
  const aliasMap = buildAnthropicToolAliasMapWithNative(payload.tools);
  if (aliasMap) {
    const toolsNode = ensureToolsSemanticsNode(chatEnvelope);
    (toolsNode as JsonObject).toolNameAliasMap = jsonClone(aliasMap as JsonObject as JsonValue) as JsonObject;
  }
  if (Array.isArray(payload.messages) && payload.messages.length) {
    const shapes = payload.messages.map((entry) => {
      if (!entry || typeof entry !== 'object') {
        return 'unknown';
      }
      const rawContent = (entry as Record<string, unknown>).content;
      if (typeof rawContent === 'string') {
        return 'string';
      }
      if (Array.isArray(rawContent)) {
        return 'array';
      }
      if (rawContent === null || rawContent === undefined) {
        return 'null';
      }
      return typeof rawContent;
    });
    const mirrorNode: JsonObject = { messageContentShape: shapes as unknown as JsonValue };
    (semantics.providerExtras as JsonObject).anthropicMirror = jsonClone(mirrorNode) as JsonObject;
  }
  if (missing.length) {
    metadata.missingFields = Array.isArray(metadata.missingFields)
      ? [...metadata.missingFields, ...missing]
      : missing;
  }
  const providerMetadata =
    passthrough.metadata ??
    (payload.metadata && isJsonObject(payload.metadata) ? (jsonClone(payload.metadata) as JsonObject) : undefined);
  if (providerMetadata) {
    (semantics.providerExtras as JsonObject).providerMetadata = jsonClone(providerMetadata) as JsonObject;
  }

  const mergedParameters: JsonObject = { ...(chatEnvelope.parameters ?? {}) };
  const mergeParameters = (source?: JsonObject): void => {
    if (!source) {
      return;
    }
    for (const [key, value] of Object.entries(source)) {
      if (mergedParameters[key] !== undefined) {
        continue;
      }
      mergedParameters[key] = jsonClone(value as JsonValue) as JsonValue;
    }
  };
  mergeParameters(collectAnthropicParameters(payload));
  if (providerMetadata) {
    mergedParameters.metadata = jsonClone(providerMetadata) as JsonValue;
  }
  if (passthrough.passthrough) {
    for (const [key, value] of Object.entries(passthrough.passthrough)) {
      mergedParameters[key] = jsonClone(value as JsonValue) as JsonValue;
    }
  }
  if (Object.keys(mergedParameters).length) {
    chatEnvelope.parameters = mergedParameters;
  } else {
    delete chatEnvelope.parameters;
  }
  return chatEnvelope;
}
