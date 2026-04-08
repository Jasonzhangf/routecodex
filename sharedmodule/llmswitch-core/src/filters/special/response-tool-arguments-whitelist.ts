import type { Filter, FilterContext, FilterResult, JsonObject } from '../types.js';

function parseJson(str: string): any { try { return JSON.parse(str); } catch { return null; } }
function isObject(v: unknown): v is Record<string, unknown> { return !!v && typeof v === 'object' && !Array.isArray(v); }

function logResponseToolArgsWhitelistNonBlocking(
  stage: string,
  error: unknown,
  details: Record<string, unknown> = {}
): void {
  const reason = error instanceof Error ? (error.stack || `${error.name}: ${error.message}`) : String(error);
  const detailSuffix = Object.keys(details).length ? ` details=${JSON.stringify(details)}` : '';
  console.warn(`[response-tool-arguments-whitelist] ${stage} failed (non-blocking): ${reason}${detailSuffix}`);
}

/**
 * Whitelist tool function arguments keys after decode to match schema (e.g., keep only 'command'/'workdir').
 * Stage: response_pre. Runs after TOON decode and before stringify.
 */
export class ResponseToolArgumentsWhitelistFilter implements Filter<JsonObject> {
  readonly name = 'response_tool_arguments_whitelist';
  readonly stage: FilterContext['stage'] = 'response_pre';

  private getWhitelist(_ctx?: FilterContext): string[] {
    // For now, keep minimal keys for shell schema. Can be extended/configured later.
    const env = String((process as any)?.env?.ROUTECODEX_SHELL_ARGS_KEYS || '').trim();
    if (env) return env.split(',').map(s => s.trim()).filter(Boolean);
    return ['command', 'workdir'];
  }

  apply(input: JsonObject, context?: FilterContext): FilterResult<JsonObject> {
    try {
      const out = JSON.parse(JSON.stringify(input || {}));
      const choices = Array.isArray((out as any).choices) ? (out as any).choices : [];
      const keys = this.getWhitelist(context);
      for (const ch of choices) {
        const msg = ch && (ch as any).message ? (ch as any).message : undefined;
        const tcs = msg && Array.isArray((msg as any).tool_calls) ? ((msg as any).tool_calls as any[]) : [];
        for (const tc of tcs) {
          const fn = tc && (tc as any).function ? ((tc as any).function as any) : undefined;
          const argStr = fn && typeof fn.arguments === 'string' ? (fn.arguments as string) : undefined;
          if (!argStr) continue;
          const parsed = parseJson(argStr);
          if (!isObject(parsed)) continue;
          const whitelisted: Record<string, unknown> = {};
          for (const k of keys) {
            if (k in parsed) whitelisted[k] = (parsed as any)[k];
          }
          try {
            (fn as any).arguments = JSON.stringify(whitelisted);
          } catch (error) {
            logResponseToolArgsWhitelistNonBlocking('stringify_whitelisted_arguments', error, {
              toolName: typeof (fn as any)?.name === 'string' ? String((fn as any).name) : ''
            });
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
