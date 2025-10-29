import { augmentOpenAITools, refineSystemToolGuidance } from '../../guidance/index.js';
import { normalizeAssistantTextToToolCalls } from './text-markup-normalizer.js';

type Unknown = Record<string, unknown>;

function isObject(v: unknown): v is Unknown {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

export interface OpenAIChatPayload {
  model?: string;
  messages?: Array<Record<string, unknown>>;
  tools?: Array<Record<string, unknown>>;
  tool_choice?: unknown;
  parallel_tool_calls?: unknown;
  [k: string]: unknown;
}

export function applyOpenAIToolingStage(payload: OpenAIChatPayload): OpenAIChatPayload {
  if (!payload || typeof payload !== 'object') return payload;
  const out: OpenAIChatPayload = { ...(payload as any) };

  // 1) Refine system guidance when enabled
  try {
    const on = String((process as any)?.env?.RCC_SYSTEM_TOOL_GUIDANCE ?? '1').trim() !== '0';
    if (on && Array.isArray(out.messages) && out.messages.length) {
      const first = out.messages[0];
      if (first && (first as any).role === 'system' && typeof (first as any).content === 'string') {
        const refined = refineSystemToolGuidance(String((first as any).content));
        if (refined !== (first as any).content) {
          out.messages = [{ ...(first as any), content: refined }, ...out.messages.slice(1)];
        }
      }
    }
  } catch { /* ignore */ }

  // 2) Augment tool definitions into strict, guided OpenAI function tools
  try {
    if (Array.isArray(out.tools) && out.tools.length) {
      out.tools = augmentOpenAITools(out.tools) as any[];
    }
  } catch { /* ignore */ }

  // 3) Normalize textual assistant content to tool_calls (gated)
  try {
    if (Array.isArray(out.messages) && out.messages.length) {
      const last = out.messages[out.messages.length - 1];
      if (isObject(last) && String((last as any).role || '').toLowerCase() === 'assistant') {
        const normalized = normalizeAssistantTextToToolCalls(last as any);
        if (normalized !== last) {
          out.messages = [...out.messages.slice(0, -1), normalized];
        }
      }
    }
  } catch { /* ignore */ }

  return out;
}
