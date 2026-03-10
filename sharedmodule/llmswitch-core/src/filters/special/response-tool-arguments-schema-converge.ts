import type { Filter, FilterContext, FilterResult, JsonObject } from '../types.js';

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function parseJson(str: string): any {
  try { return JSON.parse(str); } catch { return null; }
}

/**
 * ResponseToolArgumentsSchemaConvergeFilter
 * - If tool schemas are available on context (context.toolSchemas[name] = JSONSchema),
 *   keep only keys defined in schema.properties for each tool call arguments.
 * - Does not validate or coerce types; only converges keys to schema surface.
 * - Stage: response_pre
 */
export class ResponseToolArgumentsSchemaConvergeFilter implements Filter<JsonObject> {
  readonly name = 'response_tool_arguments_schema_converge';
  readonly stage: FilterContext['stage'] = 'response_pre';

  apply(input: JsonObject, context?: FilterContext): FilterResult<JsonObject> {
    try {
      const schemaMap = (context as any)?.toolSchemas as Record<string, any> | undefined;
      if (!schemaMap || typeof schemaMap !== 'object') return { ok: true, data: input };

      const out = JSON.parse(JSON.stringify(input || {}));
      const choices: any[] = Array.isArray((out as any).choices) ? (out as any).choices : [];

      for (const ch of choices) {
        const msg = ch && (ch as any).message ? (ch as any).message : undefined;
        const tcs: any[] = msg && Array.isArray((msg as any).tool_calls) ? ((msg as any).tool_calls as any[]) : [];
        for (const tc of tcs) {
          const fn = tc && (tc as any).function ? ((tc as any).function as any) : undefined;
          const name = fn && typeof fn.name === 'string' ? String(fn.name) : '';
          if (!name) continue;
          const schema = (schemaMap as any)[name];
          const props = schema && schema.properties && isObject(schema.properties) ? (schema.properties as Record<string, unknown>) : undefined;
          if (!props || !isObject(fn)) continue;
          const argStr = typeof fn.arguments === 'string' ? (fn.arguments as string) : undefined;
          const parsed = argStr ? parseJson(argStr) : (isObject((fn as any).arguments) ? (fn as any).arguments : null);
          if (!isObject(parsed)) continue;
          const whitelisted: Record<string, unknown> = {};
          for (const k of Object.keys(props)) {
            if (k in parsed) whitelisted[k] = (parsed as any)[k];
          }
          try { (fn as any).arguments = JSON.stringify(whitelisted); } catch { /* keep original */ }
        }
      }
      (out as any).choices = choices;
      return { ok: true, data: out };
    } catch {
      return { ok: true, data: input };
    }
  }
}

