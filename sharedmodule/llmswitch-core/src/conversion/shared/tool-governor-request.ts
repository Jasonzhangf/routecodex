import { augmentOpenAITools } from '../../guidance/index.js';
import { validateToolCall } from '../../tools/tool-registry.js';
import { captureApplyPatchRegression } from '../../tools/patch-regression-capturer.js';
import { normalizeExecCommandArgs } from '../../tools/exec-command/normalize.js';
import {
  buildBlockedApplyPatchArgs,
  buildBlockedExecCommandArgs,
  injectNestedApplyPatchPolicyNotice,
  repairCommandNameAsExecToolCall,
  resolveExecCommandGuardValidationOptions,
  rewriteExecCommandApplyPatchCall
} from './tool-governor-guards.js';
import {
  parseLenientJsonishWithNative as parseLenient,
  repairArgumentsToStringWithNative as repairArgumentsToString
} from '../../router/virtual-router/engine-selection/native-shared-conversion-semantics.js';
import { isObject } from '../../shared/common-utils.js';
import {
  logToolGovernorNonBlocking,
  type ToolGovernanceOptions,
  type Unknown
} from './tool-governor-shared.js';

export function processChatRequestTools(request: Unknown, opts?: ToolGovernanceOptions): Unknown {
  const options: ToolGovernanceOptions = { ...(opts || {}) };
  void options;
  if (!isObject(request)) return request;
  const out: Unknown = JSON.parse(JSON.stringify(request));

  try {
    const tools = Array.isArray((out as any)?.tools) ? ((out as any).tools as any[]) : [];
    if (tools.length > 0) {
      for (const tool of tools) {
        if (!tool || typeof tool !== 'object') continue;
        const fn = (tool as any).function;
        if (!fn || typeof fn !== 'object') continue;
        const typeStr = String((tool as any).type || '').toLowerCase();
        const nameStr = typeof (fn as any).name === 'string' ? String((fn as any).name).toLowerCase() : '';
        const shouldPatch = typeStr === 'function' || nameStr === 'apply_patch';
        if (!shouldPatch) continue;
        if (!Object.prototype.hasOwnProperty.call(fn, 'parameters')) {
          (tool as any).function = { ...(fn as any), parameters: {} };
        }
      }
      (out as any).tools = augmentOpenAITools(tools);
    }
  } catch (error) {
    logToolGovernorNonBlocking('request_minimal_tool_shape_repair', error);
  }

  try {
    const canonical = out as any;
    try {
      const modelId = typeof canonical?.model === 'string' ? String(canonical.model) : 'unknown';
      const raw = String((process as any)?.env?.RCC_TOOL_CHOICE_REQUIRED || '').trim();
      const wanted = raw ? raw.split(',').map((value: string) => value.trim()).filter(Boolean) : [];
      if (Array.isArray(canonical?.tools) && (canonical.tools as any[]).length > 0) {
        if (!canonical.tool_choice) canonical.tool_choice = 'auto';
        if (wanted.length > 0 && wanted.some((pattern: string) => modelId.includes(pattern))) {
          canonical.tool_choice = 'required';
        }
      }
    } catch (error) {
      logToolGovernorNonBlocking('request_tool_choice_policy', error);
    }
    return normalizeSpecialToolCallsOnRequest(canonical);
  } catch (error) {
    logToolGovernorNonBlocking('process_chat_request_tools', error);
    return out;
  }
}

export function normalizeApplyPatchToolCallsOnRequest(request: Unknown): Unknown {
  return normalizeSpecialToolCallsOnRequest(request);
}

function normalizeSpecialToolCallsOnRequest(request: Unknown): Unknown {
  try {
    const out = JSON.parse(JSON.stringify(request)) as Unknown;
    const validationOptions = resolveExecCommandGuardValidationOptions(out);
    const messages = Array.isArray((out as any)?.messages) ? ((out as any).messages as any[]) : [];
    let lastAssistantIndex = -1;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const candidate = messages[index];
      if (!candidate || typeof candidate !== 'object') continue;
      if ((candidate as any).role === 'assistant') {
        lastAssistantIndex = index;
        break;
      }
    }
    if (lastAssistantIndex === -1) {
      return out;
    }
    let rewrittenNestedApplyPatchCount = 0;
    for (let index = 0; index < messages.length; index += 1) {
      const message = messages[index];
      if (!message || typeof message !== 'object' || index !== lastAssistantIndex) continue;
      const toolCalls = Array.isArray((message as any).tool_calls) ? ((message as any).tool_calls as any[]) : [];
      if (!toolCalls.length) continue;
      for (const toolCall of toolCalls) {
        try {
          const fn = toolCall && toolCall.function ? toolCall.function : undefined;
          repairCommandNameAsExecToolCall(fn as Record<string, unknown> | undefined, validationOptions);
          if (rewriteExecCommandApplyPatchCall(fn as Record<string, unknown> | undefined)) {
            rewrittenNestedApplyPatchCount += 1;
          }
          const name = typeof fn?.name === 'string' ? String(fn.name).trim().toLowerCase() : '';
          const rawArgs = (fn as any)?.arguments;

          if (name === 'apply_patch') {
            const argsStr = repairArgumentsToString(rawArgs);
            const validation = validateToolCall('apply_patch', argsStr);
            if (validation?.ok && typeof validation.normalizedArgs === 'string') {
              (fn as any).arguments = validation.normalizedArgs;
            } else if (validation && !validation.ok) {
              (fn as any).arguments = buildBlockedApplyPatchArgs(rawArgs, validation.reason, validation.message);
              captureApplyPatchFailure('request', rawArgs, argsStr, validation.reason);
            }
            continue;
          }

          if (name === 'exec_command') {
            const argsStr = repairArgumentsToString(rawArgs);
            const validation = validateToolCall('exec_command', argsStr, validationOptions);
            if (validation?.ok && typeof validation.normalizedArgs === 'string') {
              (fn as any).arguments = validation.normalizedArgs;
            } else if (validation && !validation.ok) {
              (fn as any).arguments = buildBlockedExecCommandArgs(rawArgs, validation.reason, validation.message);
            } else {
              let parsed: any;
              try {
                parsed = JSON.parse(argsStr);
              } catch (error) {
                logToolGovernorNonBlocking('request_exec_command_parse_json', error);
                parsed = parseLenient(argsStr);
              }
              if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                const normalized = normalizeExecCommandArgs(parsed as Record<string, unknown>);
                try {
                  (fn as any).arguments = JSON.stringify(normalized.ok ? normalized.normalized : parsed);
                } catch (error) {
                  logToolGovernorNonBlocking('request_exec_command_json_stringify', error);
                  (fn as any).arguments = '{}';
                }
              }
            }
          }
        } catch (error) {
          logToolGovernorNonBlocking('request_tool_call_normalize_item', error);
        }
      }
    }
    if (rewrittenNestedApplyPatchCount > 0) {
      injectNestedApplyPatchPolicyNotice(messages, rewrittenNestedApplyPatchCount);
    }
    return out;
  } catch (error) {
    logToolGovernorNonBlocking('normalize_special_tool_calls_on_request', error);
    return request;
  }
}

function captureApplyPatchFailure(
  source: 'request' | 'response',
  rawArgs: unknown,
  argsStr: string,
  reason?: string
): void {
  try {
    const finalReason = reason ?? 'unknown';
    captureApplyPatchRegression({
      errorType: finalReason,
      originalArgs: rawArgs,
      normalizedArgs: argsStr,
      validationError: finalReason,
      source: `tool-governor.${source}`,
      meta: { applyPatchToolMode: 'freeform' }
    });
    const snippet =
      typeof argsStr === 'string' && argsStr.trim().length
        ? argsStr.trim().slice(0, 200).replace(/\s+/g, ' ')
        : '';
    // eslint-disable-next-line no-console
    console.error(
      `\x1b[31m[apply_patch][precheck][${source}] validation_failed reason=${finalReason}${
        snippet ? ` args=${snippet}` : ''
      }\x1b[0m`
    );
  } catch (error) {
    logToolGovernorNonBlocking(`${source}_apply_patch_regression_capture`, error);
  }
}
