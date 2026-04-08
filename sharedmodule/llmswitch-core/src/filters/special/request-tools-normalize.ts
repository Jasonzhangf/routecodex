import type { Filter, FilterContext, FilterResult, JsonObject } from '../types.js';
import {
  appendApplyPatchReminder,
  buildShellDescription,
  hasApplyPatchToolDeclared,
  isShellToolName,
  normalizeToolName
} from '../../tools/tool-description-utils.js';

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

function logRequestToolsNormalizeNonBlocking(
  stage: string,
  error: unknown,
  details: Record<string, unknown> = {}
): void {
  try {
    const detailSuffix = Object.keys(details).length > 0 ? ` details=${JSON.stringify(details)}` : '';
    console.warn(`[request-tools-normalize] ${stage} failed (non-blocking): ${formatUnknownError(error)}${detailSuffix}`);
  } catch {
    // Never throw from non-blocking logging.
  }
}

/**
 * Normalize OpenAI tools definitions at the final request stage.
 * - Enforces { command: string | string[], workdir?: string } shape for shell-like tools.
 * - Best-effort; never throws.
 */
export class RequestOpenAIToolsNormalizeFilter implements Filter<JsonObject> {
  readonly name = 'request_openai_tools_normalize';
  readonly stage: FilterContext['stage'] = 'request_finalize';

  async apply(input: JsonObject): Promise<FilterResult<JsonObject>> {
    try {
      const out: JsonObject = JSON.parse(JSON.stringify(input || {}));
      const tools = Array.isArray((out as any).tools) ? ((out as any).tools as any[]) : [];
      const hasApplyPatchTool = hasApplyPatchToolDeclared(tools);
      if (!tools.length) {
        // No tools present: drop tool_choice to avoid provider-side validation errors
        try {
          if ('tool_choice' in (out as any)) delete (out as any).tool_choice;
        } catch (error) {
          logRequestToolsNormalizeNonBlocking('drop_tool_choice_when_empty', error);
        }
        return { ok: true, data: out };
      }

      let normalizedList: any[] = [];
      try {
        const mod = await import('../../conversion/args-mapping.js');
        const normalizeTools = (mod as any)?.normalizeTools as ((t: any[]) => any[]);
        if (typeof normalizeTools === 'function') normalizedList = normalizeTools(tools);
      } catch (error) {
        logRequestToolsNormalizeNonBlocking('load_args_mapping.normalize_tools', error);
      }

      const finalTools: any[] = [];
      const max = Math.max(tools.length, normalizedList.length);
      for (let i = 0; i < max; i++) {
        const src = tools[i];
        const dst = normalizedList[i];
        if (dst && isObject(dst) && isObject((dst as any).function) && typeof (dst as any).function.name === 'string') {
          const fn = (dst as any).function as Record<string, unknown>;
          // Ensure type and minimal function shape
          if (typeof (dst as any).type !== 'string' || !String((dst as any).type).trim()) {
            (dst as any).type = 'function';
          }
          // Ensure parameters object shape exists
          if (!isObject(fn.parameters)) {
            (dst as any).function = { ...fn, parameters: { type: 'object', properties: {}, additionalProperties: true } };
          }
          // Ensure description string exists
          if (typeof fn.description !== 'string') {
            (dst as any).function = { ...((dst as any).function as any), description: '' };
          }
          // Drop non-standard strict flag to pass strict providers that reject unknown tool fields
          try {
            if ('strict' in (dst as any).function) delete (dst as any).function.strict;
          } catch (error) {
            logRequestToolsNormalizeNonBlocking('drop_strict_flag.normalized_tool', error, {
              toolName: String(((dst as any).function as any)?.name ?? '')
            });
          }
          // Switch schema for specific built-in tools at unified shaping point
          try {
            const rawToolName = String(((dst as any).function as any).name || '');
            const isShell = isShellToolName(rawToolName);
            if (isShell) {
              (dst as any).function.name = 'exec_command';
              (dst as any).function.parameters = {
                type: 'object',
                properties: {
                  cmd: { type: 'string' },
                  workdir: { type: 'string' }
                },
                required: ['cmd'],
                additionalProperties: false
              };
              const label = rawToolName && rawToolName.trim().length > 0 ? rawToolName.trim() : 'exec_command';
              (dst as any).function.description = buildShellDescription(label, hasApplyPatchTool);
            }
          } catch (error) {
            logRequestToolsNormalizeNonBlocking('shell_schema_rewrite', error, {
              toolName: String(((dst as any).function as any)?.name ?? '')
            });
          }
          finalTools.push(dst);
        } else if (src && isObject(src)) {
          // Fallback: minimally enforce required fields on raw src entries
          const item: any = JSON.parse(JSON.stringify(src));
          if (typeof item.type !== 'string' || !String(item.type).trim()) item.type = 'function';
          if (!isObject(item.function)) item.function = {};
          if (typeof item.function.name !== 'string') item.function.name = String(item.name || 'tool');
          if (!isObject(item.function.parameters)) item.function.parameters = { type: 'object', properties: {}, additionalProperties: true };
          try {
            if ('strict' in item.function) delete item.function.strict;
          } catch (error) {
            logRequestToolsNormalizeNonBlocking('drop_strict_flag.raw_tool', error, {
              toolName: String(item.function?.name ?? '')
            });
          }
          finalTools.push(item);
        }
      }

      (out as any).tools = finalTools;
      // If tools ended up empty, drop tool_choice to avoid upstream validation issues
      try {
        if (Array.isArray((out as any).tools) && (out as any).tools.length === 0 && 'tool_choice' in (out as any)) {
          delete (out as any).tool_choice;
        }
      } catch (error) {
        logRequestToolsNormalizeNonBlocking('drop_tool_choice_after_normalize', error);
      }
      return { ok: true, data: out };
    } catch {
      return { ok: true, data: input };
    }
  }
}
