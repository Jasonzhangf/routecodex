import type { JsonObject, JsonValue } from '../types/json.js';
import { extractToolCallsFromReasoningText } from '../../shared/reasoning-tool-parser.js';
import { deriveToolCallKey } from '../../shared/tool-call-utils.js';
import { createBridgeActionState, runBridgeActionPipeline } from '../../bridge-actions.js';
import { resolveBridgePolicy, resolvePolicyActions } from '../../bridge-policies.js';
import { normalizeAnthropicToolName } from '../../shared/anthropic-message-utils.js';
import { buildAnthropicResponseFromChatWithNative } from '../../../router/virtual-router/engine-selection/native-hub-pipeline-resp-semantics.js';
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

type ToolAliasMap = Record<string, string>;

function flattenAnthropicContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(flattenAnthropicContent).filter(Boolean).join('');
  }
  if (content && typeof content === 'object') {
    const block = content as Record<string, unknown>;
    if (typeof block.text === 'string') return block.text;
    if (typeof block.content === 'string') return block.content;
    if (Array.isArray(block.content)) return block.content.map(flattenAnthropicContent).filter(Boolean).join('');
  }
  return '';
}

interface AnthropicResponseOptions {
  aliasMap?: ToolAliasMap;
  includeToolCallIds?: boolean;
}

function sanitizeAnthropicToolUseId(raw: unknown): string {
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed && /^[A-Za-z0-9_-]+$/.test(trimmed)) {
      return trimmed;
    }
  }
  return `call_${Math.random().toString(36).slice(2, 10)}`;
}

function coerceNonNegativeNumber(...candidates: unknown[]): number | undefined {
  for (const value of candidates) {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
      return value;
    }
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (!trimmed.length) continue;
      const parsed = Number(trimmed);
      if (Number.isFinite(parsed) && parsed >= 0) {
        return parsed;
      }
    }
  }
  return undefined;
}

function createToolNameResolver(options?: AnthropicResponseOptions): (name: string) => string {
  const reverse = new Map<string, string>();
  const shouldReplaceAlias = (existingCanonical: string, nextCanonical: string, providerKey: string): boolean => {
    const existing = existingCanonical.trim().toLowerCase();
    const next = nextCanonical.trim().toLowerCase();
    if (!existing) {
      return true;
    }
    // Prefer exact identity mapping first (providerName == canonicalName).
    if (next === providerKey && existing !== providerKey) {
      return true;
    }
    if (existing === providerKey && next !== providerKey) {
      return false;
    }
    // When provider emits exec_command, never downgrade back to shell_command.
    if (providerKey === 'exec_command') {
      if (next === 'exec_command' && existing !== 'exec_command') {
        return true;
      }
      if (existing === 'exec_command' && next !== 'exec_command') {
        return false;
      }
    }
    return false;
  };
  const aliasMap = options?.aliasMap;
  if (aliasMap && typeof aliasMap === 'object') {
    for (const [canonical, providerName] of Object.entries(aliasMap)) {
      if (typeof canonical !== 'string' || typeof providerName !== 'string') continue;
      const canonicalName = canonical.trim();
      if (!canonicalName.length) continue;
      const normalizedProvider = providerName.trim().toLowerCase();
      if (!normalizedProvider.length) continue;
      const existing = reverse.get(normalizedProvider);
      if (!existing || shouldReplaceAlias(existing, canonicalName, normalizedProvider)) {
        reverse.set(normalizedProvider, canonicalName);
      }
    }
  }
  return (rawName: string): string => {
    const trimmed = typeof rawName === 'string' ? rawName.trim() : '';
    if (!trimmed.length) {
      return '';
    }
    const lookup = reverse.get(trimmed.toLowerCase());
    if (lookup && lookup.trim().length) {
      return lookup.trim();
    }
    const normalized = normalizeAnthropicToolName(trimmed);
    return (normalized && normalized.trim().length ? normalized : trimmed).trim();
  };
}

function extractAliasMapFromChatPayload(payload: JsonObject): ToolAliasMap | undefined {
  // Deprecated: tool-name alias maps are mappable semantics and must be carried via requestSemantics
  // (ChatSemantics.tools.toolNameAliasMap). Do not embed them inside response payload fields/metadata.
  void payload;
  return undefined;
}

function createToolAliasSerializer(aliasMap?: ToolAliasMap): (canonical: string) => string {
  if (!aliasMap || typeof aliasMap !== 'object') {
    return (name) => name;
  }
  const lookup = new Map<string, string>();
  for (const [canonical, providerName] of Object.entries(aliasMap)) {
    if (typeof canonical !== 'string' || typeof providerName !== 'string') continue;
    const key = canonical.trim().toLowerCase();
    if (!key.length) continue;
    if (!lookup.has(key)) {
      lookup.set(key, providerName);
    }
  }
  if (!lookup.size) {
    return (name) => name;
  }
  return (name: string): string => {
    const trimmed = typeof name === 'string' ? name.trim() : '';
    if (!trimmed.length) {
      return name;
    }
    const resolved = lookup.get(trimmed.toLowerCase());
    return resolved ? resolved : name;
  };
}

export function buildOpenAIChatFromAnthropicMessage(payload: JsonObject, options?: AnthropicResponseOptions): JsonObject {
  const content = Array.isArray(payload?.content) ? payload.content : [];
  const textParts: string[] = [];
  const toolCalls: Array<{ id: string; name: string; args: string }> = [];
  const aliasCollector: Record<string, string> = {};
  const inferredToolCalls: Array<Record<string, unknown>> = [];
  const reasoningParts: string[] = [];
  const resolveToolName = createToolNameResolver(options);

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
        const trimmedRaw = rawName.trim();
        if (trimmedRaw.length && !aliasCollector[name]) {
          aliasCollector[name] = trimmedRaw;
        }
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
    }
  }

  const mapFinishReason = (reason: string | undefined): string => {
    switch (reason) {
      case 'tool_use': return 'tool_calls';
      case 'max_tokens': return 'length';
      case 'stop_sequence': return 'stop';
      default: return 'stop';
    }
  };

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
  if (canonicalToolCalls.length) {
    (message as any).tool_calls = canonicalToolCalls;
  }
  if (reasoningParts.length) {
    (message as any).reasoning_content = reasoningParts.join('\n');
  }
  try {
    const bridgePolicy = resolveBridgePolicy({ protocol: 'anthropic-messages' });
    const actions = resolvePolicyActions(bridgePolicy, 'response_inbound');
    if (actions?.length) {
      const actionState = createBridgeActionState({
        messages: [message],
        rawResponse: payload
      });
      runBridgeActionPipeline({
        stage: 'response_inbound',
        actions,
        protocol: bridgePolicy?.protocol ?? 'anthropic-messages',
        moduleType: bridgePolicy?.moduleType ?? 'anthropic-messages',
        requestId: typeof payload.id === 'string' ? payload.id : undefined,
        state: actionState
      });
    }
  } catch {
    // ignore policy failures
  }

  const stopReason = typeof payload['stop_reason'] === 'string' ? payload['stop_reason'] : undefined;
  const finishReason = canonicalToolCalls.length ? 'tool_calls' : mapFinishReason(stopReason);

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
  const localReasoning = reasoningParts.length
    ? {
      content: reasoningParts.map((text) => ({ type: 'reasoning_text' as const, text }))
    }
    : undefined;
  const preserved = consumeResponsesReasoning(chatResponse.id);
  if (preserved) {
    (chatResponse as any).__responses_reasoning = preserved;
  } else if (localReasoning) {
    (chatResponse as any).__responses_reasoning = localReasoning;
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

function mapShellCommandArgsForAnthropic(raw: unknown): JsonObject {
  const result: JsonObject = {};
  const source = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? (raw as Record<string, unknown>) : {};

  const coerceCommand = (value: unknown): string => {
    if (typeof value === 'string' && value.trim().length) {
      return value.trim();
    }
    if (Array.isArray(value)) {
      const parts = value
        .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
        .filter((entry) => entry.length > 0);
      if (parts.length) {
        return parts.join(' ');
      }
    }
    return '';
  };

  const commandRaw = coerceCommand(source.command) || coerceCommand(source.cmd);
  const command = commandRaw.trim();
  if (command) {
    (result as any).command = command;
  }

  const timeoutRaw = source.timeout_ms ?? source.timeout;
  if (typeof timeoutRaw === 'number' && Number.isFinite(timeoutRaw)) {
    (result as any).timeout = timeoutRaw;
  } else if (typeof timeoutRaw === 'string' && timeoutRaw.trim().length) {
    const parsed = Number(timeoutRaw.trim());
    if (Number.isFinite(parsed)) {
      (result as any).timeout = parsed;
    }
  }

  if (typeof source.description === 'string' && source.description.trim().length) {
    (result as any).description = source.description;
  }
  if (typeof (source as any).run_in_background === 'boolean') {
    (result as any).run_in_background = (source as any).run_in_background;
  }
  if (typeof (source as any).dangerouslyDisableSandbox === 'boolean') {
    (result as any).dangerouslyDisableSandbox = (source as any).dangerouslyDisableSandbox;
  }

  return result;
}

export function buildAnthropicResponseFromChat(chatResponse: JsonObject, options?: AnthropicResponseOptions): JsonObject {
  const choice = Array.isArray(chatResponse?.choices) ? chatResponse.choices[0] as JsonObject | undefined : undefined;
  const message = choice && typeof choice === 'object' ? (choice as Record<string, unknown>).message : undefined;
  const aliasMap = options?.aliasMap;
  if (message) {
    try {
      const bridgePolicy = resolveBridgePolicy({ protocol: 'anthropic-messages' });
      const actions = resolvePolicyActions(bridgePolicy, 'response_outbound');
      if (actions?.length) {
        const actionState = createBridgeActionState({
          messages: [message as Record<string, unknown>]
        });
        runBridgeActionPipeline({
          stage: 'response_outbound',
          actions,
          protocol: bridgePolicy?.protocol ?? 'anthropic-messages',
          moduleType: bridgePolicy?.moduleType ?? 'anthropic-messages',
          requestId: typeof chatResponse.id === 'string' ? chatResponse.id : undefined,
          state: actionState
        });
      }
    } catch {
      // ignore policy failures
    }
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

function sanitizeAnthropicMessage(message: JsonObject): JsonObject {
  const sanitized: Record<string, unknown> = {};
  const allowedTopLevel = new Set(['id', 'type', 'role', 'content', 'model', 'stop_reason', 'stop_sequence', 'usage']);
  for (const key of allowedTopLevel) {
    if (message[key] !== undefined) {
      sanitized[key] = message[key];
    }
  }

  const content = Array.isArray(message.content) ? message.content : [];
  sanitized.content = content
    .map((block) => sanitizeContentBlock(block as Record<string, unknown>))
    .filter((block): block is JsonObject => block !== null);

  const usage = message.usage;
  if (usage && typeof usage === 'object') {
    sanitized.usage = JSON.parse(JSON.stringify(usage));
  }
  return sanitized as JsonObject;
}

function sanitizeContentBlock(block: Record<string, unknown>): JsonObject | null {
  if (!block || typeof block !== 'object') return null;
  const type = typeof block.type === 'string' ? block.type : '';
  if (type === 'text') {
    if (typeof block.text !== 'string') return null;
    return { type: 'text', text: block.text } as JsonObject;
  }
  if (type === 'thinking' || type === 'reasoning') {
    const text = typeof block.text === 'string'
      ? block.text
      : flattenAnthropicContent(block.content);
    if (!text || !String(text).trim().length) return null;
    return {
      type: type === 'reasoning' ? 'reasoning' : 'thinking',
      text: String(text)
    } as JsonObject;
  }
  if (type === 'tool_use') {
    const id = typeof block.id === 'string' && block.id.trim() ? block.id : `call_${Math.random().toString(36).slice(2, 8)}`;
    const name = typeof block.name === 'string' ? block.name : '';
    if (!name) return null;
    return {
      type: 'tool_use',
      id,
      name,
      input: block.input ?? {}
    } as JsonObject;
  }
  if (type === 'tool_result') {
    if (typeof block.tool_use_id !== 'string' || !block.tool_use_id.trim()) return null;
    const sanitized: Record<string, unknown> = {
      type: 'tool_result',
      tool_use_id: block.tool_use_id,
      content: block.content ?? ''
    };
    if (typeof block.is_error === 'boolean') {
      sanitized.is_error = block.is_error;
    }
    return sanitized as JsonObject;
  }
  return null;
}

interface ToolResultCandidate {
  tool_use_id: string;
  content?: string;
  is_error?: boolean;
}

function extractToolResultBlocks(chatResponse: JsonObject): ToolResultCandidate[] {
  const results: ToolResultCandidate[] = [];
  const seen = new Set<string>();
  const append = (candidate: ToolResultCandidate | null | undefined) => {
    if (!candidate) return;
    if (seen.has(candidate.tool_use_id)) {
      return;
    }
    seen.add(candidate.tool_use_id);
    results.push(candidate);
  };
  const primary = Array.isArray((chatResponse as Record<string, unknown>).tool_outputs)
    ? (chatResponse as Record<string, unknown>).tool_outputs as Array<Record<string, unknown>>
    : [];
  primary.forEach(entry => append(normalizeToolResultEntry(entry)));

  const meta = (chatResponse as Record<string, unknown>).metadata;
  if (meta && typeof meta === 'object') {
    const captured = (meta as Record<string, unknown>).capturedToolResults;
    if (Array.isArray(captured)) {
      captured.forEach(entry => append(normalizeToolResultEntry(entry as Record<string, unknown>)));
    }
  }

  if (choiceHasCapturedResults(chatResponse)) {
    try {
      const choice = Array.isArray(chatResponse?.choices) ? chatResponse.choices[0] : undefined;
      const msgMeta = choice && typeof choice === 'object' ? (choice as Record<string, unknown>).message : undefined;
      const captured = msgMeta && typeof msgMeta === 'object'
        ? (msgMeta as Record<string, unknown>).capturedToolResults
        : undefined;
      if (Array.isArray(captured)) {
        captured.forEach(entry => append(normalizeToolResultEntry(entry as Record<string, unknown>)));
      }
    } catch {
      /* ignore best-effort metadata extraction */
    }
  }

  return results;
}

function choiceHasCapturedResults(chatResponse: JsonObject): boolean {
  if (!Array.isArray(chatResponse?.choices)) {
    return false;
  }
  const first = chatResponse.choices[0];
  if (!first || typeof first !== 'object') {
    return false;
  }
  const message = (first as Record<string, unknown>).message;
  if (!message || typeof message !== 'object') {
    return false;
  }
  return Array.isArray((message as Record<string, unknown>).capturedToolResults);
}

function normalizeToolResultEntry(entry: Record<string, unknown> | undefined): ToolResultCandidate | null {
  if (!entry || typeof entry !== 'object') {
    return null;
  }
  const rawId = entry.tool_call_id ?? entry.call_id ?? entry.id;
  if (typeof rawId !== 'string' || !rawId.trim().length) {
    return null;
  }
  const toolUseId = rawId.trim();
  const rawContent = 'content' in entry ? entry.content : entry.output;
  const content = normalizeToolContent(rawContent);
  const isError = typeof entry.is_error === 'boolean' ? entry.is_error : undefined;
  return {
    tool_use_id: toolUseId,
    content,
    is_error: isError
  };
}

function normalizeToolContent(value: unknown): string | undefined {
  if (value == null) {
    return undefined;
  }
  if (typeof value === 'string') {
    return value;
  }
  try {
    const serialized = JSON.stringify(value);
    return serialized;
  } catch {
    return String(value);
  }
}
