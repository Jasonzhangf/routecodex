import type { ChatEnvelope, ChatMessage, ChatToolCall } from '../../types/chat-envelope.js';
import { isJsonObject, jsonClone, type JsonObject, type JsonValue } from '../../types/json.js';
import type { BridgeToolDefinition } from '../../../types/bridge-message-types.js';
import { sanitizeReasoningTaggedText } from '../../../shared/reasoning-utils.js';
import { GENERATION_CONFIG_KEYS } from './gemini-thinking-config.js';
import type { GeminiPayload } from './gemini-antigravity-request.js';

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function buildToolSchemaKeyMap(defs: BridgeToolDefinition[]): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const def of defs) {
    const fnNode =
      def && typeof def === 'object' && def.function && typeof def.function === 'object'
        ? (def.function as Record<string, unknown>)
        : undefined;
    const name =
      typeof fnNode?.name === 'string'
        ? fnNode.name
        : typeof (def as unknown as { name?: unknown })?.name === 'string'
          ? String((def as unknown as { name: string }).name)
          : '';
    if (!name || !name.trim()) continue;
    const parameters =
      (fnNode && (fnNode as { parameters?: unknown }).parameters) ??
      ((def as unknown as { parameters?: unknown }).parameters);
    if (!isPlainRecord(parameters)) continue;
    const props = (parameters as { properties?: unknown }).properties;
    if (!isPlainRecord(props)) continue;
    const keys = Object.keys(props).filter((k) => typeof k === 'string' && k.trim().length > 0);
    if (!keys.length) continue;
    map.set(name, new Set(keys));
  }
  return map;
}

export function alignToolCallArgsToSchema(options: {
  toolName: string;
  args: unknown;
  schemaKeys: Map<string, Set<string>>;
}): unknown {
  const name = typeof options.toolName === 'string' ? options.toolName.trim() : '';
  if (!name) return options.args;
  const schema = options.schemaKeys.get(name);
  if (!schema || schema.size === 0) {
    return options.args;
  }
  if (!isPlainRecord(options.args)) {
    return options.args;
  }

  const lowered = name.toLowerCase();
  const next: Record<string, unknown> = { ...options.args };

  // Align historical Codex tool args to the *declared schema* for Gemini.
  // Gemini validates historical functionCall.args against tool declarations, so mismatches like:
  // - exec_command: { cmd } vs schema { command } (or vice-versa)
  // - apply_patch: { patch/input } vs schema { instructions } (or vice-versa)
  // can cause MALFORMED_FUNCTION_CALL and empty responses.
  if (lowered === 'exec_command') {
    // Prefer the declared schema key; do not delete keys blindly.
    if (schema.has('cmd') && !Object.prototype.hasOwnProperty.call(next, 'cmd') && Object.prototype.hasOwnProperty.call(next, 'command')) {
      next.cmd = next.command;
    }
    if (schema.has('command') && !Object.prototype.hasOwnProperty.call(next, 'command') && Object.prototype.hasOwnProperty.call(next, 'cmd')) {
      next.command = next.cmd;
    }
  } else if (lowered === 'write_stdin') {
    if (schema.has('chars') && !Object.prototype.hasOwnProperty.call(next, 'chars') && Object.prototype.hasOwnProperty.call(next, 'text')) {
      next.chars = next.text;
    }
    if (schema.has('text') && !Object.prototype.hasOwnProperty.call(next, 'text') && Object.prototype.hasOwnProperty.call(next, 'chars')) {
      next.text = next.chars;
    }
  } else if (lowered === 'apply_patch') {
    if (schema.has('instructions') && !Object.prototype.hasOwnProperty.call(next, 'instructions')) {
      const patch = typeof next.patch === 'string' ? next.patch : undefined;
      const input = typeof next.input === 'string' ? next.input : undefined;
      const candidate = patch && patch.trim().length ? patch : input && input.trim().length ? input : undefined;
      if (candidate) {
        next.instructions = candidate;
      }
    }
    if (schema.has('patch') && !Object.prototype.hasOwnProperty.call(next, 'patch')) {
      const input = typeof next.input === 'string' ? next.input : undefined;
      if (input && input.trim().length) {
        next.patch = input;
      }
    }
  }

  // Prune to schema keys for known Codex tools to reduce strict upstream validation failures.
  if (lowered === 'exec_command' || lowered === 'write_stdin' || lowered === 'apply_patch') {
    const pruned: Record<string, unknown> = {};
    for (const key of schema) {
      if (Object.prototype.hasOwnProperty.call(next, key)) {
        pruned[key] = next[key];
      }
    }
    return pruned;
  }

  return next;
}

export function mapChatRoleToGemini(role: string): string {
  const r = role.toLowerCase();
  if (r === 'assistant') return 'model';
  if (r === 'system') return 'system';
  if (r === 'tool') return 'tool';
  return 'user';
}

export function mapToolNameForGemini(nameRaw: string | undefined): string | undefined {
  const name = typeof nameRaw === 'string' ? nameRaw.trim() : '';
  if (!name) return undefined;
  if (name === 'web_search' || name.startsWith('web_search_')) {
    return 'websearch';
  }
  return name;
}

export function collectAssistantToolCallIds(messages: ChatMessage[]): Set<string> {
  const assistantToolCallIds = new Set<string>();
  for (const msg of messages) {
    if (!msg || typeof msg !== 'object') continue;
    if ((msg as JsonObject).role !== 'assistant') continue;
    const tcs = Array.isArray((msg as JsonObject).tool_calls)
      ? ((msg as JsonObject).tool_calls as ChatToolCall[])
      : [];
    for (const tc of tcs) {
      const id = typeof tc.id === 'string' ? tc.id.trim() : '';
      if (id) {
        assistantToolCallIds.add(id);
      }
    }
  }
  return assistantToolCallIds;
}

export function isResponsesOrigin(chat: ChatEnvelope): boolean {
  const semantics = chat?.semantics as Record<string, unknown> | undefined;
  if (semantics && semantics.responses && isJsonObject(semantics.responses as JsonValue)) {
    return true;
  }
  const ctx = chat?.metadata && typeof chat.metadata === 'object'
    ? ((chat.metadata as Record<string, unknown>).context as Record<string, unknown> | undefined)
    : undefined;
  const protocol = typeof ctx?.providerProtocol === 'string' ? ctx.providerProtocol.trim().toLowerCase() : '';
  if (protocol === 'openai-responses') {
    return true;
  }
  const endpoint = typeof ctx?.entryEndpoint === 'string' ? ctx.entryEndpoint.trim().toLowerCase() : '';
  return endpoint === '/v1/responses';
}


export function collectParameters(payload: GeminiPayload): JsonObject | undefined {
  const params: JsonObject = {};
  if (typeof payload.model === 'string') {
    params.model = payload.model;
  }
  const gen = payload.generationConfig;
  if (gen && typeof gen === 'object') {
    for (const { source, target } of GENERATION_CONFIG_KEYS) {
      const value = (gen as JsonObject)[source];
      if (value !== undefined) {
        params[target] = value as JsonValue;
      }
    }
  }
  if (payload.toolConfig !== undefined) {
    params.tool_config = jsonClone(payload.toolConfig as JsonValue);
  }
  const meta = payload.metadata;
  if (meta && typeof meta === 'object' && Object.prototype.hasOwnProperty.call(meta, '__rcc_stream')) {
    params.stream = Boolean((meta as JsonObject).__rcc_stream);
  }
  return Object.keys(params).length ? params : undefined;
}

export function appendChatContentToGeminiParts(
  message: ChatMessage,
  targetParts: JsonObject[],
  options?: { stripReasoningTags?: boolean }
): void {
  const content = message.content;
  if (typeof content === 'string') {
    const text = (options?.stripReasoningTags ? sanitizeReasoningTaggedText(content) : content).trim();
    if (text.length) {
      targetParts.push({ text });
    }
    return;
  }
  if (!Array.isArray(content)) {
    return;
  }

  const items = content as unknown[];
  for (const block of items) {
    if (block == null) continue;
    if (typeof block === 'string') {
      const text = (options?.stripReasoningTags ? sanitizeReasoningTaggedText(block) : block).trim();
      if (text.length) {
        targetParts.push({ text });
      }
      continue;
    }
    if (typeof block !== 'object') {
      const raw = String(block);
      const text = (options?.stripReasoningTags ? sanitizeReasoningTaggedText(raw) : raw).trim();
      if (text.length) {
        targetParts.push({ text });
      }
      continue;
    }

    const record = block as JsonObject;
    const rawType = record.type;
    const type = typeof rawType === 'string' ? rawType.toLowerCase() : '';

    if (!type || type === 'text') {
      const textValue =
        typeof record.text === 'string'
          ? record.text
          : typeof record.content === 'string'
            ? (record.content as string)
            : '';
      const text = (options?.stripReasoningTags ? sanitizeReasoningTaggedText(textValue) : textValue).trim();
      if (text.length) {
        targetParts.push({ text });
      }
      continue;
    }

    if (type === 'image' || type === 'image_url') {
      let url: string | undefined;
      const imageUrlRaw = record.image_url as JsonValue | undefined;
      if (typeof imageUrlRaw === 'string') {
        url = imageUrlRaw;
      } else if (imageUrlRaw && typeof imageUrlRaw === 'object' && typeof (imageUrlRaw as JsonObject).url === 'string') {
        url = (imageUrlRaw as JsonObject).url as string;
      } else if (typeof record.uri === 'string') {
        url = record.uri as string;
      } else if (typeof record.url === 'string') {
        url = record.url as string;
      } else if (typeof record.data === 'string') {
        url = record.data as string;
      }

      const trimmed = (url ?? '').trim();
      if (!trimmed.length) {
        targetParts.push({ text: '[image]' });
        continue;
      }

      let mimeType: string | undefined;
      let data: string | undefined;
      if (trimmed.startsWith('data:')) {
        const match = /^data:([^;,]+)?(?:;base64)?,(.*)$/s.exec(trimmed);
        if (match) {
          mimeType = (match[1] || '').trim() || undefined;
          data = match[2] || '';
        }
      }

      if (data && data.trim().length) {
        const inline: JsonObject = {
          inlineData: {
            data: data.trim()
          }
        };
        if (mimeType && mimeType.length) {
          (inline.inlineData as JsonObject).mimeType = mimeType;
        }
        targetParts.push(inline);
      } else {
        targetParts.push({ text: trimmed });
      }
      continue;
    }

    try {
      const jsonText = JSON.stringify(record);
      if (jsonText.trim().length) {
        targetParts.push({ text: jsonText });
      }
    } catch {
      // ignore malformed block
    }
  }
}
