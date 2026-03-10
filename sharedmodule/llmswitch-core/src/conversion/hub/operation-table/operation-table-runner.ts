import type { AdapterContext, ChatEnvelope, ChatMessage, ChatToolOutput, MissingField } from '../types/chat-envelope.js';
import type { FormatEnvelope } from '../types/format-envelope.js';
import type { JsonObject, JsonValue } from '../types/json.js';
import { isJsonObject } from '../types/json.js';
import { createBridgeActionState, runBridgeActionPipeline, type BridgeActionStage } from '../../bridge-actions.js';
import { resolveBridgePolicy, resolvePolicyActions } from '../../bridge-policies.js';
import { normalizeProviderProtocolTokenWithNative } from '../../../router/virtual-router/engine-selection/native-hub-pipeline-req-inbound-semantics.js';

type ProtocolId = 'openai-chat' | 'openai-responses' | 'anthropic-messages' | 'gemini-chat';
type MessagesSource = 'chat_envelope' | 'format_payload_messages' | 'none';

type BridgeRunSpec = {
  protocol: ProtocolId;
  stage: BridgeActionStage;
  messages: MessagesSource;
  includeCapturedToolResults?: boolean;
  moduleType?: string;
};

const INBOUND_BRIDGE_SPECS: Record<ProtocolId, BridgeRunSpec> = {
  'openai-chat': { protocol: 'openai-chat', stage: 'request_inbound', messages: 'chat_envelope' },
  // Keep parity with the legacy semantic mapper behavior: do not pass messages[] into the action state
  // for openai-responses, since the bridge actions here are used as metadata hooks only.
  'openai-responses': { protocol: 'openai-responses', stage: 'request_inbound', messages: 'none', includeCapturedToolResults: true, moduleType: 'openai-responses' },
  'anthropic-messages': { protocol: 'anthropic-messages', stage: 'request_inbound', messages: 'chat_envelope' },
  'gemini-chat': { protocol: 'gemini-chat', stage: 'request_inbound', messages: 'chat_envelope' }
};

const OUTBOUND_BRIDGE_SPECS: Record<ProtocolId, BridgeRunSpec> = {
  'openai-chat': { protocol: 'openai-chat', stage: 'request_outbound', messages: 'format_payload_messages', includeCapturedToolResults: true },
  // Keep parity: openai-responses outbound actions should not touch normalized messages.
  'openai-responses': { protocol: 'openai-responses', stage: 'request_outbound', messages: 'none', moduleType: 'openai-responses' },
  'anthropic-messages': { protocol: 'anthropic-messages', stage: 'request_outbound', messages: 'none', includeCapturedToolResults: true },
  // Keep parity with legacy gemini mapper: outbound hooks operate on ChatEnvelope.messages (not Gemini contents).
  'gemini-chat': { protocol: 'gemini-chat', stage: 'request_outbound', messages: 'chat_envelope', includeCapturedToolResults: true }
};

function isSupportedProtocol(protocol: string): protocol is ProtocolId {
  const normalizedProtocol = normalizeProviderProtocolTokenWithNative(protocol) ?? protocol;
  return normalizedProtocol === 'openai-chat' ||
    normalizedProtocol === 'openai-responses' ||
    normalizedProtocol === 'anthropic-messages' ||
    normalizedProtocol === 'gemini-chat';
}

function extractPayloadMessages(payload: JsonObject | undefined): Array<Record<string, unknown>> | undefined {
  const value = payload?.messages;
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value as Array<Record<string, unknown>>;
}

function buildCapturedToolResults(toolOutputs: ChatToolOutput[] | undefined): Array<{ tool_call_id?: string; call_id?: string; output?: unknown; name?: string }> | undefined {
  if (!Array.isArray(toolOutputs) || toolOutputs.length === 0) {
    return undefined;
  }
  return toolOutputs.map((entry) => ({
    tool_call_id: entry.tool_call_id,
    output: entry.content,
    name: entry.name
  }));
}

function applyBridgePolicy(spec: BridgeRunSpec, options: {
  requestId?: string;
  chatEnvelope: ChatEnvelope;
  payload: JsonObject;
  adapterContext: AdapterContext;
}): void {
  const bridgePolicy = resolveBridgePolicy({ protocol: spec.protocol, moduleType: spec.moduleType ?? spec.protocol });
  const actions = resolvePolicyActions(bridgePolicy, spec.stage);
  if (!actions?.length) {
    return;
  }

  const metadata = options.chatEnvelope.metadata as Record<string, unknown> | undefined;
  const messages =
    spec.messages === 'chat_envelope'
      ? (options.chatEnvelope.messages as Array<Record<string, unknown>>)
      : spec.messages === 'format_payload_messages'
        ? extractPayloadMessages(options.payload)
        : undefined;
  const capturedToolResults = spec.includeCapturedToolResults
    ? buildCapturedToolResults(options.chatEnvelope.toolOutputs)
    : undefined;
  const actionState = createBridgeActionState({
    ...(messages ? { messages } : {}),
    rawRequest: options.payload,
    metadata,
    ...(capturedToolResults ? { capturedToolResults } : {})
  });

  runBridgeActionPipeline({
    stage: spec.stage,
    actions,
    protocol: bridgePolicy?.protocol ?? spec.protocol,
    moduleType: bridgePolicy?.moduleType ?? spec.moduleType ?? spec.protocol,
    requestId: options.requestId,
    state: actionState
  });

  if (spec.messages === 'chat_envelope') {
    options.chatEnvelope.messages = actionState.messages as unknown as ChatMessage[];
  }
}

function normalizeToolContent(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value ?? '');
  }
}

function rebuildGeminiToolOutputsFromMessages(chatEnvelope: ChatEnvelope): void {
  const messages = Array.isArray(chatEnvelope.messages) ? chatEnvelope.messages : [];
  const missing =
    Array.isArray(chatEnvelope.metadata?.missingFields) ? (chatEnvelope.metadata!.missingFields as MissingField[]) : undefined;
  const outputs: ChatToolOutput[] = [];
  messages.forEach((msg, index) => {
    if (!msg || typeof msg !== 'object') return;
    if (msg.role !== 'tool') return;
    const callId = (msg as JsonObject).tool_call_id || (msg as JsonObject).id;
    if (typeof callId !== 'string' || !callId.trim()) {
      if (missing) {
        missing.push({ path: `messages[${index}].tool_call_id`, reason: 'missing_tool_call_id' });
      }
      return;
    }
    outputs.push({
      tool_call_id: callId.trim(),
      content: normalizeToolContent((msg as JsonObject).content),
      name: typeof (msg as JsonObject).name === 'string' ? ((msg as JsonObject).name as string) : undefined
    });
  });
  chatEnvelope.toolOutputs = outputs.length ? outputs : undefined;
}

export function applyHubOperationTableInbound(options: {
  formatEnvelope: FormatEnvelope<JsonObject>;
  chatEnvelope: ChatEnvelope;
  adapterContext: AdapterContext;
}): void {
  const protocol = normalizeProviderProtocolTokenWithNative(options.formatEnvelope.protocol)
    ?? options.formatEnvelope.protocol;
  if (!isSupportedProtocol(protocol)) {
    return;
  }
  const payload = (options.formatEnvelope.payload ?? {}) as JsonObject;
  const spec = INBOUND_BRIDGE_SPECS[protocol];
  applyBridgePolicy(spec, {
    requestId: options.adapterContext.requestId,
    chatEnvelope: options.chatEnvelope,
    payload,
    adapterContext: options.adapterContext
  });
  if (protocol === 'gemini-chat') {
    // Keep parity: gemini mapper rebuilds toolOutputs after inbound policy adjustments.
    rebuildGeminiToolOutputsFromMessages(options.chatEnvelope);
  }
}

export function applyHubOperationTableOutboundPreMap(options: {
  protocol: string;
  chatEnvelope: ChatEnvelope;
  adapterContext: AdapterContext;
}): Promise<void> {
  if (options.protocol !== 'anthropic-messages' && options.protocol !== 'gemini-chat') {
    return Promise.resolve();
  }
  // Ensure tool_use/tool_result ordering and per-session history for protocols that depend on it.
  return (async () => {
    try {
      const { applyToolSessionCompat } = await import('../tool-session-compat.js');
      await applyToolSessionCompat(options.chatEnvelope, options.adapterContext);
    } catch {
      // best-effort compat; never block outbound mapping
    }
  })();
}

export function applyHubOperationTableOutboundPostMap(options: {
  chatEnvelope: ChatEnvelope;
  formatEnvelope: FormatEnvelope<JsonObject>;
  adapterContext: AdapterContext;
}): void {
  const protocol = normalizeProviderProtocolTokenWithNative(options.formatEnvelope.protocol)
    ?? options.formatEnvelope.protocol;
  if (!isSupportedProtocol(protocol)) {
    return;
  }
  const payload = (options.formatEnvelope.payload ?? {}) as JsonObject;
  const spec = OUTBOUND_BRIDGE_SPECS[protocol];
  applyBridgePolicy(spec, {
    requestId: options.adapterContext.requestId,
    chatEnvelope: options.chatEnvelope,
    payload,
    adapterContext: options.adapterContext
  });
  options.formatEnvelope.payload = payload as JsonObject;
}
