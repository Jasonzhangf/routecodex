import type { AdapterContext, ChatEnvelope, ChatToolDefinition, ChatToolOutput, ChatToolCall } from '../../types/chat-envelope.js';
import { isJsonObject, jsonClone, type JsonObject, type JsonValue } from '../../types/json.js';
import { encodeMetadataPassthrough } from '../../../metadata-passthrough.js';
import { mapChatToolsToBridge } from '../../../shared/tool-mapping.js';
import { buildGeminiToolsFromBridge } from '../../../shared/gemini-tool-utils.js';
import { getProtocolState } from '../../../protocol-state.js';
import {
  ANTIGRAVITY_DEFAULT_SAFETY_SETTINGS,
  deepCleanUndefined,
  injectGoogleSearchTool,
  pruneSearchFunctionDeclarations,
  resolveAntigravityRequestConfig,
  stripOnlineSuffix,
  type GeminiPayload
} from './gemini-antigravity-request.js';
import {
  applyGeminiRequestSystemInstruction,
  readSystemTextBlocksFromSemantics
} from './gemini-system-semantics.js';
import {
  applyAntigravityThinkingConfig,
  buildGenerationConfigFromParameters
} from './gemini-thinking-config.js';
import {
  appendLossyFieldAudit,
  appendPreservedFieldAudit,
  appendUnsupportedFieldAudit
} from './gemini-mapping-audit.js';
import {
  buildFunctionResponseEntry,
  cloneAsJsonValue,
  convertToolMessageToOutput,
  normalizeToolContent,
  sanitizeAntigravityToolCallId,
  synthesizeToolOutputsFromMessages
} from './gemini-tool-output.js';
import {
  alignToolCallArgsToSchema,
  appendChatContentToGeminiParts,
  buildToolSchemaKeyMap,
  collectAssistantToolCallIds,
  isResponsesOrigin,
  mapChatRoleToGemini,
  mapToolNameForGemini
} from './gemini-chat-request-helpers.js';
import { hasExplicitEmptyToolsSemantics, readGeminiSemantics } from './gemini-semantics-state.js';
import {
  GEMINI_PASSTHROUGH_METADATA_PREFIX,
  GEMINI_PASSTHROUGH_PARAMETERS,
  recordGeminiResponsesDroppedParameters,
} from './gemini-mapper-config.js';
import { applyClaudeThinkingToolSchemaCompatWithNative } from '../../../../router/virtual-router/engine-selection/native-hub-pipeline-req-outbound-semantics.js';
import { extractAntigravityGeminiSessionIdWithNative } from '../../../../router/virtual-router/engine-selection/native-router-hotpath.js';

export function buildGeminiRequestFromChat(chat: ChatEnvelope, metadata: ChatEnvelope['metadata'] | undefined): Record<string, unknown> {
  const contents: JsonObject[] = [];
  const emittedToolOutputs = new Set<string>();
  const adapterContext = metadata?.context as AdapterContext | undefined;
  const rawProviderId = adapterContext?.providerId;
  const entryEndpointRaw = adapterContext?.entryEndpoint;
  const entryEndpoint =
    typeof entryEndpointRaw === 'string' ? entryEndpointRaw.trim().toLowerCase() : '';
  const isAnthropicEntry = entryEndpoint === '/v1/messages';
  const normalizedProviderId =
    typeof rawProviderId === 'string' ? rawProviderId.toLowerCase() : '';
  const providerIdPrefix = normalizedProviderId.split('.')[0];
  const isAntigravityProvider = providerIdPrefix === 'antigravity';
  const parameters = chat.parameters && typeof chat.parameters === 'object' ? (chat.parameters as Record<string, unknown>) : {};
  const responsesOrigin = isResponsesOrigin(chat);
  if (Object.prototype.hasOwnProperty.call(parameters, 'response_format')) {
    appendUnsupportedFieldAudit(chat, {
      field: 'response_format',
      targetProtocol: 'gemini-chat',
      reason: 'structured_output_not_supported'
    });
  }
  recordGeminiResponsesDroppedParameters(chat, parameters, responsesOrigin);
  const keepReasoning =
    Boolean((parameters as { keep_thinking?: unknown }).keep_thinking) ||
    Boolean((parameters as { keep_reasoning?: unknown }).keep_reasoning);
  const stripReasoningTags =
    isAntigravityProvider &&
    typeof (parameters as any).model === 'string' &&
    String((parameters as any).model).startsWith('claude-') &&
    !keepReasoning;

  const includeToolCallIds = providerIdPrefix === 'antigravity';
  const allowFunctionCallingProtocol =
    providerIdPrefix !== 'gemini-cli' || (Array.isArray(chat.tools) && chat.tools.length > 0);
  const omitFunctionCallPartsForCli = !allowFunctionCallingProtocol;
  const semanticsNode = readGeminiSemantics(chat);
  const systemTextBlocksFromSemantics = readSystemTextBlocksFromSemantics(chat);

  const bridgeDefs = chat.tools && chat.tools.length ? mapChatToolsToBridge(chat.tools) : undefined;
  if (bridgeDefs && bridgeDefs.length) {
    for (const def of bridgeDefs) {
      if (!def || typeof def !== 'object') continue;
      const mapped = mapToolNameForGemini(def.name);
      if (mapped && mapped !== def.name) {
        def.name = mapped;
        if (def.function && typeof def.function === 'object') {
          (def.function as any).name = mapped;
        }
      }
    }
  }
  const toolSchemaKeys = bridgeDefs ? buildToolSchemaKeyMap(bridgeDefs) : new Map<string, Set<string>>();

  const sourceMessages = chat.messages;
  const assistantToolCallIds = collectAssistantToolCallIds(sourceMessages);

  for (const message of sourceMessages) {
    if (!message || typeof message !== 'object') continue;
    if (message.role === 'system') continue;
    if (message.role === 'tool') {
      if (allowFunctionCallingProtocol) {
        const toolOutput = convertToolMessageToOutput(message as JsonObject, assistantToolCallIds);
        if (toolOutput) {
          toolOutput.name = mapToolNameForGemini(toolOutput.name);
          contents.push(buildFunctionResponseEntry(toolOutput, { includeCallId: includeToolCallIds }));
          emittedToolOutputs.add(toolOutput.tool_call_id);
        }
      } else {
        const name = typeof (message as any).name === 'string' ? String((message as any).name).trim() : 'tool';
        const contentText = normalizeToolContent((message as any).content);
        contents.push({
          role: 'user',
          parts: [{ text: `[tool:${name}] ${contentText}` }]
        });
      }
      continue;
    }
    const entry: JsonObject = {
      role: mapChatRoleToGemini(message.role),
      parts: [] as JsonObject[]
    };
    appendChatContentToGeminiParts(message, entry.parts as JsonObject[], { stripReasoningTags });
    const toolCalls = Array.isArray((message as JsonObject).tool_calls)
      ? ((message as any).tool_calls as ChatToolCall[])
      : [];
    for (const tc of toolCalls) {
      if (!tc || typeof tc !== 'object') continue;
      if (omitFunctionCallPartsForCli) {
        continue;
      }
      const fn = (tc as any).function || {};
      const name = mapToolNameForGemini(typeof fn.name === 'string' ? fn.name : undefined);
      if (!name) continue;
      let argsStruct: unknown;
      if (typeof fn.arguments === 'string') {
        try {
          argsStruct = JSON.parse(fn.arguments);
        } catch {
          argsStruct = { _raw: fn.arguments };
        }
      } else {
        argsStruct = fn.arguments ?? {};
      }

      argsStruct = alignToolCallArgsToSchema({ toolName: name, args: argsStruct, schemaKeys: toolSchemaKeys });

      let argsJson = cloneAsJsonValue(argsStruct);
      if (!argsJson || typeof argsJson !== 'object' || Array.isArray(argsJson)) {
        argsJson = { value: argsJson } as JsonObject;
      }

      const functionCall: JsonObject = { name, args: argsJson };
      const part: JsonObject = { functionCall };
      if (includeToolCallIds && typeof (tc as any).id === 'string' && (tc as any).id.trim().length) {
        (part.functionCall as JsonObject).id = sanitizeAntigravityToolCallId(String((tc as any).id));
      }
      (entry.parts as JsonObject[]).push(part);
    }
    if ((entry.parts as JsonObject[]).length) {
      contents.push(entry);
    }
  }

  const toolOutputMap = new Map<string, ChatToolOutput>();
  if (allowFunctionCallingProtocol) {
    if (Array.isArray(chat.toolOutputs)) {
      for (const entry of chat.toolOutputs) {
        if (entry && typeof entry.tool_call_id === 'string' && entry.tool_call_id.trim().length) {
          toolOutputMap.set(entry.tool_call_id.trim(), entry);
        }
      }
    }
    if (toolOutputMap.size === 0) {
      const syntheticOutputs = synthesizeToolOutputsFromMessages(chat.messages);
      for (const output of syntheticOutputs) {
        toolOutputMap.set(output.tool_call_id, output);
      }
    }
    for (const output of toolOutputMap.values()) {
      if (emittedToolOutputs.has(output.tool_call_id)) {
        continue;
      }
      output.name = mapToolNameForGemini(output.name);
      contents.push(buildFunctionResponseEntry(output, { includeCallId: includeToolCallIds }));
      emittedToolOutputs.add(output.tool_call_id);
    }
  }

  const request: Record<string, unknown> = {
    model: chat.parameters?.model || 'models/gemini-pro',
    contents
  };

  const geminiState = getProtocolState(metadata, 'gemini');
  applyGeminiRequestSystemInstruction({
    request,
    isAntigravityProvider,
    semanticsSystemInstruction: semanticsNode?.systemInstruction as JsonValue | undefined,
    protocolStateSystemInstruction: geminiState?.systemInstruction as JsonValue | undefined,
    systemTextBlocksFromSemantics
  });
  if (allowFunctionCallingProtocol && chat.tools && chat.tools.length) {
    const geminiTools = buildGeminiToolsFromBridge(bridgeDefs, {
      mode: isAntigravityProvider ? 'antigravity' : 'default'
    });
    if (geminiTools) {
      request.tools = geminiTools;
    }
  }
  const generationConfig = buildGenerationConfigFromParameters(chat.parameters || {});
  if (responsesOrigin && Object.prototype.hasOwnProperty.call(parameters, 'reasoning')) {
    appendLossyFieldAudit(chat, {
      field: 'reasoning',
      targetProtocol: 'gemini-chat',
      reason: 'normalized_to_gemini_thinking_config'
    });
  }
  if (semanticsNode?.generationConfig && isJsonObject(semanticsNode.generationConfig)) {
    for (const [key, value] of Object.entries(semanticsNode.generationConfig as JsonObject)) {
      if (generationConfig[key] !== undefined) {
        continue;
      }
      generationConfig[key] = jsonClone(value as JsonValue);
    }
  }
  if (Object.keys(generationConfig).length) {
    request.generationConfig = generationConfig;
  }
  if (!isAntigravityProvider && semanticsNode?.safetySettings !== undefined) {
    request.safetySettings = jsonClone(semanticsNode.safetySettings as JsonValue);
  } else if (isAntigravityProvider) {
    request.safetySettings = jsonClone(ANTIGRAVITY_DEFAULT_SAFETY_SETTINGS as unknown as JsonValue);
  }
  if (isAntigravityProvider && isJsonObject(request.generationConfig as JsonValue)) {
    (request.generationConfig as JsonObject).maxOutputTokens = 64000;
    (request.generationConfig as JsonObject).topK = 64;
  }
  if (isAntigravityProvider && typeof request.model === 'string') {
    const requestPayload = request as GeminiPayload;
    const original = requestPayload.model as string;
    const mapped = stripOnlineSuffix(original);
    const size = typeof chat.parameters?.size === 'string' ? String(chat.parameters.size) : undefined;
    const quality = typeof chat.parameters?.quality === 'string' ? String(chat.parameters.quality) : undefined;
    const config = resolveAntigravityRequestConfig({
      originalModel: original,
      mappedModel: mapped,
      tools: requestPayload.tools,
      size,
      quality
    });
    requestPayload.requestType = config.requestType;
    requestPayload.model = config.finalModel;
    pruneSearchFunctionDeclarations(requestPayload);
    if (config.requestType === 'image_gen') {
      delete requestPayload.tools;
      delete requestPayload.systemInstruction;
      if (!isJsonObject(requestPayload.generationConfig as JsonValue)) {
        requestPayload.generationConfig = {};
      }
      const gen = requestPayload.generationConfig as JsonObject;
      delete gen.thinkingConfig;
      delete gen.responseMimeType;
      delete gen.responseModalities;
      if (config.imageConfig) {
        gen.imageConfig = config.imageConfig;
      }
    } else if (config.injectGoogleSearch) {
      injectGoogleSearchTool(requestPayload);
    }
    deepCleanUndefined(requestPayload);
    const mappedLower = requestPayload.model.toLowerCase();
    applyAntigravityThinkingConfig(requestPayload, mappedLower);
  }
  if (chat.parameters?.tool_config && isJsonObject(chat.parameters.tool_config)) {
    request.toolConfig = jsonClone(chat.parameters.tool_config) as JsonObject;
  } else if (semanticsNode?.toolConfig && isJsonObject(semanticsNode.toolConfig)) {
    request.toolConfig = jsonClone(semanticsNode.toolConfig as JsonObject) as JsonObject;
  }
  if (!isAnthropicEntry) {
    if (semanticsNode?.providerMetadata && isJsonObject(semanticsNode.providerMetadata)) {
      request.metadata = jsonClone(semanticsNode.providerMetadata as JsonObject);
    } else if (metadata?.providerMetadata && isJsonObject(metadata.providerMetadata)) {
      request.metadata = jsonClone(metadata.providerMetadata);
    }
  }
  if (chat.parameters && chat.parameters.stream !== undefined) {
    request.metadata = request.metadata ?? {};
    (request.metadata as JsonObject).__rcc_stream = chat.parameters.stream as JsonValue;
  }
  if (
    hasExplicitEmptyToolsSemantics(chat) &&
    (!Array.isArray(chat.tools) || chat.tools.length === 0)
  ) {
    request.metadata = request.metadata ?? {};
    (request.metadata as JsonObject).__rcc_tools_field_present = '1';
  }
  const passthrough = encodeMetadataPassthrough(chat.parameters as JsonObject | undefined, {
    prefix: GEMINI_PASSTHROUGH_METADATA_PREFIX,
    keys: GEMINI_PASSTHROUGH_PARAMETERS
  });
  if (passthrough) {
    request.metadata = request.metadata ?? {};
    for (const [key, value] of Object.entries(passthrough)) {
      (request.metadata as JsonObject)[key] = value;
    }
  }
  if (Object.prototype.hasOwnProperty.call(parameters, 'tool_choice')) {
    appendPreservedFieldAudit(chat, {
      field: 'tool_choice',
      targetProtocol: 'gemini-chat',
      reason: 'preserved_via_metadata_passthrough'
    });
  }

  if (isAntigravityProvider) {
    request.metadata = request.metadata ?? {};
    const existing = (request.metadata as JsonObject).antigravitySessionId;
    if (typeof existing !== 'string' || !existing.trim()) {
      (request.metadata as JsonObject).antigravitySessionId = extractAntigravityGeminiSessionIdWithNative(request);
    }
  }

  const compatRequest = applyClaudeThinkingToolSchemaCompatWithNative(request as JsonObject);
  return compatRequest as Record<string, unknown>;
}
