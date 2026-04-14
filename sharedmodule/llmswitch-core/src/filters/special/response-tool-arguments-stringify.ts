import type { Filter, FilterContext, FilterResult, JsonObject } from '../types.js';
import { repairFindMeta } from '../../conversion/shared/tooling.js';

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function formatUnknownError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack || `${error.name}: ${error.message}`;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function logResponseToolArgsStringifyNonBlocking(
  stage: string,
  error: unknown,
  details: Record<string, unknown> = {}
): void {
  try {
    const detailSuffix = Object.keys(details).length > 0 ? ` details=${JSON.stringify(details)}` : '';
    console.warn(`[response-tool-arguments-stringify] ${stage} failed (non-blocking): ${formatUnknownError(error)}${detailSuffix}`);
  } catch {
    // Never throw from non-blocking logging.
  }
}

function packShellCommand(cmd: unknown): string[] | unknown {
  // Normalize into ["bash","-lc","<single string>"] to support pipes, parens, -exec, etc.
  const normalizeArray = (argv: string[]): string[] => {
    if (argv.length >= 2 && argv[0].toLowerCase() === 'bash' && argv[1] === '-lc') {
      if (argv.length === 3) return ['bash', '-lc', repairFindMeta(String(argv[2]))];
      const tail = argv.slice(2).join(' ');
      return ['bash', '-lc', repairFindMeta(tail)];
    }
    const joined = argv.join(' ');
    return ['bash', '-lc', repairFindMeta(joined)];
  };

  try {
    if (Array.isArray(cmd)) {
      return normalizeArray(cmd.map((x) => String(x)));
    }
    if (typeof cmd === 'string') {
      // If the string looks like a JSON array, attempt to parse before normalizing.
      const trimmed = cmd.trim();
      if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
        try {
          const parsed = JSON.parse(trimmed);
          if (Array.isArray(parsed)) {
            return normalizeArray(parsed.map((x) => String(x)));
          }
        } catch {
          // fall back to treating as plain string
        }
      }
      return ['bash', '-lc', repairFindMeta(cmd)];
    }
  } catch {
    // fall through
  }
  return cmd;
}

/**
 * Ensure choices[*].message.tool_calls[].function.arguments is a JSON string.
 */
export class ResponseToolArgumentsStringifyFilter implements Filter<JsonObject> {
  readonly name = 'response_tool_arguments_stringify';
  readonly stage: FilterContext['stage'] = 'response_post';

  apply(input: JsonObject): FilterResult<JsonObject> {
    try {
      const out = JSON.parse(JSON.stringify(input || {}));
      const choices = Array.isArray((out as any).choices) ? (out as any).choices : [];
      for (const ch of choices) {
        const msg = ch && (ch as any).message ? (ch as any).message : undefined;
        const tcs = msg && Array.isArray(msg.tool_calls) ? (msg.tool_calls as any[]) : [];
        for (const tc of tcs) {
          try {
            const fn = tc && tc.function ? tc.function : undefined;
            if (fn && typeof fn === 'object') {
              const name = typeof (fn as any).name === 'string' ? String((fn as any).name).trim().toLowerCase() : '';
              const argIn = (fn as any).arguments;
              let parsed: any = undefined;
              if (typeof argIn === 'string') { try { parsed = JSON.parse(argIn); } catch { parsed = undefined; } }
              else if (isObject(argIn)) { parsed = argIn; }

              if (name === 'shell' && isObject(parsed)) {
                const cmd = (parsed as any).command;
                (parsed as any).command = packShellCommand(cmd);
                try { (fn as any).arguments = JSON.stringify(parsed ?? {}); } catch { (fn as any).arguments = '{}'; }
              } else if (name === 'exec_command' && isObject(parsed)) {
                // Response-side contract:
                // preserve the upstream/client-visible argument shape losslessly.
                // Do not alias-repair `command -> cmd` here; host validation must
                // see the original shape and raise CLIENT_TOOL_ARGS_INVALID.
                try { (fn as any).arguments = JSON.stringify(parsed ?? {}); } catch { (fn as any).arguments = '{}'; }
              } else if ((name === 'shell_command' || name === 'bash') && isObject(parsed)) {
                try { (fn as any).arguments = JSON.stringify(parsed ?? {}); } catch { (fn as any).arguments = '{}'; }
              } else {
                if (typeof argIn !== 'string') {
                  try { (fn as any).arguments = JSON.stringify(argIn ?? {}); } catch { (fn as any).arguments = '{}'; }
                }
              }
              // Ensure invariants per tool_call
              if (!tc.id || typeof tc.id !== 'string') {
                const basis = `${name || 'tool'}_${Math.random().toString(36).slice(2, 10)}`;
                tc.id = `call_${basis}`;
              }
              if (!tc.type) tc.type = 'function';
            }
          } catch (error) {
            logResponseToolArgsStringifyNonBlocking('normalize_single_tool_call', error, {
              toolCallId: typeof (tc as any)?.id === 'string' ? (tc as any).id : undefined
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
