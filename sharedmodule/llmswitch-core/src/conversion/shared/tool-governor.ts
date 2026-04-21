// Unified tool governance API (标准)
// Centralizes tool augmentation, guidance injection/refinement, and structured tool_calls canonicalization

// canonicalizer 按需加载（避免在请求侧仅注入时引入不必要的模块）
// enforceChatBudget: 为避免在请求侧引入多余依赖，这里提供最小实现（保留形状，不裁剪）。

import { augmentOpenAITools } from '../../guidance/index.js';
import { validateToolCall } from '../../tools/tool-registry.js';
import { repairFindMeta } from './tooling.js';
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
  applyRespProcessToolGovernanceWithNative,
  prepareRespProcessToolGovernancePayloadWithNative
} from '../../router/virtual-router/engine-selection/native-chat-process-governance-semantics.js';
import { normalizeChatResponseReasoningToolsWithNative as normalizeChatResponseReasoningToolsLegacy } from '../../router/virtual-router/engine-selection/native-hub-bridge-action-semantics.js';
import {
  parseLenientJsonishWithNative as parseLenient,
  repairArgumentsToStringWithNative as repairArgumentsToString
} from '../../router/virtual-router/engine-selection/native-shared-conversion-semantics.js';
import { resolveRccPath } from '../../runtime/user-data-paths.js';

type Unknown = Record<string, unknown>;
function isObject(v: unknown): v is Unknown { return !!v && typeof v === 'object' && !Array.isArray(v); }
// Note: tool schema strict augmentation removed per alignment

function enforceChatBudget<T>(chat: T, _modelId: string): T { return chat; }

export interface ToolGovernanceOptions {
  injectGuidance?: boolean; // deprecated: system guidance injection removed
  snapshot?: {
    enabled?: boolean;
    endpoint?: string; // e.g. '/v1/chat/completions' | '/v1/responses' | '/v1/messages' or shorthand 'chat'|'responses'|'messages'
    requestId?: string; // prefer upstream-request id for grouping
    baseDir?: string;   // default: ~/.rcc/codex-samples
  };
}

function logToolGovernorNonBlocking(stage: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error ?? 'unknown');
  // eslint-disable-next-line no-console
  console.warn(`[tool-governor][non-blocking] stage=${stage} error=${message}`);
}

function tryWriteSnapshot(options: ToolGovernanceOptions | undefined, stage: string, data: Unknown): void {
  try {
    // 仅在 verbose 级别保存快照（环境变量）
    const envLevel = String(process.env.RCC_HOOKS_VERBOSITY || process.env.ROUTECODEX_HOOKS_VERBOSITY || '').toLowerCase();
    const isVerbose = envLevel === 'verbose';
    if (!isVerbose) return;
    const snap = options?.snapshot;
    if (!snap || snap.enabled === false) return;
    const fs = require('fs');
    const path = require('path');
    const base = snap.baseDir || resolveRccPath('codex-samples');
    const ep = String(snap.endpoint || 'chat').toLowerCase();
    const group = ep.includes('responses') ? 'openai-responses' : ep.includes('messages') ? 'anthropic-messages' : 'openai-chat';
    const rid = String(snap.requestId || `req_${Date.now()}_${Math.random().toString(36).slice(2,8)}`);
    const dir = path.join(base, group, rid);
    const file = path.join(dir, `govern-${stage}.json`);
    if (fs.existsSync(file)) return; // 不重复
    fs.mkdirSync(dir, { recursive: true });
    const payload = JSON.stringify(data, null, 2);
    fs.writeFileSync(file, payload, 'utf-8');
  } catch (error) {
    logToolGovernorNonBlocking(`snapshot_write:${stage}`, error);
  }
}

function hasRecoveredResponseToolCalls(payload: Unknown): boolean {
  const choices = Array.isArray((payload as any)?.choices) ? ((payload as any).choices as any[]) : [];
  return choices.some((choice) => {
    const toolCalls = Array.isArray(choice?.message?.tool_calls) ? choice.message.tool_calls : [];
    return toolCalls.length > 0;
  });
}

function shouldAttemptLegacyNamedToolSalvage(payload: Unknown): boolean {
  try {
    const raw = JSON.stringify(payload ?? {});
    if (!raw) return false;
    const hasToolCallsMarker = /"tool_calls"|'tool_calls'|\btool_calls\b/i.test(raw);
    const hasExplicitNameMarker = /\\"name\\"\s*:|"name"\s*:|'name'\s*:|\bname\s*:/i.test(raw);
    return hasToolCallsMarker && hasExplicitNameMarker;
  } catch {
    return false;
  }
}

/**
 * Process OpenAI Chat request (messages/tools) with unified 标准 governance.
 * - Augment tools (strict schemas)
 * - Inject/Refine system tool guidance (idempotent)
 * - Canonicalize structured tool_calls; set content=null when applicable
 */
export function processChatRequestTools(request: Unknown, opts?: ToolGovernanceOptions): Unknown {
  const options: ToolGovernanceOptions = { ...(opts || {}) };
  if (!isObject(request)) return request;
  const out: Unknown = JSON.parse(JSON.stringify(request));

  // tools 形状最小修复：为缺失 function.parameters 的工具补一个空对象，避免上游
  // Responses/OpenAI 校验 422（外部错误必须暴露，但这里属于规范化入口）。
  try {
    let tools = Array.isArray((out as any)?.tools) ? ((out as any).tools as any[]) : [];
    if (tools.length > 0) {
      for (const t of tools) {
        if (!t || typeof t !== 'object') continue;
        const fn = (t as any).function;
        if (!fn || typeof fn !== 'object') continue;
        const typeStr = String((t as any).type || '').toLowerCase();
        const nameStr = typeof (fn as any).name === 'string' ? String((fn as any).name).toLowerCase() : '';
        const shouldPatch = typeStr === 'function' || nameStr === 'apply_patch';
        if (!shouldPatch) continue;
        if (!Object.prototype.hasOwnProperty.call(fn, 'parameters')) {
          (t as any).function = { ...(fn as any), parameters: {} };
        }
      }
      // 严格化工具 schema（apply_patch/shell/MCP 等）保持在唯一治理点，避免重复注入
      (out as any).tools = augmentOpenAITools(tools);
    }
  } catch (error) {
    logToolGovernorNonBlocking('request_minimal_tool_shape_repair', error);
  }

  // 1) 移除工具 schema 严格化（与 统一标准，不在此处约束 tools 结构）

  // NOTE: system guidance injection removed by design (align with parameter-level strategy)

  try {
    // 请求侧不再对历史消息做 shell 形状包装；仅维持最小字符串化等轻度修复
    const canonical = out as any;
    // 3.1) tool_choice 策略（与标准 tooluse 对齐）：对特定模型可设置 required；默认 auto
    try {
      const modelId = typeof canonical?.model === 'string' ? String(canonical.model) : 'unknown';
      const raw = String((process as any)?.env?.RCC_TOOL_CHOICE_REQUIRED || '').trim();
      const wanted = raw ? raw.split(',').map((s: string) => s.trim()).filter(Boolean) : [];
      if (Array.isArray(canonical?.tools) && (canonical.tools as any[]).length > 0) {
        // default auto
        if (!canonical.tool_choice) canonical.tool_choice = 'auto';
        if (wanted.length > 0 && wanted.some((p: string) => modelId.includes(p))) {
          canonical.tool_choice = 'required';
        }
      }
    } catch (error) {
      logToolGovernorNonBlocking('request_tool_choice_policy', error);
    }
    // 4) Enforce payload budget (context bytes) with minimal loss policy
    const modelId = typeof (canonical as any)?.model === 'string' ? String((canonical as any).model) : 'unknown';
    const budgeted = enforceChatBudget(canonical, modelId);
    return normalizeSpecialToolCallsOnRequest(budgeted);
  } catch (error) {
    logToolGovernorNonBlocking('process_chat_request_tools', error);
    return out;
  }
}

/**
 * Process OpenAI Chat response (choices[0].message) with unified 标准 governance.
 * - Canonicalize structured tool_calls; ensure finish_reason and content=null policy
 */

export function normalizeApplyPatchToolCallsOnResponse(chat: Unknown): Unknown {
  try {
    const out = JSON.parse(JSON.stringify(chat)) as Unknown;
    const validationOptions = resolveExecCommandGuardValidationOptions(out);
    const choices = Array.isArray((out as any)?.choices) ? ((out as any).choices as any[]) : [];
    for (const ch of choices) {
      const msg = ch && ch.message ? ch.message : undefined;
      const tcs = Array.isArray(msg?.tool_calls) ? (msg.tool_calls as any[]) : [];
      if (!tcs.length) continue;
      for (const tc of tcs) {
        try {
          const fn = tc && tc.function ? tc.function : undefined;
          repairCommandNameAsExecToolCall(fn as Record<string, unknown> | undefined, validationOptions);
          rewriteExecCommandApplyPatchCall(fn as Record<string, unknown> | undefined);
          const name = typeof fn?.name === 'string' ? String(fn.name).trim().toLowerCase() : '';
          if (name !== 'apply_patch') continue;
          const rawArgs = (fn as any)?.arguments;
          const argsStr = repairArgumentsToString(rawArgs);
          const validation = validateToolCall('apply_patch', argsStr);
          if (validation && validation.ok && typeof validation.normalizedArgs === 'string') {
            (fn as any).arguments = validation.normalizedArgs;
          } else if (validation && !validation.ok) {
            (fn as any).arguments = argsStr;
            try {
              const reason = validation.reason ?? 'unknown';
              captureApplyPatchRegression({
                errorType: reason,
                originalArgs: rawArgs,
                normalizedArgs: argsStr,
                validationError: reason,
                source: 'tool-governor.response',
                meta: { applyPatchToolMode: 'freeform' }
              });
              const snippet =
                typeof argsStr === 'string' && argsStr.trim().length
                  ? argsStr.trim().slice(0, 200).replace(/\s+/g, ' ')
                  : '';
              // eslint-disable-next-line no-console
              console.error(
                `\x1b[31m[apply_patch][precheck][response] validation_failed reason=${reason}${
                  snippet ? ` args=${snippet}` : ''
                }\x1b[0m`
              );
            } catch (error) {
              logToolGovernorNonBlocking('response_apply_patch_regression_capture', error);
            }
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

export function normalizeApplyPatchToolCallsOnRequest(request: Unknown): Unknown {
  return normalizeSpecialToolCallsOnRequest(request);
}

function normalizeSpecialToolCallsOnRequest(request: Unknown): Unknown {
  try {
    const out = JSON.parse(JSON.stringify(request)) as Unknown;
    const validationOptions = resolveExecCommandGuardValidationOptions(out);
    const messages = Array.isArray((out as any)?.messages) ? ((out as any).messages as any[]) : [];
    // 仅针对「当轮」工具调用做校验与形态修复：选择最后一条 assistant 消息
    let lastAssistantIndex = -1;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const candidate = messages[i];
      if (!candidate || typeof candidate !== 'object') continue;
      if ((candidate as any).role === 'assistant') {
        lastAssistantIndex = i;
        break;
      }
    }
    if (lastAssistantIndex === -1) {
      return out;
    }
    let rewrittenNestedApplyPatchCount = 0;
    for (let i = 0; i < messages.length; i += 1) {
      const msg = messages[i];
      if (!msg || typeof msg !== 'object') continue;
      if (i !== lastAssistantIndex) continue;
      const tcs = Array.isArray((msg as any).tool_calls) ? ((msg as any).tool_calls as any[]) : [];
      if (!tcs.length) continue;
      for (const tc of tcs) {
        try {
          const fn = tc && tc.function ? tc.function : undefined;
          repairCommandNameAsExecToolCall(fn as Record<string, unknown> | undefined, validationOptions);
          if (rewriteExecCommandApplyPatchCall(fn as Record<string, unknown> | undefined)) {
            rewrittenNestedApplyPatchCount += 1;
          }
          const name = typeof fn?.name === 'string' ? String(fn.name).trim().toLowerCase() : '';
          const rawArgs = (fn as any)?.arguments;

          // apply_patch 兼容：统一生成 { patch, input }
          if (name === 'apply_patch') {
            const argsStr = repairArgumentsToString(rawArgs);
            const validation = validateToolCall('apply_patch', argsStr);
            if (validation && validation.ok && typeof validation.normalizedArgs === 'string') {
              (fn as any).arguments = validation.normalizedArgs;
            } else if (validation && !validation.ok) {
              (fn as any).arguments = buildBlockedApplyPatchArgs(rawArgs, validation.reason, validation.message);
              try {
                const reason = validation.reason ?? 'unknown';
                captureApplyPatchRegression({
                  errorType: reason,
                  originalArgs: rawArgs,
                  normalizedArgs: argsStr,
                  validationError: reason,
                  source: 'tool-governor.request',
                  meta: { applyPatchToolMode: 'freeform' }
                });
                const snippet =
                  typeof argsStr === 'string' && argsStr.trim().length
                    ? argsStr.trim().slice(0, 200).replace(/\s+/g, ' ')
                    : '';
                // eslint-disable-next-line no-console
                console.error(
                  `\x1b[31m[apply_patch][precheck][request] validation_failed reason=${reason}${
                    snippet ? ` args=${snippet}` : ''
                  }\x1b[0m`
                );
              } catch (error) {
                logToolGovernorNonBlocking('request_apply_patch_regression_capture', error);
              }
            }
            continue;
          }

          // exec_command 兼容：TOON / map / string 一律收敛为 { cmd, command, workdir, ... }
          if (name === 'exec_command') {
            const argsStr = repairArgumentsToString(rawArgs);
            const validation = validateToolCall('exec_command', argsStr, validationOptions);
            if (validation && validation.ok && typeof validation.normalizedArgs === 'string') {
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
                const next = normalized.ok ? normalized.normalized : (parsed as Record<string, unknown>);
                try {
                  (fn as any).arguments = JSON.stringify(next ?? {});
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

function enhanceResponseToolArguments(chat: Unknown): Unknown {
  try {
    const enable = String((process as any)?.env?.RCC_TOOL_ENHANCE ?? '1').trim() !== '0';
    if (!enable) return chat;
    const out = JSON.parse(JSON.stringify(chat)) as Unknown;
    const validationOptions = resolveExecCommandGuardValidationOptions(out);
    const choices = Array.isArray((out as any)?.choices) ? ((out as any).choices as any[]) : [];
    for (const ch of choices) {
      const msg = ch && ch.message ? ch.message : undefined;
      const tcs = Array.isArray(msg?.tool_calls) ? (msg.tool_calls as any[]) : [];
      if (!tcs.length) continue;
      // Helpers for shell normalization (idempotent, aligned with ResponseToolArgumentsStringifyFilter)
      const toStr = (v: unknown) => String(v);
      const isBashLc = (arr: string[]) => arr.length >= 2 && arr[0] === 'bash' && arr[1] === '-lc';
      const hasMetaToken = (arr: string[]) => {
        const metas = ['|','>','>>','<','<<',';','&&','||','(',')'];
        return arr.some(t => {
          const s = String(t);
          if (metas.includes(s)) return true;
          return /[|<>;&]/.test(s) || s.includes('&&') || s.includes('||') || s.includes('<<');
        });
      };
      const repairFindMeta = (s: string): string => {
        try {
          const hasFind = /(^|\s)find\s/.test(s);
          if (!hasFind) return s;
          let out = s;
          out = out.replace(/-exec([^;]*?)(?<!\\);/g, (_m, g1) => `-exec${g1} \\;`);
          out = out.replace(/-exec([^;]*?)\\+;/g, (_m, g1) => `-exec${g1} \\;`);
          out = out.replace(/(?<!\\)\(/g, '\\(').replace(/(?<!\\)\)/g, '\\)');
          return out;
        } catch (error) {
          logToolGovernorNonBlocking('enhance_response_tool_arguments_repair_find_meta', error);
          return s;
        }
      };
      for (const tc of tcs) {
        try {
          const fn = tc && tc.function ? tc.function : undefined;
          const name = typeof fn?.name === 'string' ? String(fn.name).toLowerCase() : '';
          const argIn = fn?.arguments;
          const repaired = repairArgumentsToString(argIn);
          // Default to repaired JSON string
          let finalStr = repaired;
          // Extra normalization for shell
          if (name === 'shell') {
            let parsed: any;
            try {
              parsed = JSON.parse(repaired);
            } catch (error) {
              logToolGovernorNonBlocking('enhance_response_tool_arguments_parse_json', error);
              parsed = parseLenient(repaired);
            }
            if (parsed && typeof parsed === 'object') {
              const cmd = (parsed as any).command;
              if (Array.isArray(cmd)) {
                const tokens = cmd.map(toStr);
                if (isBashLc(tokens)) {
                  const joined = tokens.slice(2).join(' ');
                  (parsed as any).command = ['bash','-lc', repairFindMeta(joined)];
                } else if (hasMetaToken(tokens)) {
                  (parsed as any).command = ['bash','-lc', repairFindMeta(tokens.join(' '))];
                }
              } else if (typeof cmd === 'string') {
                const s = cmd.trim();
                const hasMeta = /[|<>;&]/.test(s) || s.includes('&&') || s.includes('||') || s.includes('<<');
                if (hasMeta && !/^\s*bash\s+-lc\s+/.test(s)) {
                  (parsed as any).command = ['bash','-lc', repairFindMeta(s)];
                } else if (hasMeta && /^\s*bash\s+-lc\s+/.test(s)) {
                  // Already wrapped but ensure idempotent repairs
                  const body = s.replace(/^\s*bash\s+-lc\s+/, '');
                  (parsed as any).command = ['bash','-lc', repairFindMeta(body)];
                }
              }
              try {
                finalStr = JSON.stringify(parsed);
              } catch (error) {
                logToolGovernorNonBlocking('enhance_response_tool_arguments_json_stringify', error);
                finalStr = repaired;
              }
            }
          } else if (name === 'exec_command') {
            const validation = validateToolCall('exec_command', repaired, validationOptions);
            if (validation && validation.ok && typeof validation.normalizedArgs === 'string') {
              finalStr = validation.normalizedArgs;
            } else {
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
                    finalStr = JSON.stringify(normalized.normalized ?? {});
                  } catch (error) {
                    logToolGovernorNonBlocking('enhance_response_tool_arguments_exec_command_json_stringify', error);
                    finalStr = repaired;
                  }
                }
              }
            }
          }
          if (fn) fn.arguments = finalStr;
        } catch (error) {
          logToolGovernorNonBlocking('enhance_response_tool_arguments_item', error);
        }
      }
      // Ensure finish_reason/tool_calls invariant if missing (idempotent with canonicalizer)
      try {
        if (!ch.finish_reason) ch.finish_reason = 'tool_calls';
      } catch (error) {
        logToolGovernorNonBlocking('enhance_response_tool_arguments_finish_reason', error);
      }
      try {
        if (msg && typeof msg === 'object' && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
          msg.content = null;
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
    let canonical = governed.governedPayload as Unknown;
    if (!hasRecoveredResponseToolCalls(canonical) && shouldAttemptLegacyNamedToolSalvage(resp)) {
      const salvaged = normalizeChatResponseReasoningToolsLegacy(resp as any);
      if (hasRecoveredResponseToolCalls(salvaged as Unknown)) {
        canonical = salvaged as Unknown;
      }
    }
    const withPatch = normalizeApplyPatchToolCallsOnResponse(canonical as Unknown);
    return enhanceResponseToolArguments(withPatch as Unknown);
  } catch (error) {
    logToolGovernorNonBlocking('process_chat_response_tools', error);
    return resp;
  }
}

export interface GovernContext extends ToolGovernanceOptions {
  phase: 'request' | 'response';
  endpoint?: 'chat' | 'responses' | 'messages';
  stream?: boolean;
  produceRequiredAction?: boolean; // default true for responses non-stream
  requestId?: string;
}

// Unified, 对齐 governance entry
export function governTools(payload: Unknown, ctx: GovernContext): Unknown {
  const phase = ctx?.phase || 'request';
  const ep = ctx?.endpoint || 'chat';
  if (phase === 'request') {
    return processChatRequestTools(payload, {
      injectGuidance: ctx?.injectGuidance !== false,
      snapshot: ctx?.snapshot || { enabled: true, endpoint: ep, requestId: ctx?.requestId }
    });
  }
  // response phase
  // 变更前快照：响应侧 canonicalize 之前
  try {
    const opts: ToolGovernanceOptions = { snapshot: ctx?.snapshot || { enabled: true, endpoint: ep, requestId: ctx?.requestId } };
    tryWriteSnapshot(opts, 'response_before_canonicalize', payload);
  } catch (error) {
    logToolGovernorNonBlocking('govern_tools_snapshot_before_canonicalize', error);
  }
  let out = processChatResponseTools(payload);
  // 变更后快照：响应侧 canonicalize 之后
  try {
    const opts: ToolGovernanceOptions = { snapshot: ctx?.snapshot || { enabled: true, endpoint: ep, requestId: ctx?.requestId } };
    tryWriteSnapshot(opts, 'response_after_canonicalize', out as any);
  } catch (error) {
    logToolGovernorNonBlocking('govern_tools_snapshot_after_canonicalize', error);
  }
  if (ep === 'responses' && ctx?.stream !== true && ctx?.produceRequiredAction !== false) {
    // 变更前快照：构造 required_action 之前
    try {
      const opts: ToolGovernanceOptions = { snapshot: ctx?.snapshot || { enabled: true, endpoint: ep, requestId: ctx?.requestId } };
      tryWriteSnapshot(opts, 'response_before_required_action', out as any);
    } catch (error) {
      logToolGovernorNonBlocking('govern_tools_snapshot_before_required_action', error);
    }
    try {
      const { buildResponsesPayloadFromChat } = require('../responses/responses-openai-bridge.js');
      const res = buildResponsesPayloadFromChat(out, { requestId: ctx?.requestId });
      try {
        const opts: ToolGovernanceOptions = { snapshot: ctx?.snapshot || { enabled: true, endpoint: ep, requestId: ctx?.requestId } };
        tryWriteSnapshot(opts, 'response_after_required_action', res as any);
      } catch (error) {
        logToolGovernorNonBlocking('govern_tools_snapshot_after_required_action', error);
      }
      return res as any;
    } catch (error) {
      logToolGovernorNonBlocking('govern_tools_required_action_bridge', error);
    }
  }
  return out;
}
