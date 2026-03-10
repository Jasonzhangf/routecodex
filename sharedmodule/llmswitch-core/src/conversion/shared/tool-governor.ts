// Unified tool governance API (标准)
// Centralizes tool augmentation, guidance injection/refinement, and structured tool_calls canonicalization

// canonicalizer 按需加载（避免在请求侧仅注入时引入不必要的模块）
// enforceChatBudget: 为避免在请求侧引入多余依赖，这里提供最小实现（保留形状，不裁剪）。

import { augmentOpenAITools } from '../../guidance/index.js';
import { validateToolCall } from '../../tools/tool-registry.js';
import type { ToolValidationOptions } from '../../tools/tool-registry.js';
import { repairFindMeta } from './tooling.js';
import { captureApplyPatchRegression } from '../../tools/patch-regression-capturer.js';
import { normalizeExecCommandArgs } from '../../tools/exec-command/normalize.js';
import { readRuntimeMetadata } from '../runtime-metadata.js';
import { normalizeChatResponseReasoningToolsWithNative } from '../../router/virtual-router/engine-selection/native-hub-bridge-action-semantics.js';

type Unknown = Record<string, unknown>;
function isObject(v: unknown): v is Unknown { return !!v && typeof v === 'object' && !Array.isArray(v); }
// Note: tool schema strict augmentation removed per alignment

function enforceChatBudget<T>(chat: T, _modelId: string): T { return chat; }

function resolveExecCommandGuardValidationOptions(payload: Unknown): ToolValidationOptions | undefined {
  const carrier =
    isObject((payload as any).metadata)
      ? ((payload as any).metadata as Record<string, unknown>)
      : (payload as Record<string, unknown>);
  const rt = readRuntimeMetadata(carrier);
  if (!rt || typeof rt !== 'object') {
    return undefined;
  }
  const guardRaw = (rt as Record<string, unknown>).execCommandGuard;
  if (!guardRaw || typeof guardRaw !== 'object' || Array.isArray(guardRaw)) {
    return undefined;
  }
  const guard = guardRaw as Record<string, unknown>;
  const enabled = guard.enabled === true;
  if (!enabled) {
    return undefined;
  }
  const policyFile =
    typeof guard.policyFile === 'string' && guard.policyFile.trim().length
      ? guard.policyFile.trim()
      : undefined;
  return {
    execCommandGuard: {
      enabled: true,
      ...(policyFile ? { policyFile } : {})
    }
  };
}

function isTruthyEnv(value: unknown): boolean {
  const v = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

function isApplyPatchPayloadCandidate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const text = value.trim();
  if (!text) return false;
  return (
    text.startsWith('*** Begin Patch') ||
    text.startsWith('*** Update File:') ||
    text.startsWith('*** Add File:') ||
    text.startsWith('*** Delete File:') ||
    text.startsWith('--- a/') ||
    text.startsWith('--- ')
  );
}

function extractApplyPatchPayloadFromExecArgs(rawArgs: unknown): string | null {
  const argsStr = repairArgumentsToString(rawArgs);
  let parsed: unknown;
  try {
    parsed = JSON.parse(argsStr);
  } catch {
    parsed = parseLenient(argsStr);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }

  const obj = parsed as Record<string, unknown>;
  const commandValue = obj.command ?? obj.cmd;
  if (Array.isArray(commandValue)) {
    const tokens = commandValue.map((entry) => (typeof entry === 'string' ? entry : String(entry ?? '')));
    if (!tokens.length) return null;
    const commandToken = tokens[0]?.trim().toLowerCase() || '';
    const isApplyPatchCommand =
      commandToken === 'apply_patch' || commandToken.endsWith('/apply_patch') || commandToken.endsWith('\\apply_patch');
    if (!isApplyPatchCommand) {
      return null;
    }
    const patchText = tokens.slice(1).join('\n').trim();
    return isApplyPatchPayloadCandidate(patchText) ? patchText : null;
  }

  if (typeof commandValue === 'string') {
    const raw = commandValue.trim();
    if (!raw) return null;
    if (!raw.toLowerCase().startsWith('apply_patch')) return null;
    const patchText = raw.slice('apply_patch'.length).trim();
    return isApplyPatchPayloadCandidate(patchText) ? patchText : null;
  }

  return null;
}

function rewriteExecCommandApplyPatchCall(fn: Record<string, unknown> | undefined): boolean {
  if (!fn) return false;
  const currentName = typeof fn.name === 'string' ? String(fn.name).trim().toLowerCase() : '';
  if (currentName !== 'exec_command') return false;

  const patch = extractApplyPatchPayloadFromExecArgs((fn as any).arguments);
  if (!patch) return false;

  (fn as any).name = 'apply_patch';
  (fn as any).arguments = JSON.stringify({ patch, input: '' });
  return true;
}

const NESTED_APPLY_PATCH_POLICY_MARKER = '[Codex NestedApplyPatch Policy]';

function buildNestedApplyPatchPolicyNotice(rewriteCount: number): string {
  const count = Number.isFinite(rewriteCount) && rewriteCount > 0 ? Math.floor(rewriteCount) : 0;
  return [
    NESTED_APPLY_PATCH_POLICY_MARKER,
    'Forbidden usage detected: apply_patch must NEVER be called via exec_command or shell (detected=' + count + ').',
    'The call was auto-rewritten to apply_patch for compatibility this turn.',
    'Next action rule: call apply_patch directly; do not nest apply_patch inside exec_command/shell.',
    '禁止通过 exec_command/shell 嵌套调用 apply_patch；本轮已自动改写，后续必须直接调用 apply_patch。'
  ].join('\n');
}

function injectNestedApplyPatchPolicyNotice(messages: any[], rewriteCount: number): void {
  if (!Array.isArray(messages) || rewriteCount <= 0) {
    return;
  }
  const exists = messages.some((entry) => {
    if (!entry || typeof entry !== 'object') return false;
    if ((entry as any).role !== 'system') return false;
    const content = typeof (entry as any).content === 'string' ? String((entry as any).content) : '';
    return content.includes(NESTED_APPLY_PATCH_POLICY_MARKER);
  });
  if (exists) {
    return;
  }
  messages.push({
    role: 'system',
    content: buildNestedApplyPatchPolicyNotice(rewriteCount)
  });
}

function shellSingleQuote(text: string): string {
  return `'${String(text || '').replace(/'/g, `'\\''`)}'`;
}

function buildExecCommandGuardScript(reason?: string, message?: string): string {
  const fallback = 'blocked by exec_command guard policy.';
  const detail =
    reason === 'forbidden_git_reset_hard'
      ? 'blocked by exec_command guard: git reset --hard is forbidden. Use git reset --mixed REF or git restore --source REF -- FILE.'
      : reason === 'forbidden_git_checkout_scope'
        ? 'blocked by exec_command guard: git checkout is allowed only for a single file. Use git checkout -- FILE or git checkout REF -- FILE.'
        : reason === 'forbidden_exec_command_policy'
          ? `policy 不允许: ${(message || '').trim() || 'command blocked by policy'}`
        : message && message.trim()
          ? `blocked by exec_command guard: ${message.trim()}`
          : fallback;
  const compact = detail.replace(/\s+/g, ' ').trim() || fallback;
  return `bash -lc "printf '%s\\n' ${shellSingleQuote(compact)} >&2; exit 2"`;
}

function buildBlockedExecCommandArgs(rawArgs: unknown, reason?: string, message?: string): string {
  let parsed: any = {};
  try {
    const repaired = repairArgumentsToString(rawArgs);
    try {
      parsed = JSON.parse(repaired);
    } catch {
      parsed = parseLenient(repaired);
    }
  } catch {
    parsed = {};
  }
  const out: Record<string, unknown> = {};
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const workdir =
      typeof parsed.workdir === 'string'
        ? parsed.workdir
        : typeof parsed.cwd === 'string'
          ? parsed.cwd
          : undefined;
    if (workdir && workdir.trim().length > 0) {
      out.workdir = workdir.trim();
    }
  }
  out.cmd = buildExecCommandGuardScript(reason, message);
  try {
    return JSON.stringify(out);
  } catch {
    return JSON.stringify({
      cmd: `bash -lc 'printf "%s\\n" "blocked by exec_command guard policy." >&2; exit 2'`
    });
  }
}

const EXEC_COMMAND_NAME_AS_COMMAND_PATTERN =
  /^(?:rg|wc|cat|ls|find|grep|git|sed|head|tail|awk|bash|sh|zsh|node|npm|pnpm|yarn|bd|echo|cp|mv|rm|mkdir|python|python3|perl|ruby)\b/i;

function repairCommandNameAsExecToolCall(
  fn: Record<string, unknown> | undefined,
  validationOptions?: ToolValidationOptions
): boolean {
  try {
    if (!fn) return false;
    const rawName = typeof fn.name === 'string' ? String(fn.name).trim() : '';
    if (!rawName) return false;
    const lowered = rawName.toLowerCase();
    if (lowered === 'exec_command' || lowered === 'shell_command' || lowered === 'shell' || lowered === 'bash') {
      return false;
    }
    // Malformed shape seen in the wild: command string is put into function.name.
    if (!EXEC_COMMAND_NAME_AS_COMMAND_PATTERN.test(rawName)) {
      return false;
    }

    const repaired = repairArgumentsToString((fn as any).arguments);
    let parsed: unknown;
    try {
      parsed = JSON.parse(repaired);
    } catch {
      parsed = parseLenient(repaired);
    }
    const argsObj = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? ({ ...(parsed as Record<string, unknown>) } as Record<string, unknown>)
      : ({} as Record<string, unknown>);

    const existingCmd =
      typeof argsObj.cmd === 'string' && String(argsObj.cmd).trim().length
        ? String(argsObj.cmd).trim()
        : typeof argsObj.command === 'string' && String(argsObj.command).trim().length
          ? String(argsObj.command).trim()
          : '';
    const cmd = existingCmd || rawName;
    argsObj.cmd = cmd;
    argsObj.command = cmd;
    if (typeof argsObj.cwd === 'string' && (!argsObj.workdir || typeof argsObj.workdir !== 'string')) {
      argsObj.workdir = String(argsObj.cwd);
    }

    const validation = validateToolCall('exec_command', JSON.stringify(argsObj), validationOptions);
    if (validation.ok && typeof validation.normalizedArgs === 'string') {
      (fn as any).arguments = validation.normalizedArgs;
    } else {
      const fallback: Record<string, unknown> = { cmd, command: cmd };
      if (typeof argsObj.workdir === 'string' && String(argsObj.workdir).trim().length > 0) {
        fallback.workdir = String(argsObj.workdir).trim();
      }
      (fn as any).arguments = JSON.stringify(fallback);
    }
    (fn as any).name = 'exec_command';
    return true;
  } catch {
    return false;
  }
}

export interface ToolGovernanceOptions {
  injectGuidance?: boolean; // deprecated: system guidance injection removed
  snapshot?: {
    enabled?: boolean;
    endpoint?: string; // e.g. '/v1/chat/completions' | '/v1/responses' | '/v1/messages' or shorthand 'chat'|'responses'|'messages'
    requestId?: string; // prefer upstream-request id for grouping
    baseDir?: string;   // default: ~/.routecodex/codex-samples
  };
}

function tryWriteSnapshot(options: ToolGovernanceOptions | undefined, stage: string, data: Unknown): void {
  try {
    // 仅在 verbose 级别保存快照（环境变量）
    const envLevel = String(process.env.RCC_HOOKS_VERBOSITY || process.env.ROUTECODEX_HOOKS_VERBOSITY || '').toLowerCase();
    const isVerbose = envLevel === 'verbose';
    if (!isVerbose) return;
    const snap = options?.snapshot;
    if (!snap || snap.enabled === false) return;
    const os = require('os');
    const fs = require('fs');
    const path = require('path');
    const home = os.homedir?.() || process.env.HOME || '';
    const base = snap.baseDir || path.join(home, '.routecodex', 'codex-samples');
    const ep = String(snap.endpoint || 'chat').toLowerCase();
    const group = ep.includes('responses') ? 'openai-responses' : ep.includes('messages') ? 'anthropic-messages' : 'openai-chat';
    const rid = String(snap.requestId || `req_${Date.now()}_${Math.random().toString(36).slice(2,8)}`);
    const dir = path.join(base, group, '__pending__', rid);
    const file = path.join(dir, `govern-${stage}.json`);
    if (fs.existsSync(file)) return; // 不重复
    fs.mkdirSync(dir, { recursive: true });
    const payload = JSON.stringify(data, null, 2);
    fs.writeFileSync(file, payload, 'utf-8');
  } catch { /* ignore snapshot errors */ }
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
  } catch { /* best-effort: 保持原样 */ }

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
    } catch { /* ignore */ }
    // 4) Enforce payload budget (context bytes) with minimal loss policy
    const modelId = typeof (canonical as any)?.model === 'string' ? String((canonical as any).model) : 'unknown';
    const budgeted = enforceChatBudget(canonical, modelId);
    return normalizeSpecialToolCallsOnRequest(budgeted);
  } catch { return out; }
}

/**
 * Process OpenAI Chat response (choices[0].message) with unified 标准 governance.
 * - Canonicalize structured tool_calls; ensure finish_reason and content=null policy
 */
import {
  parseLenientJsonishWithNative as parseLenient,
  repairArgumentsToStringWithNative as repairArgumentsToString
} from '../../router/virtual-router/engine-selection/native-shared-conversion-semantics.js';

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
            } catch {
              // logging best-effort
            }
          }
        } catch {
          // best-effort per tool_call
        }
      }
    }
    return out;
  } catch {
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
              } catch {
                // logging best-effort
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
              } catch {
                parsed = parseLenient(argsStr);
              }
              if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                const normalized = normalizeExecCommandArgs(parsed as Record<string, unknown>);
                const next = normalized.ok ? normalized.normalized : (parsed as Record<string, unknown>);
                try {
                  (fn as any).arguments = JSON.stringify(next ?? {});
                } catch {
                  (fn as any).arguments = '{}';
                }
              }
            }
          }
        } catch {
          // best-effort per tool_call
        }
      }
    }
    if (rewrittenNestedApplyPatchCount > 0) {
      injectNestedApplyPatchPolicyNotice(messages, rewrittenNestedApplyPatchCount);
    }
    return out;
  } catch {
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
        } catch { return s; }
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
            try { parsed = JSON.parse(repaired); } catch { parsed = parseLenient(repaired); }
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
              try { finalStr = JSON.stringify(parsed); } catch { finalStr = repaired; }
            }
          } else if (name === 'exec_command') {
            const validation = validateToolCall('exec_command', repaired, validationOptions);
            if (validation.ok && typeof validation.normalizedArgs === 'string') {
              finalStr = validation.normalizedArgs;
            } else if (!validation.ok) {
              finalStr = buildBlockedExecCommandArgs(repaired, validation.reason, validation.message);
            }
          }
          if (fn) fn.arguments = finalStr;
        } catch { /* keep original */ }
      }
      // Ensure finish_reason/tool_calls invariant if missing (idempotent with canonicalizer)
      try { if (!ch.finish_reason) ch.finish_reason = 'tool_calls'; } catch { /* ignore */ }
      try { if (msg && typeof msg === 'object' && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) msg.content = null; } catch { /* ignore */ }
    }
    return out;
  } catch { return chat; }
}

export function processChatResponseTools(resp: Unknown): Unknown {
  if (!isObject(resp)) return resp;
  try {
    const canon = normalizeChatResponseReasoningToolsWithNative(resp as any);
    const withPatch = normalizeApplyPatchToolCallsOnResponse(canon as Unknown);
    return enhanceResponseToolArguments(withPatch as Unknown);
  } catch { return resp; }
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
  } catch { /* ignore */ }
  let out = processChatResponseTools(payload);
  // 变更后快照：响应侧 canonicalize 之后
  try {
    const opts: ToolGovernanceOptions = { snapshot: ctx?.snapshot || { enabled: true, endpoint: ep, requestId: ctx?.requestId } };
    tryWriteSnapshot(opts, 'response_after_canonicalize', out as any);
  } catch { /* ignore */ }
  if (ep === 'responses' && ctx?.stream !== true && ctx?.produceRequiredAction !== false) {
    // 变更前快照：构造 required_action 之前
    try {
      const opts: ToolGovernanceOptions = { snapshot: ctx?.snapshot || { enabled: true, endpoint: ep, requestId: ctx?.requestId } };
      tryWriteSnapshot(opts, 'response_before_required_action', out as any);
    } catch { /* ignore */ }
    try {
      const { buildResponsesPayloadFromChat } = require('../responses/responses-openai-bridge.js');
      const res = buildResponsesPayloadFromChat(out, { requestId: ctx?.requestId });
      try {
        const opts: ToolGovernanceOptions = { snapshot: ctx?.snapshot || { enabled: true, endpoint: ep, requestId: ctx?.requestId } };
        tryWriteSnapshot(opts, 'response_after_required_action', res as any);
      } catch { /* ignore */ }
      return res as any;
    } catch { /* ignore mapping errors and return canonicalized chat */ }
  }
  return out;
}
