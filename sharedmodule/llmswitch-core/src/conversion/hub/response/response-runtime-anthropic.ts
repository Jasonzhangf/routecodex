import type { JsonObject } from '../types/json.js';
import { extractToolCallsFromReasoningText } from '../../shared/reasoning-tool-parser.js';
import { deriveToolCallKey } from '../../shared/tool-call-utils.js';
import {
  buildAnthropicResponseFromChatWithNative,
  resolveAnthropicChatCompletionOutcomeWithNative
} from '../../../router/virtual-router/engine-selection/native-hub-pipeline-resp-semantics.js';
import {
  registerResponsesReasoning,
  consumeResponsesReasoning,
  registerResponsesOutputTextMeta,
  consumeResponsesOutputTextMeta,
  consumeResponsesPayloadSnapshot,
  registerResponsesPayloadSnapshot,
  consumeResponsesPassthrough,
  registerResponsesPassthrough
} from '../../shared/responses-reasoning-registry.js';
import { ProviderProtocolError } from '../../provider-protocol-error.js';
import {
  applyReasoningPayload,
  createAnthropicToolNameResolver,
  flattenAnthropicContent,
  normalizeMessageReasoningPayload,
  type ToolAliasMap
} from './response-runtime-anthropic-helpers.js';
import {
  applyAnthropicResponseInboundBridgePolicy,
  applyAnthropicResponseOutboundBridgePolicy
} from './response-runtime-anthropic-policy.js';

export interface AnthropicResponseOptions {
  aliasMap?: ToolAliasMap;
  includeToolCallIds?: boolean;
}

export function buildOpenAIChatFromAnthropicMessage(payload: JsonObject, options?: AnthropicResponseOptions): JsonObject {
  const content = Array.isArray(payload?.content) ? payload.content : [];
  const textParts: string[] = [];
  const toolCalls: Array<{ id: string; name: string; args: string }> = [];
  const inferredToolCalls: Array<Record<string, unknown>> = [];
  const reasoningParts: string[] = [];
  let reasoningSignature: string | undefined;
  let reasoningRedactedEncryptedContent: string | undefined;
  const resolveToolName = createAnthropicToolNameResolver(options?.aliasMap);

  if (typeof (payload as any)?.reasoning_content === 'string' && (payload as any).reasoning_content.trim().length) {
    reasoningParts.push(String((payload as any).reasoning_content).trim());
  }

  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    const kind = String((part as Record<string, unknown>).type || '').toLowerCase();
    if (kind === 'text' && typeof (part as Record<string, unknown>).text === 'string') {
      const rawText = (part as Record<string, unknown>).text as string;
      if (/<\s*(tool_call|function_call)\b|\[\s*(tool_call|function_call)\b/i.test(rawText)) {
        const { cleanedText, toolCalls: inferred } = extractToolCallsFromReasoningText(rawText, { idPrefix: 'anthropic_text' });
        const trimmed = cleanedText.trim();
        if (trimmed.length) {
          textParts.push(trimmed);
        }
        if (Array.isArray(inferred) && inferred.length) {
          inferredToolCalls.push(...inferred);
        }
      } else {
        textParts.push(rawText);
      }
    } else if (kind === 'tool_use') {
      const rawName = typeof (part as Record<string, unknown>).name === 'string'
        ? String((part as Record<string, unknown>).name)
        : '';
      const name = rawName ? resolveToolName(rawName) : '';
      const id = typeof (part as Record<string, unknown>).id === 'string'
        ? String((part as Record<string, unknown>).id)
        : `call_${Math.random().toString(36).slice(2, 10)}`;
      const input = (part as Record<string, unknown>).input;
      let args = '';
      if (typeof input === 'string') {
        args = input;
      } else {
        try { args = JSON.stringify(input ?? {}); } catch { args = '{}'; }
      }
      if (name) {
        toolCalls.push({ id, name, args });
      }
    } else if (kind === 'thinking' || kind === 'reasoning') {
      const text = typeof (part as Record<string, unknown>).text === 'string'
        ? (part as Record<string, unknown>).text as string
        : flattenAnthropicContent(part);
      if (text) {
        const { cleanedText, toolCalls: inferred } = extractToolCallsFromReasoningText(text, { idPrefix: 'anthropic_reasoning' });
        const trimmed = cleanedText.trim();
        if (trimmed.length) {
          reasoningParts.push(trimmed);
        }
        if (Array.isArray(inferred) && inferred.length) {
          inferredToolCalls.push(...inferred);
        }
      }
      const signature = typeof (part as Record<string, unknown>).signature === 'string'
        ? String((part as Record<string, unknown>).signature).trim()
        : '';
      if (signature.length && !reasoningSignature) {
        reasoningSignature = signature;
      }
    } else if (kind === 'redacted_thinking') {
      const encrypted = typeof (part as Record<string, unknown>).data === 'string'
        ? String((part as Record<string, unknown>).data).trim()
        : (typeof (part as Record<string, unknown>).encrypted_content === 'string'
          ? String((part as Record<string, unknown>).encrypted_content).trim()
          : '');
      if (encrypted.length && !reasoningRedactedEncryptedContent) {
        reasoningRedactedEncryptedContent = encrypted;
      }
    }
  }

  const includeToolCallIds = options?.includeToolCallIds === true;
  const canonicalToolCalls: Array<Record<string, unknown>> = toolCalls.map((tc) => ({
    ...(includeToolCallIds ? { id: tc.id, call_id: tc.id, tool_call_id: tc.id } : {}),
    type: 'function',
    function: { name: tc.name, arguments: tc.args }
  }));

  if (inferredToolCalls.length) {
    const seen = new Set<string>();
    for (const existing of canonicalToolCalls) {
      const key = deriveToolCallKey(existing);
      if (key) seen.add(key);
    }
    for (const inferred of inferredToolCalls) {
      const key = deriveToolCallKey(inferred);
      if (key && seen.has(key)) continue;
      if (includeToolCallIds && typeof (inferred as any).id === 'string') {
        const inferredId = String((inferred as any).id);
        if (!("call_id" in inferred)) (inferred as any).call_id = inferredId;
        if (!("tool_call_id" in inferred)) (inferred as any).tool_call_id = inferredId;
      } else if (!includeToolCallIds) {
        if ("id" in inferred) delete (inferred as any).id;
        if ("call_id" in inferred) delete (inferred as any).call_id;
        if ("tool_call_id" in inferred) delete (inferred as any).tool_call_id;
      }
      canonicalToolCalls.push(inferred);
      if (key) seen.add(key);
    }
  }

  for (const call of canonicalToolCalls) {
    const cid = typeof (call as any).id === 'string' ? String((call as any).id) : '';
    if (includeToolCallIds) {
      if (cid) {
        if (!("call_id" in call)) (call as any).call_id = cid;
        if (!("tool_call_id" in call)) (call as any).tool_call_id = cid;
        if (!("id" in call)) (call as any).id = cid;
      }
    } else {
      if ("id" in call) delete (call as any).id;
      if ("call_id" in call) delete (call as any).call_id;
      if ("tool_call_id" in call) delete (call as any).tool_call_id;
    }
  }

  const message: Record<string, unknown> = {
    role: typeof payload.role === 'string' ? payload.role : 'assistant',
    content: textParts.join('\n')
  };
  const localReasoning = normalizeMessageReasoningPayload({
    content: reasoningParts.length
      ? reasoningParts.map((text) => ({ type: 'reasoning_text' as const, text }))
      : undefined,
    encrypted_content: reasoningRedactedEncryptedContent ?? reasoningSignature
  });
  if (canonicalToolCalls.length) {
    (message as any).tool_calls = canonicalToolCalls;
  }
  applyReasoningPayload(message, localReasoning);
  applyAnthropicResponseInboundBridgePolicy(message, payload as Record<string, unknown>);

  const stopReason = typeof payload['stop_reason'] === 'string' ? payload['stop_reason'] : undefined;
  const hasVisibleAssistantOutput = textParts.some((text) => text.trim().length > 0)
    || reasoningParts.some((text) => text.trim().length > 0)
    || canonicalToolCalls.length > 0;
  const outcome = resolveAnthropicChatCompletionOutcomeWithNative({
    stopReason,
    toolCallCount: canonicalToolCalls.length,
    hasVisibleAssistantOutput
  });
  if (outcome.shouldFailEmptyContextOverflow) {
    throw new ProviderProtocolError(
      `Anthropic upstream returned stop_reason=${String(stopReason)} with empty assistant output`,
      {
        code: 'MALFORMED_RESPONSE',
        protocol: 'anthropic-messages',
        providerType: 'anthropic',
        category: 'EXTERNAL_ERROR',
        details: {
          stop_reason: stopReason,
          response_id: typeof payload.id === 'string' ? payload.id : undefined
        }
      }
    );
  }
  const finishReason = outcome.finishReason;

  const chatResponse = {
    id: typeof payload.id === 'string' ? payload.id : `chatcmpl_${Date.now()}`,
    object: 'chat.completion',
    created: typeof payload?.['created'] === 'number' ? payload['created'] : Math.floor(Date.now() / 1000),
    model: typeof payload.model === 'string' ? payload.model : 'unknown',
    choices: [
      {
        index: 0,
        finish_reason: finishReason,
        message
      }
    ],
    usage: payload['usage'] && typeof payload['usage'] === 'object'
      ? payload['usage']
      : undefined
  } as JsonObject;
  const preserved = normalizeMessageReasoningPayload(consumeResponsesReasoning(chatResponse.id));
  const effectiveReasoning = preserved ?? localReasoning;
  if (effectiveReasoning) {
    (chatResponse as any).__responses_reasoning = effectiveReasoning;
    applyReasoningPayload(message, effectiveReasoning);
  }
  const preservedOutputMeta = consumeResponsesOutputTextMeta(chatResponse.id);
  if (preservedOutputMeta) {
    (chatResponse as any).__responses_output_text_meta = preservedOutputMeta;
  }
  const payloadSnapshot = consumeResponsesPayloadSnapshot(chatResponse.id);
  if (payloadSnapshot) {
    registerResponsesPayloadSnapshot(chatResponse.id, payloadSnapshot);
    (chatResponse as any).__responses_payload_snapshot = payloadSnapshot;
    if (typeof (chatResponse as any).request_id !== 'string') {
      (chatResponse as any).request_id = chatResponse.id;
    }
  }
  const passthroughPayload = consumeResponsesPassthrough(chatResponse.id);
  if (passthroughPayload) {
    registerResponsesPassthrough(chatResponse.id, passthroughPayload);
    (chatResponse as any).__responses_passthrough = passthroughPayload;
    if (typeof (chatResponse as any).request_id !== 'string') {
      (chatResponse as any).request_id = chatResponse.id;
    }
  }
  return chatResponse;
}

export function buildAnthropicResponseFromChat(chatResponse: JsonObject, options?: AnthropicResponseOptions): JsonObject {
  const choice = Array.isArray(chatResponse?.choices) ? chatResponse.choices[0] as JsonObject | undefined : undefined;
  const message = choice && typeof choice === 'object' ? (choice as Record<string, unknown>).message : undefined;
  const aliasMap = options?.aliasMap;
  if (message) {
    applyAnthropicResponseOutboundBridgePolicy(
      message as Record<string, unknown>,
      chatResponse as Record<string, unknown>
    );
  }
  const sanitized = buildAnthropicResponseFromChatWithNative(
    chatResponse as Record<string, unknown>,
    aliasMap
  ) as JsonObject;
  if ((chatResponse as any)?.__responses_reasoning) {
    registerResponsesReasoning(sanitized.id, (chatResponse as any).__responses_reasoning);
  }
  if ((chatResponse as any)?.__responses_output_text_meta) {
    registerResponsesOutputTextMeta(sanitized.id, (chatResponse as any).__responses_output_text_meta);
  }
  return sanitized;
}
