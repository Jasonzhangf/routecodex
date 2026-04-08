import type { Filter, FilterContext, FilterResult, JsonObject } from '../types.js';

function isObject(v: unknown): v is Record<string, unknown> { return !!v && typeof v === 'object' && !Array.isArray(v); }
function parseJson(str: string): any { try { return JSON.parse(str); } catch { return null; } }

function logResponseToolArgsBlacklistNonBlocking(
  stage: string,
  error: unknown,
  details: Record<string, unknown> = {}
): void {
  const reason = error instanceof Error ? (error.stack || `${error.name}: ${error.message}`) : String(error);
  const detailSuffix = Object.keys(details).length ? ` details=${JSON.stringify(details)}` : '';
  console.warn(`[response-tool-arguments-blacklist] ${stage} failed (non-blocking): ${reason}${detailSuffix}`);
}

function getBlacklist(): string[] {
  const env = String((process as any)?.env?.ROUTECODEX_TOOLARGS_BLACKLIST || '').trim();
  if (!env) return [];
  return env.split(',').map(s => s.trim()).filter(Boolean);
}

/**
 * ResponseToolArgumentsBlacklistFilter
 * - Remove keys listed in ROUTECODEX_TOOLARGS_BLACKLIST from tool_calls[].function.arguments (after decode).
 * - Default: empty blacklist (no-op). Enables incremental hardening without risking valid params.
 * Stage: response_pre
 */
export class ResponseToolArgumentsBlacklistFilter implements Filter<JsonObject> {
  readonly name = 'response_tool_arguments_blacklist';
  readonly stage: FilterContext['stage'] = 'response_pre';

  apply(input: JsonObject): FilterResult<JsonObject> {
    const blacklist = getBlacklist();
    if (blacklist.length === 0) return { ok: true, data: input };
    try {
      const out = JSON.parse(JSON.stringify(input || {}));
      const choices: any[] = Array.isArray((out as any).choices) ? (out as any).choices : [];
      for (const ch of choices) {
        const msg = ch && (ch as any).message ? (ch as any).message : undefined;
        const tcs: any[] = msg && Array.isArray((msg as any).tool_calls) ? ((msg as any).tool_calls as any[]) : [];
        for (const tc of tcs) {
          const fn = tc && (tc as any).function ? ((tc as any).function as any) : undefined;
          const argStr = fn && typeof fn.arguments === 'string' ? (fn.arguments as string) : undefined;
          if (!argStr) continue;
          const parsed = parseJson(argStr);
          if (!isObject(parsed)) continue;
          let changed = false;
          for (const k of blacklist) {
            if (k in parsed) { delete (parsed as any)[k]; changed = true; }
          }
          if (changed) {
            try {
              (fn as any).arguments = JSON.stringify(parsed);
            } catch (error) {
              logResponseToolArgsBlacklistNonBlocking('stringify_blacklisted_arguments', error, {
                removedKeys: blacklist
              });
            }
          }
        }
      }
      (out as any).choices = choices;
      return { ok: true, data: out };
    } catch {
      return { ok: true, data: input };
    }
  }
}
