import { validateToolCall } from '../../tools/tool-registry.js';
import { repairFindMeta } from './tooling.js';
import { captureApplyPatchRegression } from '../../tools/patch-regression-capturer.js';
import { normalizeExecCommandArgs } from '../../tools/exec-command/normalize.js';
import {
  repairCommandNameAsExecToolCall,
  resolveExecCommandGuardValidationOptions,
  rewriteExecCommandApplyPatchCall
} from './tool-governor-guards.js';
import {
  applyRespProcessToolGovernanceWithNative,
  prepareRespProcessToolGovernancePayloadWithNative
} from '../../router/virtual-router/engine-selection/native-chat-process-governance-semantics.js';
import {
  parseLenientJsonishWithNative as parseLenient,
  repairArgumentsToStringWithNative as repairArgumentsToString
} from '../../router/virtual-router/engine-selection/native-shared-conversion-semantics.js';
import { isObject } from '../../shared/common-utils.js';
import { logToolGovernorNonBlocking, type Unknown } from './tool-governor-shared.js';

export function normalizeApplyPatchToolCallsOnResponse(chat: Unknown): Unknown {
  try {
    const out = JSON.parse(JSON.stringify(chat)) as Unknown;
    const validationOptions = resolveExecCommandGuardValidationOptions(out);
    const choices = Array.isArray((out as any)?.choices) ? ((out as any).choices as any[]) : [];
    for (const choice of choices) {
      const message = choice && choice.message ? choice.message : undefined;
      const toolCalls = Array.isArray(message?.tool_calls) ? (message.tool_calls as any[]) : [];
      if (!toolCalls.length) continue;
      for (const toolCall of toolCalls) {
        try {
          const fn = toolCall && toolCall.function ? toolCall.function : undefined;
          repairCommandNameAsExecToolCall(fn as Record<string, unknown> | undefined, validationOptions);
          rewriteExecCommandApplyPatchCall(fn as Record<string, unknown> | undefined);
          const name = typeof fn?.name === 'string' ? String(fn.name).trim().toLowerCase() : '';
          if (name !== 'apply_patch') continue;
          const rawArgs = (fn as any)?.arguments;
          const argsStr = repairArgumentsToString(rawArgs);
          const validation = validateToolCall('apply_patch', argsStr);
          if (validation?.ok && typeof validation.normalizedArgs === 'string') {
            (fn as any).arguments = validation.normalizedArgs;
          } else if (validation && !validation.ok) {
            (fn as any).arguments = argsStr;
            captureApplyPatchFailure(rawArgs, argsStr, validation.reason);
          }
        } catch (error) {
          logToolGovernorNonBlocking('response_tool_call_normalize_item', error);
        }
      }
    }
    return out;
  } catch (error) {
    logToolGovernorNonBlocking('normalize_apply_patch_tool_calls_on_response', error);
    return chat;
  }
}

export function processChatResponseTools(resp: Unknown): Unknown {
  if (!isObject(resp)) return resp;
  try {
    const requestId = `tool_governor_${Date.now()}`;
    const prepared = prepareRespProcessToolGovernancePayloadWithNative(resp as Record<string, unknown>);
    const governed = applyRespProcessToolGovernanceWithNative({
      payload: prepared.preparedPayload as Record<string, unknown>,
      clientProtocol: 'openai-chat',
      entryEndpoint: '/v1/chat/completions',
      requestId
    });
    const canonical = governed.governedPayload as Unknown;
    const withPatch = normalizeApplyPatchToolCallsOnResponse(canonical);
    return enhanceResponseToolArguments(withPatch);
  } catch (error) {
    logToolGovernorNonBlocking('process_chat_response_tools', error);
    return resp;
  }
}

function enhanceResponseToolArguments(chat: Unknown): Unknown {
  try {
    const enable = String((process as any)?.env?.RCC_TOOL_ENHANCE ?? '1').trim() !== '0';
    if (!enable) return chat;
    const out = JSON.parse(JSON.stringify(chat)) as Unknown;
    const validationOptions = resolveExecCommandGuardValidationOptions(out);
    const choices = Array.isArray((out as any)?.choices) ? ((out as any).choices as any[]) : [];
    for (const choice of choices) {
      const message = choice && choice.message ? choice.message : undefined;
      const toolCalls = Array.isArray(message?.tool_calls) ? (message.tool_calls as any[]) : [];
      if (!toolCalls.length) continue;
      for (const toolCall of toolCalls) {
        try {
          const fn = toolCall && toolCall.function ? toolCall.function : undefined;
          const name = typeof fn?.name === 'string' ? String(fn.name).toLowerCase() : '';
          const repaired = repairArgumentsToString(fn?.arguments);
          let finalStr = repaired;
          if (name === 'shell') {
            finalStr = normalizeShellArguments(repaired);
          } else if (name === 'exec_command') {
            finalStr = normalizeExecCommandArguments(repaired, validationOptions);
          }
          if (fn) fn.arguments = finalStr;
        } catch (error) {
          logToolGovernorNonBlocking('enhance_response_tool_arguments_item', error);
        }
      }
      try {
        if (!choice.finish_reason) choice.finish_reason = 'tool_calls';
      } catch (error) {
        logToolGovernorNonBlocking('enhance_response_tool_arguments_finish_reason', error);
      }
      try {
        if (message && typeof message === 'object' && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
          message.content = null;
        }
      } catch (error) {
        logToolGovernorNonBlocking('enhance_response_tool_arguments_message_content', error);
      }
    }
    return out;
  } catch (error) {
    logToolGovernorNonBlocking('enhance_response_tool_arguments', error);
    return chat;
  }
}

function normalizeShellArguments(repaired: string): string {
  let parsed: any;
  try {
    parsed = JSON.parse(repaired);
  } catch (error) {
    logToolGovernorNonBlocking('enhance_response_tool_arguments_parse_json', error);
    parsed = parseLenient(repaired);
  }
  if (!parsed || typeof parsed !== 'object') {
    return repaired;
  }
  const command = (parsed as any).command;
  if (Array.isArray(command)) {
    const tokens = command.map((value: unknown) => String(value));
    if (isBashLc(tokens)) {
      (parsed as any).command = ['bash', '-lc', repairFindMeta(tokens.slice(2).join(' '))];
    } else if (hasMetaToken(tokens)) {
      (parsed as any).command = ['bash', '-lc', repairFindMeta(tokens.join(' '))];
    }
  } else if (typeof command === 'string') {
    const text = command.trim();
    const hasMeta = /[|<>;&]/.test(text) || text.includes('&&') || text.includes('||') || text.includes('<<');
    if (hasMeta && !/^\s*bash\s+-lc\s+/.test(text)) {
      (parsed as any).command = ['bash', '-lc', repairFindMeta(text)];
    } else if (hasMeta) {
      (parsed as any).command = ['bash', '-lc', repairFindMeta(text.replace(/^\s*bash\s+-lc\s+/, ''))];
    }
  }
  try {
    return JSON.stringify(parsed);
  } catch (error) {
    logToolGovernorNonBlocking('enhance_response_tool_arguments_json_stringify', error);
    return repaired;
  }
}

function normalizeExecCommandArguments(
  repaired: string,
  validationOptions: ReturnType<typeof resolveExecCommandGuardValidationOptions>
): string {
  const validation = validateToolCall('exec_command', repaired, validationOptions);
  if (validation?.ok && typeof validation.normalizedArgs === 'string') {
    return validation.normalizedArgs;
  }
  let parsed: any;
  try {
    parsed = JSON.parse(repaired);
  } catch (error) {
    logToolGovernorNonBlocking('enhance_response_tool_arguments_exec_command_parse_json', error);
    parsed = parseLenient(repaired);
  }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const normalized = normalizeExecCommandArgs(parsed as Record<string, unknown>);
    if (normalized.ok) {
      try {
        return JSON.stringify(normalized.normalized ?? {});
      } catch (error) {
        logToolGovernorNonBlocking('enhance_response_tool_arguments_exec_command_json_stringify', error);
      }
    }
  }
  return repaired;
}

function captureApplyPatchFailure(rawArgs: unknown, argsStr: string, reason?: string): void {
  try {
    const finalReason = reason ?? 'unknown';
    captureApplyPatchRegression({
      errorType: finalReason,
      originalArgs: rawArgs,
      normalizedArgs: argsStr,
      validationError: finalReason,
      source: 'tool-governor.response',
      meta: { applyPatchToolMode: 'freeform' }
    });
    const snippet =
      typeof argsStr === 'string' && argsStr.trim().length
        ? argsStr.trim().slice(0, 200).replace(/\s+/g, ' ')
        : '';
    // eslint-disable-next-line no-console
    console.error(
      `\x1b[31m[apply_patch][precheck][response] validation_failed reason=${finalReason}${
        snippet ? ` args=${snippet}` : ''
      }\x1b[0m`
    );
  } catch (error) {
    logToolGovernorNonBlocking('response_apply_patch_regression_capture', error);
  }
}

function isBashLc(tokens: string[]): boolean {
  return tokens.length >= 2 && tokens[0] === 'bash' && tokens[1] === '-lc';
}

function hasMetaToken(tokens: string[]): boolean {
  const metas = ['|', '>', '>>', '<', '<<', ';', '&&', '||', '(', ')'];
  return tokens.some((token) => {
    const value = String(token);
    return metas.includes(value) || /[|<>;&]/.test(value) || value.includes('&&') || value.includes('||') || value.includes('<<');
  });
}
