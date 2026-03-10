import type { Filter, FilterContext, FilterResult, JsonObject } from '../types.js';

/**
 * Tool choice policy:
 * - If tools exist and no tool_choice, set tool_choice='auto'
 * - If no tools, remove tool_choice
 */
export class RequestToolChoicePolicyFilter implements Filter<JsonObject> {
  readonly name = 'request_tool_choice_policy';
  readonly stage: FilterContext['stage'] = 'request_post';

  apply(input: JsonObject): FilterResult<JsonObject> {
    try {
      const out = JSON.parse(JSON.stringify(input || {}));
      const tools = Array.isArray((out as any).tools) ? ((out as any).tools as any[]) : [];
      if (tools.length > 0) {
        const hasOwn = Object.prototype.hasOwnProperty.call(out as any, 'tool_choice');
        if (!hasOwn || (out as any).tool_choice === undefined) {
          (out as any).tool_choice = 'auto';
        }
      } else {
        if (Object.prototype.hasOwnProperty.call(out as any, 'tool_choice')) delete (out as any).tool_choice;
      }
      return { ok: true, data: out };
    } catch {
      return { ok: true, data: input };
    }
  }
}
