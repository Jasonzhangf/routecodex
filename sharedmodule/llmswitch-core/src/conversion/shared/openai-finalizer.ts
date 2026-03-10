// OpenAI Chat finalizer: enforce canonical shapes without the legacy hook system.
// - Ensures tool_calls use stringified JSON arguments and sets finish_reason='tool_calls' when applicable
// - Normalizes potential tool messages (role:'tool') content to strict strings (JSON-stringify for objects)
import { finalizeRespProcessChatResponseWithNative } from '../../router/virtual-router/engine-selection/native-chat-process-governance-semantics.js';

type Unknown = Record<string, unknown>;
export type ChatReasoningMode = 'keep' | 'drop' | 'append_to_content';

export interface FinalizeOptions {
  requestId?: string;
  endpoint?: string; // e.g., '/v1/chat/completions' | '/v1/responses' | '/v1/messages'
  stream?: boolean;
  reasoningMode?: ChatReasoningMode;
}

function asObject(v: unknown): Unknown | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Unknown) : null;
}

// Canonicalization handled by native finalizeChatResponseJson.

export async function finalizeOpenAIChatResponse(
  chatLike: unknown,
  opts?: FinalizeOptions
): Promise<unknown> {
  const obj = asObject(chatLike);
  if (!obj) return chatLike;

  const finalized = await finalizeRespProcessChatResponseWithNative({
    payload: obj,
    stream: opts?.stream === true,
    reasoningMode: opts?.reasoningMode,
    endpoint: opts?.endpoint,
    requestId: opts?.requestId
  });
  return finalized as unknown;
}

// All canonicalization + reasoning policy handled by native finalizeChatResponseJson.
