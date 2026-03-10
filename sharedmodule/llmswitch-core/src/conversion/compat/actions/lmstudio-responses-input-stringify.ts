import type { JsonObject } from '../../hub/types/json.js';
import type { AdapterContext } from '../../hub/types/chat-envelope.js';

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function extractTextParts(content: unknown): string[] {
  const out: string[] = [];
  if (typeof content === 'string' && content.trim().length) {
    out.push(content.trim());
    return out;
  }
  if (!Array.isArray(content)) {
    return out;
  }
  for (const part of content) {
    if (!isRecord(part)) continue;
    const type = typeof part.type === 'string' ? String(part.type).trim().toLowerCase() : '';
    const text =
      typeof part.text === 'string'
        ? part.text
        : typeof (part as UnknownRecord).content === 'string'
          ? String((part as UnknownRecord).content)
          : undefined;
    if (typeof text === 'string' && text.trim().length) {
      out.push(text.trim());
      continue;
    }
    // OpenAI Responses content parts often use { type: 'input_text'|'output_text', text: '...' }.
    if ((type === 'input_text' || type === 'output_text') && typeof (part as UnknownRecord).text === 'string') {
      const t = String((part as UnknownRecord).text).trim();
      if (t.length) out.push(t);
    }
  }
  return out;
}

function stringifyInputItems(input: unknown): string | null {
  if (!Array.isArray(input)) return null;
  const chunks: string[] = [];
  for (const item of input) {
    if (!isRecord(item)) continue;
    const type = typeof item.type === 'string' ? String(item.type).trim().toLowerCase() : '';
    const roleCandidate = typeof item.role === 'string' ? String(item.role).trim() : '';
    const messageNode = isRecord((item as UnknownRecord).message) ? ((item as UnknownRecord).message as UnknownRecord) : undefined;
    const nestedRoleCandidate =
      messageNode && typeof messageNode.role === 'string' ? String(messageNode.role).trim() : '';
    // OpenAI Responses supports message-like items without an explicit `type` field:
    // { role: 'user'|'assistant'|'system', content: [...] }
    if (type === 'message' || (!type && (roleCandidate || nestedRoleCandidate))) {
      const role =
        roleCandidate ||
        nestedRoleCandidate ||
        'user';
      const contentNode = item.content !== undefined ? item.content : messageNode?.content;
      const parts = extractTextParts(contentNode);
      if (parts.length) {
        chunks.push(`${role}: ${parts.join('\n')}`);
      }
      continue;
    }
    if (type === 'function_call') {
      const name = typeof item.name === 'string' ? String(item.name).trim() : 'tool';
      const args =
        typeof item.arguments === 'string'
          ? String(item.arguments)
          : (() => {
              try {
                return JSON.stringify(item.arguments ?? null);
              } catch {
                return String(item.arguments ?? '');
              }
            })();
      chunks.push(`assistant tool_call ${name}: ${args}`);
      continue;
    }
    if (type === 'function_call_output') {
      const output =
        typeof item.output === 'string'
          ? String(item.output)
          : (() => {
              try {
                return JSON.stringify(item.output ?? null);
              } catch {
                return String(item.output ?? '');
              }
            })();
      chunks.push(`tool_output: ${output}`);
      continue;
    }
  }
  if (!chunks.length) return '';
  return chunks.join('\n\n');
}

/**
 * Legacy compatibility shim:
 * Some older LM Studio builds rejected the array form of `input` ("Invalid type for 'input'").
 * Convert canonical Responses input items into a single `input` string.
 *
 * ⚠️ Default is OFF (modern LM Studio accepts array input). Enable only if you hit that legacy error:
 * - `LLMSWITCH_LMSTUDIO_STRINGIFY_INPUT=1`
 * - or `ROUTECODEX_LMSTUDIO_STRINGIFY_INPUT=1`
 *
 * This is applied via compat profile `chat:lmstudio` and only when `providerProtocol === 'openai-responses'`.
 */
export function stringifyLmstudioResponsesInput(payload: JsonObject, adapterContext?: AdapterContext): JsonObject {
  const enabled =
    process.env.LLMSWITCH_LMSTUDIO_STRINGIFY_INPUT === '1' ||
    process.env.ROUTECODEX_LMSTUDIO_STRINGIFY_INPUT === '1';
  if (!enabled) {
    return payload;
  }
  if (!adapterContext || adapterContext.providerProtocol !== 'openai-responses') {
    return payload;
  }
  const record = payload as unknown as UnknownRecord;
  const input = record.input;
  if (!Array.isArray(input)) {
    return payload;
  }
  const flattened = stringifyInputItems(input);
  if (flattened === null) {
    return payload;
  }
  const instructions = typeof record.instructions === 'string' ? record.instructions.trim() : '';
  record.input = instructions.length ? `${instructions}\n\n${flattened}`.trim() : flattened;
  return payload;
}
