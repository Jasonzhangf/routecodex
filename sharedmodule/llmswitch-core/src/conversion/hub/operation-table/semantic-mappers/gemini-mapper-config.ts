import type { ChatEnvelope } from '../../types/chat-envelope.js';
import { appendDroppedFieldAudit } from './gemini-mapping-audit.js';

export const GEMINI_PASSTHROUGH_METADATA_PREFIX = 'rcc_passthrough_';
export const GEMINI_PASSTHROUGH_PARAMETERS: readonly string[] = ['tool_choice'];

const RESPONSES_DROPPED_PARAMETER_KEYS: readonly string[] = [
  'prompt_cache_key',
  'response_format',
  'parallel_tool_calls',
  'service_tier',
  'truncation',
  'include',
  'store'
];

export function recordGeminiResponsesDroppedParameters(
  chat: ChatEnvelope,
  parameters: Record<string, unknown>,
  responsesOrigin: boolean,
): void {
  if (!responsesOrigin) {
    return;
  }
  for (const field of RESPONSES_DROPPED_PARAMETER_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(parameters, field)) {
      continue;
    }
    appendDroppedFieldAudit(chat, {
      field,
      targetProtocol: 'gemini-chat',
      reason: 'unsupported_semantics_no_equivalent',
    });
  }
}
