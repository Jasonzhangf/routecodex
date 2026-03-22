import type { AdapterContext, ChatEnvelope, MissingField } from '../../types/chat-envelope.js';
import { isJsonObject, jsonClone, type JsonObject, type JsonValue } from '../../types/json.js';
import { buildOpenAIChatFromGeminiRequest } from '../../../codecs/gemini-openai-codec.js';
import { extractMetadataPassthrough } from '../../../metadata-passthrough.js';
import { mapBridgeToolsToChat } from '../../../shared/tool-mapping.js';
import { prepareGeminiToolsForBridge } from '../../../shared/gemini-tool-utils.js';
import { ensureProtocolState } from '../../../protocol-state.js';
import { collectParameters } from './gemini-chat-request-helpers.js';
import { normalizeToolOutputs } from './gemini-tool-output.js';
import { collectSystemSegments, ensureSystemSemantics } from './gemini-system-semantics.js';
import { ensureGeminiSemanticsNode, markGeminiExplicitEmptyTools } from './gemini-semantics-state.js';
import {
  GEMINI_PASSTHROUGH_METADATA_PREFIX,
  GEMINI_PASSTHROUGH_PARAMETERS,
} from './gemini-mapper-config.js';
import type { GeminiPayload } from './gemini-antigravity-request.js';

export function buildGeminiChatEnvelopeFromGeminiPayload(payload: GeminiPayload, ctx: AdapterContext): ChatEnvelope {
  const missing: MissingField[] = [];
  const { messages: builtMessages } = buildOpenAIChatFromGeminiRequest(payload);
  const messages = Array.isArray(builtMessages) ? (builtMessages as ChatEnvelope['messages']) : [];
  if (!Array.isArray(payload.contents)) {
    missing.push({ path: 'contents', reason: 'absent' });
  }
  const bridgeTools = prepareGeminiToolsForBridge(payload.tools, missing);
  const tools = bridgeTools ? mapBridgeToolsToChat(bridgeTools) : undefined;
  let parameters = collectParameters(payload);
  const metadata: ChatEnvelope['metadata'] = { context: ctx };
  const systemSegments = collectSystemSegments(payload.systemInstruction);
  if (payload.systemInstruction !== undefined) {
    const rawSystem = jsonClone(payload.systemInstruction);
    ensureProtocolState(metadata, 'gemini').systemInstruction = rawSystem;
  }
  if (missing.length) {
    metadata.missingFields = missing;
  }
  const toolOutputs = normalizeToolOutputs(messages, missing);
  const passthrough = extractMetadataPassthrough(payload.metadata, {
    prefix: GEMINI_PASSTHROUGH_METADATA_PREFIX,
    keys: GEMINI_PASSTHROUGH_PARAMETERS
  });
  if (passthrough.passthrough) {
    parameters = { ...(parameters || {}), ...passthrough.passthrough };
  }

  const providerMetadataSource = passthrough.metadata ?? payload.metadata;
  let providerMetadata: JsonObject | undefined;
  let explicitEmptyTools = Array.isArray(payload.tools) && payload.tools.length === 0;
  if (providerMetadataSource) {
    const cloned = jsonClone(providerMetadataSource);
    let toolsFieldPresent = false;
    if (isJsonObject(cloned)) {
      delete cloned.__rcc_stream;
      if (Object.prototype.hasOwnProperty.call(cloned, '__rcc_tools_field_present')) {
        const sentinel = cloned.__rcc_tools_field_present;
        toolsFieldPresent = sentinel === '1' || sentinel === true;
        delete cloned.__rcc_tools_field_present;
      }
      if (Object.prototype.hasOwnProperty.call(cloned, '__rcc_raw_system')) {
        delete cloned.__rcc_raw_system;
      }
    }
    if (toolsFieldPresent) {
      explicitEmptyTools = true;
    }
    providerMetadata = cloned as JsonObject;
    metadata.providerMetadata = providerMetadata;
  }

  const chatEnvelope: ChatEnvelope = {
    messages,
    tools,
    toolOutputs,
    parameters,
    metadata
  };

  if (systemSegments.length) {
    const systemNode = ensureSystemSemantics(chatEnvelope);
    systemNode.textBlocks = systemSegments.map((segment) => segment);
  }
  let semanticsNode: JsonObject | undefined;
  const ensureSemanticsNode = (): JsonObject => {
    semanticsNode = semanticsNode ?? ensureGeminiSemanticsNode(chatEnvelope);
    return semanticsNode;
  };
  if (payload.systemInstruction !== undefined) {
    ensureSemanticsNode().systemInstruction = jsonClone(payload.systemInstruction);
  }
  if (payload.safetySettings) {
    ensureSemanticsNode().safetySettings = jsonClone(payload.safetySettings);
  }
  if (payload.generationConfig && isJsonObject(payload.generationConfig)) {
    ensureSemanticsNode().generationConfig = jsonClone(payload.generationConfig);
  }
  if (payload.toolConfig && isJsonObject(payload.toolConfig)) {
    ensureSemanticsNode().toolConfig = jsonClone(payload.toolConfig);
  }
  if (providerMetadata) {
    ensureSemanticsNode().providerMetadata = jsonClone(providerMetadata as JsonValue);
  }
  if (explicitEmptyTools) {
    markGeminiExplicitEmptyTools(chatEnvelope);
  }

  return chatEnvelope;
}
