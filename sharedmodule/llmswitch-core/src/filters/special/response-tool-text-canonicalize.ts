import type { Filter, FilterContext, FilterResult, JsonObject } from '../types.js';
import { normalizeChatResponseReasoningToolsWithNative } from '../../router/virtual-router/engine-selection/native-hub-bridge-action-semantics.js';

/**
 * Canonicalize structured tool_calls (Chat path).
 *
 * 注意：该 filter 不会将纯文本中的“工具标记”提升为 tool_calls。
 * 在 processMode=chat 的严格路径下，工具调用应以结构化 tool_calls 形态出现；
 * 若上游以文本形式输出工具调用，应作为问题暴露给上层（而不是在此处兜底转换）。
 */
export class ResponseToolTextCanonicalizeFilter implements Filter<JsonObject> {
  readonly name = 'response_tool_text_canonicalize';
  readonly stage: FilterContext['stage'] = 'response_pre';

  apply(input: JsonObject): FilterResult<JsonObject> {
    const out = normalizeChatResponseReasoningToolsWithNative(input as any);
    return { ok: true, data: out as JsonObject };
  }
}
