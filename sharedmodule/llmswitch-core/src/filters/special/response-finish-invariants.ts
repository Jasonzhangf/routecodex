import type { Filter, FilterContext, FilterResult, JsonObject } from '../types.js';

/**
 * Ensure finish_reason and content invariants on response side:
 * - If tool_calls present, finish_reason defaults to 'tool_calls'
 * - If tool_calls present, message.content=null (Chat path)
 */
export class ResponseFinishInvariantsFilter implements Filter<JsonObject> {
  readonly name = 'response_finish_invariants';
  readonly stage: FilterContext['stage'] = 'response_post';

  apply(input: JsonObject): FilterResult<JsonObject> {
    try {
      const out = JSON.parse(JSON.stringify(input || {}));
      const choices = Array.isArray((out as any).choices) ? (out as any).choices : [];
      for (const ch of choices) {
        const msg = ch && (ch as any).message ? (ch as any).message : undefined;
        const tcs = msg && Array.isArray(msg.tool_calls) ? (msg.tool_calls as any[]) : [];
        if (tcs.length > 0) {
          if ((ch as any).finish_reason == null) (ch as any).finish_reason = 'tool_calls';
          if (msg && typeof msg === 'object') (msg as any).content = null;
        }
      }
      (out as any).choices = choices;
      return { ok: true, data: out };
    } catch {
      return { ok: true, data: input };
    }
  }
}

