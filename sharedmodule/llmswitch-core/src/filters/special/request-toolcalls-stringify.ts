import type { Filter, FilterContext, FilterResult, JsonObject } from '../types.js';

/**
 * Ensure assistant.tool_calls[].function.arguments is a JSON string containing valid JSON.
 * - If arguments is not a string, JSON.stringify it.
 * - If arguments is a string but not parseable as JSON, wrap it into a JSON object so the
 *   provider always receives syntactically valid JSON (e.g. {"input": "<raw>"}).
 * Also set assistant.content=null when tool_calls exist (request-side invariant).
 */
export class RequestToolCallsStringifyFilter implements Filter<JsonObject> {
  readonly name = 'request_toolcalls_stringify';
  readonly stage: FilterContext['stage'] = 'request_post';

  apply(input: JsonObject): FilterResult<JsonObject> {
    try {
      const out = JSON.parse(JSON.stringify(input || {}));
      const msgs = Array.isArray((out as any).messages) ? (out as any).messages : [];
      for (const m of msgs) {
        if (!m || typeof m !== 'object') continue;
        if (m.role === 'assistant' && Array.isArray((m as any).tool_calls) && (m as any).tool_calls.length) {
          try {
            for (const tc of (m as any).tool_calls as any[]) {
              if (!tc || typeof tc !== 'object') continue;
              const fn = tc.function || {};
              if (!fn || typeof fn !== 'object') continue;
              const currentArgs = (fn as any).arguments;
              const fnName = typeof (fn as any).name === 'string' ? (fn as any).name.trim() : '';
              // Case 1: non-string arguments → stringify directly
              if (currentArgs !== undefined && typeof currentArgs !== 'string') {
                let argsJson = '{}';
                try {
                  argsJson = JSON.stringify(currentArgs ?? {});
                } catch {
                  argsJson = '{}';
                }
                (fn as any).arguments = argsJson;
                tc.function = fn;
                continue;
              }
              // Case 2: string arguments → ensure it is valid JSON
              if (typeof currentArgs === 'string') {
                const trimmed = currentArgs.trim();
                if (trimmed.length === 0) {
                  (fn as any).arguments = '{}';
                  tc.function = fn;
                  continue;
                }
                let parsedOk = false;
                let parsedValue: any = undefined;
                try {
                  parsedValue = JSON.parse(trimmed);
                  parsedOk = true;
                } catch {
                  parsedOk = false;
                }
                if (!parsedOk) {
                  // Wrap raw string into a JSON object to keep payload syntactically valid.
                  // For shell, align with GLM/统一工具治理约定，优先映射到 { command }，
                  // 其余模型仍使用 { input } 形式。
                  try {
                    if (fnName === 'shell') {
                      (fn as any).arguments = JSON.stringify({ command: currentArgs });
                    } else {
                      (fn as any).arguments = JSON.stringify({ input: currentArgs });
                    }
                  } catch {
                    (fn as any).arguments = '{}';
                  }
                  tc.function = fn;
                  continue;
                }
                // 合法 JSON 场景保持原样
                (fn as any).arguments = trimmed;
                tc.function = fn;
              }
            }
          } catch { /* ignore per-item errors */ }
          // Invariant: assistant with tool_calls should use content=null
          (m as any).content = null;
        }
      }
      (out as any).messages = msgs;
      return { ok: true, data: out };
    } catch {
      return { ok: true, data: input };
    }
  }
}
