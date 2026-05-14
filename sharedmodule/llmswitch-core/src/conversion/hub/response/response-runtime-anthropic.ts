import type { JsonObject } from '../types/json.js';
import { extractToolCallsFromReasoningText } from '../../shared/reasoning-tool-parser.js';
import {
  buildAnthropicResponseFromChatWithNative,
  resolveAnthropicChatCompletionOutcomeWithNative
} from '../../../router/virtual-router/engine-selection/native-hub-pipeline-resp-semantics.js';
import { buildChatResponseFromResponsesWithNative } from '../../../router/virtual-router/engine-selection/native-shared-conversion-semantics.js';
import { deriveToolCallKeyWithNative } from '../../../router/virtual-router/engine-selection/native-shared-conversion-semantics.js';
import {
  registerResponsesReasoning,
  consumeResponsesReasoning,
  registerResponsesOutputTextMeta,
  consumeResponsesOutputTextMeta,
  consumeResponsesPayloadSnapshotByAliases,
  registerResponsesPayloadSnapshot,
  consumeResponsesPassthroughByAliases,
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
import { normalizeShellLikeToolInput } from '../../shared/anthropic-message-utils-core.js';
import {
  applyAnthropicResponseInboundBridgePolicy,
  applyAnthropicResponseOutboundBridgePolicy
} from './response-runtime-anthropic-policy.js';

export interface AnthropicResponseOptions {
  aliasMap?: ToolAliasMap;
  includeToolCallIds?: boolean;
}

function shouldLogAnthropicMapperDebug(payload: JsonObject): boolean {
  const governance =
    payload?.__rcc_tool_governance &&
    typeof payload.__rcc_tool_governance === 'object' &&
    !Array.isArray(payload.__rcc_tool_governance)
      ? (payload.__rcc_tool_governance as Record<string, unknown>)
      : undefined;
  return governance?.textHarvestApplied === true;
}

function cloneJsonRecord(value: Record<string, unknown>): Record<string, unknown> | undefined {
  try {
    const structuredCloneImpl = (globalThis as { structuredClone?: <T>(input: T) => T }).structuredClone;
    if (typeof structuredCloneImpl === 'function') {
      return structuredCloneImpl(value);
    }
  } catch {
    /* ignore structuredClone failures */
  }
  try {
    return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
  } catch {
    return { ...value };
  }
}

function stripInternalContinuationRequestId(chat: Record<string, unknown>): void {
  const semantics =
    chat?.semantics && typeof chat.semantics === 'object' && !Array.isArray(chat.semantics)
      ? (chat.semantics as Record<string, unknown>)
      : undefined;
  const continuation =
    semantics?.continuation && typeof semantics.continuation === 'object' && !Array.isArray(semantics.continuation)
      ? (semantics.continuation as Record<string, unknown>)
      : undefined;
  const resumeFrom =
    continuation?.resumeFrom && typeof continuation.resumeFrom === 'object' && !Array.isArray(continuation.resumeFrom)
      ? (continuation.resumeFrom as Record<string, unknown>)
      : undefined;
  if (resumeFrom && typeof resumeFrom.requestId === 'string') {
    delete resumeFrom.requestId;
  }
}

function restoreResponsesSemanticsFromSnapshot(
  chatResponse: JsonObject,
  payloadSnapshot: Record<string, unknown> | undefined
): void {
  if (!payloadSnapshot || typeof payloadSnapshot !== 'object' || Array.isArray(payloadSnapshot)) {
    return;
  }
  const restored = buildChatResponseFromResponsesWithNative(payloadSnapshot);
  if (!restored || typeof restored !== 'object' || Array.isArray(restored)) {
    return;
  }
  stripInternalContinuationRequestId(restored);
  const semantics =
    restored.semantics && typeof restored.semantics === 'object' && !Array.isArray(restored.semantics)
      ? cloneJsonRecord(restored.semantics as Record<string, unknown>)
      : undefined;
  if (!semantics) {
    return;
  }
  (chatResponse as any).semantics = semantics;
}

function unwrapAnthropicMessagePayload(payload: JsonObject): JsonObject {
  const nested = payload?.data;
  if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
    const record = nested as JsonObject;
    if (
      Array.isArray(record.content)
      || typeof record.stop_reason === 'string'
      || typeof record.role === 'string'
      || typeof record.model === 'string'
      || typeof record.id === 'string'
    ) {
      return record;
    }
  }
  return payload;
}

function hasVisibleAnthropicAssistantOutput(
  textParts: string[],
  reasoningParts: string[],
  canonicalToolCalls: Array<Record<string, unknown>>
): boolean {
  return textParts.some((text) => text.trim().length > 0)
    || reasoningParts.some((text) => text.trim().length > 0)
    || canonicalToolCalls.length > 0;
}

export function buildOpenAIChatFromAnthropicMessage(payload: JsonObject, options?: AnthropicResponseOptions): JsonObject {
  const messagePayload = unwrapAnthropicMessagePayload(payload);
  const content = Array.isArray(messagePayload?.content) ? messagePayload.content : [];
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
      const input = normalizeShellLikeToolInput(name || rawName, (part as Record<string, unknown>).input);
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
      const key = deriveToolCallKeyWithNative(existing);
      if (key) seen.add(key);
    }
    for (const inferred of inferredToolCalls) {
      const key = deriveToolCallKeyWithNative(inferred);
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
    role: typeof messagePayload.role === 'string' ? messagePayload.role : 'assistant',
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
  applyAnthropicResponseInboundBridgePolicy(message, messagePayload as Record<string, unknown>);

  const shouldLogDebug = shouldLogAnthropicMapperDebug(messagePayload);
  if (shouldLogDebug) {
    console.log('[ANTHROPIC-MAPPER:DEBUG] stop_reason from payload:', JSON.stringify(messagePayload['stop_reason']));
    console.log('[ANTHROPIC-MAPPER:DEBUG] toolCalls count:', toolCalls.length);
    console.log('[ANTHROPIC-MAPPER:DEBUG] inferredToolCalls count:', inferredToolCalls.length);
    console.log('[ANTHROPIC-MAPPER:DEBUG] canonicalToolCalls count:', canonicalToolCalls.length);
    console.log('[ANTHROPIC-MAPPER:DEBUG] textParts count:', textParts.length, 'preview:', textParts.join('').slice(0, 100));
  }

  const stopReason = typeof messagePayload['stop_reason'] === 'string' ? messagePayload['stop_reason'] : undefined;
  const hasVisibleAssistantOutput = hasVisibleAnthropicAssistantOutput(
    textParts,
    reasoningParts,
    canonicalToolCalls
  );
  if (!hasVisibleAssistantOutput && stopReason === 'max_tokens') {
    throw new ProviderProtocolError(
      'Anthropic upstream returned stop_reason=max_tokens with empty assistant output',
      {
        code: 'MALFORMED_RESPONSE',
        protocol: 'anthropic-messages',
        providerType: 'anthropic',
        category: 'EXTERNAL_ERROR',
        details: {
          stop_reason: stopReason,
          response_id: typeof messagePayload.id === 'string' ? messagePayload.id : undefined,
          reason: 'empty_assistant_max_tokens'
        }
      }
    );
  }
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
          response_id: typeof messagePayload.id === 'string' ? messagePayload.id : undefined
        }
      }
    );
  }
  const finishReason = outcome.finishReason;
  if (shouldLogDebug) {
    console.log('[ANTHROPIC-MAPPER:DEBUG] outcome:', JSON.stringify(outcome));
    console.log('[ANTHROPIC-MAPPER:DEBUG] resolved finishReason:', finishReason);
  }

  const chatResponse = {
    id: typeof messagePayload.id === 'string' ? messagePayload.id : `chatcmpl_${Date.now()}`,
    object: 'chat.completion',
    created: typeof messagePayload?.['created'] === 'number' ? messagePayload['created'] : Math.floor(Date.now() / 1000),
    model: typeof messagePayload.model === 'string' ? messagePayload.model : 'unknown',
    choices: [
      {
        index: 0,
        finish_reason: finishReason,
        message
      }
    ],
    usage: messagePayload['usage'] && typeof messagePayload['usage'] === 'object'
      ? messagePayload['usage']
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
  const retentionAliases = [
    chatResponse.id,
    typeof (messagePayload as any)?.request_id === 'string' ? (messagePayload as any).request_id : undefined,
    typeof (messagePayload as any)?.id === 'string' ? (messagePayload as any).id : undefined,
    typeof (payload as any)?.request_id === 'string' ? (payload as any).request_id : undefined,
    typeof (payload as any)?.id === 'string' ? (payload as any).id : undefined
  ];
  const payloadSnapshot = consumeResponsesPayloadSnapshotByAliases(retentionAliases);
  if (payloadSnapshot) {
    registerResponsesPayloadSnapshot(chatResponse.id, payloadSnapshot, { clone: false });
    (chatResponse as any).__responses_payload_snapshot = payloadSnapshot;
    if (typeof (chatResponse as any).request_id !== 'string') {
      (chatResponse as any).request_id = chatResponse.id;
    }
    restoreResponsesSemanticsFromSnapshot(chatResponse, payloadSnapshot);
  }
  const passthroughPayload = consumeResponsesPassthroughByAliases(retentionAliases);
  if (passthroughPayload) {
    registerResponsesPassthrough(chatResponse.id, passthroughPayload, { clone: false });
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
  const contentBlocks = Array.isArray((sanitized as any).content)
    ? ((sanitized as any).content as Array<Record<string, unknown>>)
    : [];
  for (const block of contentBlocks) {
    if (!block || block.type !== 'tool_use' || typeof block.name !== 'string') {
      continue;
    }
    block.input = normalizeShellLikeToolInput(block.name, block.input);
  }
  if ((chatResponse as any)?.__responses_reasoning) {
    registerResponsesReasoning(sanitized.id, (chatResponse as any).__responses_reasoning);
  }
  if ((chatResponse as any)?.__responses_output_text_meta) {
    registerResponsesOutputTextMeta(sanitized.id, (chatResponse as any).__responses_output_text_meta);
  }
  const retainedSnapshot = (chatResponse as any)?.__responses_payload_snapshot;
  if (retainedSnapshot && typeof retainedSnapshot === 'object' && !Array.isArray(retainedSnapshot)) {
    for (const candidate of new Set(
      [sanitized.id, (sanitized as any)?.request_id, (chatResponse as any)?.id, (chatResponse as any)?.request_id]
        .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    )) {
      registerResponsesPayloadSnapshot(candidate, retainedSnapshot as Record<string, unknown>, { clone: false });
    }
  }
  const retainedPassthrough = (chatResponse as any)?.__responses_passthrough;
  if (retainedPassthrough && typeof retainedPassthrough === 'object' && !Array.isArray(retainedPassthrough)) {
    for (const candidate of new Set(
      [sanitized.id, (sanitized as any)?.request_id, (chatResponse as any)?.id, (chatResponse as any)?.request_id]
        .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    )) {
      registerResponsesPassthrough(candidate, retainedPassthrough as Record<string, unknown>, { clone: false });
    }
  }
  return sanitized;
}
