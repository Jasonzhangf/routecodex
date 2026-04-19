import { createBridgeActionState, runBridgeActionPipeline } from '../bridge-actions.js';
import { resolveBridgePolicy, resolvePolicyActions } from '../bridge-policies.js';
import { ProviderProtocolError } from '../provider-protocol-error.js';
import { normalizeChatMessageContent } from './chat-output-normalizer.js';
import { jsonClone, type JsonValue, type JsonObject } from '../hub/types/json.js';
import { mapAnthropicToolsToChat } from './anthropic-message-utils-tool-schema.js';
import { coerceAnthropicAliasRecord } from './anthropic-message-utils-openai-response.js';
import {
  flattenAnthropicText,
  isObject,
  normalizeAnthropicToolName,
  normalizeToolResultContent,
  requireTrimmedString,
  safeJson
} from './anthropic-message-utils-core.js';
export { denormalizeAnthropicToolName, normalizeAnthropicToolName } from './anthropic-message-utils-core.js';
export { mapAnthropicToolsToChat, mapChatToolsToAnthropicTools } from './anthropic-message-utils-tool-schema.js';
export type { BuildAnthropicFromOpenAIOptions } from './anthropic-message-utils-openai-response.js';
export { buildAnthropicFromOpenAIChat } from './anthropic-message-utils-openai-response.js';
export { buildAnthropicRequestFromOpenAIChat } from './anthropic-message-utils-openai-request.js';

type Unknown = Record<string, unknown>;
type UnknownArray = Unknown[];

interface OpenAIChatPayload extends Unknown {
  messages: UnknownArray;
}

function stripOpenAIChatToolAliasFields(messages: UnknownArray): void {
  // No-op: preserve tool_call_id/call_id for downstream consumers and regression parity.
  void messages;
}

function stripToolCallIdFieldsFromAssistant(messages: UnknownArray): void {
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;
    const role = String((message as any).role || '').toLowerCase();
    if (role !== 'assistant') continue;
    const calls = (message as any).tool_calls;
    if (!Array.isArray(calls)) continue;
    for (const call of calls) {
      if (!call || typeof call !== 'object') continue;
      delete (call as any).call_id;
      delete (call as any).tool_call_id;
    }
  }
}
function invertAnthropicAliasMap(source: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!source) {
    return undefined;
  }
  const inverted: Record<string, string> = {};
  for (const [canonical, raw] of Object.entries(source)) {
    if (typeof canonical !== 'string' || typeof raw !== 'string') {
      continue;
    }
    const trimmedCanonical = canonical.trim();
    const trimmedRaw = raw.trim();
    if (!trimmedCanonical.length) {
      continue;
    }
    if (trimmedRaw.length) {
      inverted[trimmedRaw.toLowerCase()] = trimmedCanonical;
    }
    if (!inverted[trimmedCanonical.toLowerCase()]) {
      inverted[trimmedCanonical.toLowerCase()] = trimmedCanonical;
    }
  }
  return Object.keys(inverted).length ? inverted : undefined;
}

function hasVisibleText(value: string | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

function requireAnthropicTextPreserveWhitespace(block: unknown, context: string): string {
  const text = flattenAnthropicText(block);
  if (!hasVisibleText(text)) {
    throw new ProviderProtocolError(
      `Anthropic bridge constraint violated: ${context} must contain text`,
      {
        code: 'MALFORMED_REQUEST',
        protocol: 'anthropic-messages',
        providerType: 'anthropic',
        details: { context }
      }
    );
  }
  return text;
}

export function buildOpenAIChatFromAnthropic(
  payload: unknown,
  options?: { includeToolCallIds?: boolean }
): OpenAIChatPayload {
  const newMessages: UnknownArray = [];
  const body = isObject(payload) ? payload : {};
  const canonicalAliasMap = coerceAnthropicAliasRecord(buildAnthropicToolAliasMap((body as Record<string, unknown>).tools));
  const reverseAliasMap = invertAnthropicAliasMap(canonicalAliasMap);
  const resolveToolName = (candidate: unknown): string => {
    if (typeof candidate !== 'string') {
      return '';
    }
    const trimmed = candidate.trim();
    if (!trimmed.length) {
      return trimmed;
    }
    const normalized = normalizeAnthropicToolName(trimmed) ?? trimmed;
    if (reverseAliasMap) {
      const direct = reverseAliasMap[trimmed.toLowerCase()];
      if (typeof direct === 'string' && direct.trim().length) {
        return direct.trim();
      }
      const normalizedLookup = reverseAliasMap[normalized.toLowerCase()];
      if (typeof normalizedLookup === 'string' && normalizedLookup.trim().length) {
        return normalizedLookup.trim();
      }
    }
    return normalized;
  };
  const rawSystem = body.system;
  const systemBlocks: unknown[] = Array.isArray(rawSystem)
    ? rawSystem
    : rawSystem !== undefined && rawSystem !== null
      ? [rawSystem]
      : [];
  for (const block of systemBlocks) {
    const text = requireAnthropicTextPreserveWhitespace(block, 'system entry');
    newMessages.push({ role: 'system', content: text });
  }

  const msgs = Array.isArray(body.messages) ? body.messages : [];
  for (const m of msgs) {
    if (!m || typeof m !== 'object') continue;
    const role = typeof m.role === 'string' ? String(m.role) : 'user';
    const content = (m as any).content;
    if (!Array.isArray(content)) {
      const text = flattenAnthropicText(content);
      if (hasVisibleText(text)) {
        const normalized = normalizeChatMessageContent(text);
        const reasoningText =
          typeof normalized.reasoningText === 'string' && normalized.reasoningText.trim().length
            ? normalized.reasoningText
            : undefined;
        const message: Unknown = {
          role,
          content: reasoningText ? (normalized.contentText ?? text) : text
        };
        if (reasoningText) {
          (message as any).reasoning_content = reasoningText;
        }
        newMessages.push(message);
      }
      continue;
    }
    const textParts: string[] = [];
    const imageBlocks: UnknownArray = [];
    const toolCalls: UnknownArray = [];
    const reasoningParts: string[] = [];
    const toolResults: UnknownArray = [];
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      const t = String((block as any).type || '').toLowerCase();
      if (t === 'text' && typeof (block as any).text === 'string') {
        const s = String((block as any).text);
        if (hasVisibleText(s)) textParts.push(s);
      } else if (t === 'thinking' || t === 'reasoning') {
        const thinkingText = flattenAnthropicText(block);
        if (hasVisibleText(thinkingText)) {
          reasoningParts.push(thinkingText);
        }
      } else if (t === 'image') {
        const source = (block as any).source;
        if (source && typeof source === 'object') {
          const s = source as Record<string, unknown>;
          const srcType = typeof s.type === 'string' ? s.type.toLowerCase() : '';
          let url: string | undefined;
          if (srcType === 'url' && typeof s.url === 'string') {
            url = s.url;
          } else if (srcType === 'base64' && typeof s.data === 'string') {
            const mediaType =
              typeof s.media_type === 'string' && s.media_type.trim().length
                ? s.media_type.trim()
                : 'image/png';
            url = `data:${mediaType};base64,${s.data}`;
          }
          if (url && url.trim().length) {
            imageBlocks.push({
              type: 'image_url',
              image_url: { url: url.trim() }
            });
          }
        }
      } else if (t === 'tool_use') {
        const name = requireTrimmedString((block as any).name, 'tool_use.name');
        const id = requireTrimmedString((block as any).id, 'tool_use.id');
        const input = (block as any).input ?? {};
        const args = safeJson(input);
        const canonicalName = resolveToolName(name) || name;
        const includeIds = options?.includeToolCallIds === true;
        toolCalls.push({
          id,
          ...(includeIds ? { call_id: id, tool_call_id: id } : {}),
          type: 'function',
          function: { name: canonicalName, arguments: args }
        });
      } else if (t === 'tool_result') {
        const callId = requireTrimmedString(
          (block as any).tool_call_id ??
            (block as any).call_id ??
            (block as any).tool_use_id ??
            (block as any).id,
          'tool_result.tool_use_id'
        );
        const contentStr = normalizeToolResultContent(block);
        toolResults.push({ role: 'tool', tool_call_id: callId, content: contentStr });
      }
    }
    const combinedText = textParts.join('');
    const normalized = normalizeChatMessageContent(combinedText);
    const hasRawText = typeof combinedText === 'string' && combinedText.trim().length > 0;
    const mergedReasoning: string[] = [...reasoningParts];
    if (typeof normalized.reasoningText === 'string' && normalized.reasoningText.trim().length) {
      mergedReasoning.push(normalized.reasoningText);
    }
    const hasText = typeof normalized.contentText === 'string' && normalized.contentText.length > 0;
    const hasReasoning = mergedReasoning.length > 0;
    if (hasText || hasRawText || toolCalls.length > 0 || hasReasoning || imageBlocks.length > 0) {
      let contentNode: unknown = hasReasoning
        ? ((hasText ? normalized.contentText : undefined) ?? combinedText ?? '')
        : (combinedText ?? '');
      if (imageBlocks.length > 0) {
        const blocks: UnknownArray = [];
        const textPayload = hasReasoning
          ? ((hasText ? normalized.contentText : undefined) ?? combinedText ?? '')
          : (combinedText ?? '');
        if (typeof textPayload === 'string' && textPayload.trim().length) {
          blocks.push({ type: 'text', text: textPayload });
        }
        for (const img of imageBlocks) {
          blocks.push(jsonClone(img as JsonValue) as Unknown);
        }
        contentNode = blocks;
      }
      const msg: Unknown = {
        role,
        content: contentNode
      };
      if (toolCalls.length) msg.tool_calls = toolCalls;
      if (hasReasoning) {
        (msg as any).reasoning_content = mergedReasoning.join('\n');
      }
      newMessages.push(msg);
    }
    for (const tr of toolResults) newMessages.push(tr);
  }
  const request: OpenAIChatPayload = { messages: newMessages };
  if (typeof body.model === 'string') request.model = body.model;
  if (typeof body.max_tokens === 'number') request.max_tokens = body.max_tokens;
  if (typeof body.temperature === 'number') request.temperature = body.temperature;
  if (typeof body.top_p === 'number') request.top_p = body.top_p;
  if (typeof body.stream === 'boolean') request.stream = body.stream;
  if (typeof (body as any).id === 'string') {
    (request as Record<string, unknown>).request_id = (body as any).id;
  } else if (typeof (body as any).request_id === 'string') {
    (request as Record<string, unknown>).request_id = (body as any).request_id;
  }
  if ('tool_choice' in body) request.tool_choice = body.tool_choice;
  const normalizedTools = mapAnthropicToolsToChat(body.tools);
  if (normalizedTools !== undefined) {
    request.tools = normalizedTools;
  }
  try {
    const bridgePolicy = resolveBridgePolicy({ protocol: 'anthropic-messages' });
    const actions = resolvePolicyActions(bridgePolicy, 'request_inbound');
    if (actions?.length) {
      const actionState = createBridgeActionState({
        messages: newMessages,
        rawRequest: body
      });
      runBridgeActionPipeline({
        stage: 'request_inbound',
        actions,
        protocol: bridgePolicy?.protocol ?? 'anthropic-messages',
        moduleType: bridgePolicy?.moduleType ?? 'anthropic-messages',
        requestId: typeof body?.id === 'string' ? String(body.id) : undefined,
        state: actionState
      });
    }
  } catch {
    // ignore policy failures
  }
  stripToolCallIdFieldsFromAssistant(newMessages);
  stripOpenAIChatToolAliasFields(newMessages);
  return request;
}

export function buildAnthropicToolAliasMap(rawTools: unknown): JsonObject | undefined {
  if (!Array.isArray(rawTools) || rawTools.length === 0) {
    return undefined;
  }
  const aliasMap = new Map<string, string>();
  for (const entry of rawTools) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      continue;
    }
    const rawName = typeof (entry as Record<string, unknown>).name === 'string'
      ? ((entry as Record<string, unknown>).name as string).trim()
      : undefined;
    if (!rawName) {
      continue;
    }
    const normalized = normalizeAnthropicToolName(rawName) ?? rawName;
    const canonicalKey = normalized.trim();
    if (!canonicalKey.length) {
      continue;
    }
    aliasMap.set(canonicalKey, rawName);
    const lowerKey = canonicalKey.toLowerCase();
    if (lowerKey !== canonicalKey && !aliasMap.has(lowerKey)) {
      aliasMap.set(lowerKey, rawName);
    }
  }
  if (!aliasMap.size) {
    return undefined;
  }
  const serialized: JsonObject = {};
  for (const [key, value] of aliasMap.entries()) {
    serialized[key] = value;
  }
  return serialized;
}
