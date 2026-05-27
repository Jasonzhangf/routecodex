import { validateToolCall } from '../../tools/tool-registry.js';
import { repairFindMeta } from './tooling.js';
import { normalizeExecCommandArgs } from '../../tools/exec-command/normalize.js';
import {
  repairCommandNameAsExecToolCall,
  resolveExecCommandGuardValidationOptions
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
    return enhanceResponseToolArguments(canonical);
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
      let toolCalls = Array.isArray(message?.tool_calls) ? (message.tool_calls as any[]) : [];
      if (!toolCalls.length && typeof message?.content === 'string') {
        const recovered = recoverToolCallsFromContent(message.content);
        if (recovered.length > 0) {
          message.tool_calls = recovered;
          toolCalls = recovered;
        }
      }
      if (!toolCalls.length) continue;
      for (const toolCall of toolCalls) {
        try {
          const fn = toolCall && toolCall.function ? toolCall.function : undefined;
          if (isObject(fn)) {
            repairCommandNameAsExecToolCall(fn as Record<string, unknown>, validationOptions);
            if (typeof (fn as any).name === 'string' && String((fn as any).name).toLowerCase() === 'execute_command') {
              (fn as any).name = 'exec_command';
            }
          }
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
        if (!choice.finish_reason || choice.finish_reason === 'stop') choice.finish_reason = 'tool_calls';
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

function recoverToolCallsFromContent(content: string): any[] {
  const text = String(content || '');
  const candidates: string[] = [];
  const rcc = text.match(/<<RCC_TOOL_CALLS_JSON\s*\n([\s\S]*?)\nRCC_TOOL_CALLS_JSON/i);
  if (rcc?.[1]) candidates.push(rcc[1].trim());
  const rawJson = text.match(/\{[\s\S]*"tool_calls"[\s\S]*\}/);
  if (rawJson?.[0]) candidates.push(rawJson[0].trim());
  for (const raw of candidates) {
    let parsed: any;
    try { parsed = JSON.parse(raw); } catch { parsed = parseLenient(raw); }
    const rows = Array.isArray(parsed?.tool_calls) ? parsed.tool_calls : [];
    const out: any[] = [];
    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i] || {};
      const name = typeof row.name === 'string'
        ? row.name
        : (typeof row?.function?.name === 'string' ? row.function.name : '');
      if (!name) continue;
      const args = row.input ?? row.arguments ?? row?.function?.arguments ?? {};
      out.push({
        id: row.id || `call_recovered_${i + 1}`,
        type: 'function',
        function: {
          name,
          arguments: typeof args === 'string' ? args : JSON.stringify(args)
        }
      });
    }
    if (out.length > 0) return out;
  }

  // Last-resort regex recovery for malformed JSON segments containing
  // repeated {"name":"...","input":{...}} entries.
  const recovered: any[] = [];
  const re = /"name"\s*:\s*"([^"]+)"\s*,\s*"input"\s*:\s*(\{[\s\S]*?\})(?=\s*,\s*\{\s*"name"|\s*\]\s*\}|$)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const name = String(match[1] || '').trim();
    const inputRaw = String(match[2] || '{}').trim();
    if (!name) continue;
    recovered.push({
      id: `call_recovered_${recovered.length + 1}`,
      type: 'function',
      function: { name, arguments: inputRaw }
    });
  }
  if (recovered.length > 0) return recovered;

  return [];
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
