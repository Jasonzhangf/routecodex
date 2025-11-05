/**
 * Preflight validator/sanitizer for OpenAI-style chat payloads targeting specific providers.
 *
 * GLM unified policy (RCC_GLM_POLICY):
 *   preserve (default):
 *     - keep tool role messages
 *     - do NOT strip historical assistant.tool_calls
 *     - keep empty assistant messages (to preserve structure)
 *     - convert user-side tool echo to proper tool messages
 *     - repair assistant/tool pairing when missing
 *     - do NOT force last message user, do NOT do context trim
 *   compat:
 *     - keep tool role messages（不再降级为 user 文本）
 *     - do NOT strip historical assistant.tool_calls（不再只保留最后一次）
 *     - drop empty assistant messages (except possibly last)
 *     - convert user-side tool echo to tool messages
 *     - repair assistant/tool pairing
 *     - force last message to user and enable context trimming
 */

import type { UnknownObject } from '../../../types/common-types.js';
import { extractToolText as extractToolTextShared } from './tool-result-text.js';

export interface PreflightOptions {
  target: 'glm' | 'openai' | 'generic';
  enableTools?: boolean;
}

export interface PreflightResult {
  payload: Record<string, unknown>;
  issues: Array<{ level: 'info' | 'warn' | 'error'; code: string; message: string; path?: string }>;
}

const ALLOWED_ROLES = new Set(['system', 'user', 'assistant', 'tool']);

type GLMPolicy = {
  keepToolRole: boolean;
  stripHistoricalAssistantToolCalls: boolean; // deprecated (no-op)
  keepOnlyLastAssistantToolCalls: boolean; // deprecated (no-op)
  dropEmptyAssistant: boolean;
  convertUserEchoToTool: boolean;
  repairPairing: boolean;
  ensureLastUser: boolean;
  coerceFirstAssistantToUser: boolean;
  contextTrim: boolean;
  maxContextTokens: number;
  contextSafetyRatio: number;
};

function getGLMPolicy(): GLMPolicy {
  const mode = String(process.env.RCC_GLM_POLICY || 'preserve').trim().toLowerCase();
  if (mode === 'compat') {
    return {
      keepToolRole: true,
      // 在 GLM 目标下默认剥离历史工具调用，仅保留最近一轮（避免 1210 参数错误）
      stripHistoricalAssistantToolCalls: false,
      keepOnlyLastAssistantToolCalls: false,
      dropEmptyAssistant: true,
      convertUserEchoToTool: true,
      repairPairing: false,
      ensureLastUser: true,
      coerceFirstAssistantToUser: false,
      contextTrim: true,
      maxContextTokens: Number(process.env.RCC_GLM_MAX_CONTEXT_TOKENS ?? 200000),
      contextSafetyRatio: Number(process.env.RCC_GLM_CONTEXT_SAFETY_RATIO ?? 0.85),
    };
  }
  // default: preserve
  return {
    keepToolRole: true,
    // 默认不剥离历史工具调用，保留全部历史（避免模型遗忘/循环）
    stripHistoricalAssistantToolCalls: false,
    keepOnlyLastAssistantToolCalls: false,
    dropEmptyAssistant: false,
    convertUserEchoToTool: true,
    repairPairing: false,
    ensureLastUser: false,
    coerceFirstAssistantToUser: false,
    contextTrim: false,
    maxContextTokens: Number(process.env.RCC_GLM_MAX_CONTEXT_TOKENS ?? 200000),
    contextSafetyRatio: Number(process.env.RCC_GLM_CONTEXT_SAFETY_RATIO ?? 0.85),
  };
}

const GLM_ALLOW_THINKING = String(process.env.RCC_GLM_ALLOW_THINKING || '').trim() === '1';

const estimateTokens = (text: string): number => {
  if (!text) {return 0;}
  return Math.ceil(text.length / 4);
};

const messageTokenCost = (msg: any): number => {
  let total = 0;
  if (typeof msg?.content === 'string') {
    total += estimateTokens(msg.content);
  }
  if (Array.isArray(msg?.tool_calls)) {
    for (const call of msg.tool_calls) {
      const arg = call?.function?.arguments;
      if (typeof arg === 'string') {
        total += estimateTokens(arg);
      }
    }
  }
  return total;
};

function coerceStringContent(value: any): string {
  if (typeof value === 'string') {return value;}
  if (Array.isArray(value)) {
    const text = value
      .map((p: any) => {
        if (p && typeof p === 'object') {
          if (typeof p.text === 'string') {return p.text;} // OpenAI-style {type:'text',text:'...'}
          if (typeof p.content === 'string') {return p.content;}
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
    return text;
  }
  if (value && typeof value === 'object') {
    try { return JSON.stringify(value); } catch { return String(value); }
  }
  if (value === null || value === undefined) {return '';}
  return String(value);
}

// Extract human-readable text from a tool result-like payload.
// Preference order: output -> text -> content (string) -> flattened parts -> ''
const extractToolText = extractToolTextShared;

// Remove hidden-thinking markup and tool markup hints from plain string content
function stripThinkingAndToolMarkup(text: string): string {
  if (typeof text !== 'string' || !text) {return `${  text ?? ''}`;}
  let out = text;
  try {
    // 仅移除思考标签；工具相关标记由 llmswitch-core canonicalizer 统一处理
    out = out.replace(/<think>[\s\S]*?<\/think>/g, '');
    out = out.replace(/<\/?think>/g, '');
  } catch { /* non-blocking */ }
  return out;
}

function stringifyFunctionArguments(args: any): string {
  if (typeof args === 'string') {return args;}
  if (args === null || args === undefined) {return '{}';}
  try { return JSON.stringify(args); } catch { return String(args); }
}

// 取消“用户侧工具回显→role:'tool'”的转换逻辑；保持原始角色，不再注入 rcc.tool.v1 包装

function mapToolsForGLM(raw: any, issues: PreflightResult['issues']): any[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) {return undefined;}
  const out: any[] = [];
  for (let i = 0; i < raw.length; i++) {
    const t = raw[i] as any;
    if (!t || typeof t !== 'object') {continue;}
    if (t.type === 'function' || (!t.type && t.function) || (t.name || t.parameters)) {
      // Support both Chat-shape (function:{...}) and Responses-shape (top-level name/parameters)
      const fnRaw = t.function || {};
      const topName = typeof t?.name === 'string' ? t.name : undefined;
      const topDesc = typeof t?.description === 'string' ? t.description : undefined;
      const topParams = t?.parameters;
      const name = typeof fnRaw?.name === 'string' ? fnRaw.name : topName;
      const desc = typeof fnRaw?.description === 'string' ? fnRaw.description : topDesc;
      let params = (fnRaw?.parameters !== undefined ? fnRaw.parameters : topParams);
      if (typeof params === 'string') {
        // 避免与 llmswitch-core 重复；仅记录一次 info，不强行解析
        try {
          JSON.parse(params);
          issues.push({ level:'info', code:'tools.parameters.parse-ok', message:'parameters JSON string accepted', path:`tools[${i}].function.parameters` });
        } catch {
          issues.push({ level:'info', code:'tools.parameters.parse-skip', message:'parameters not valid JSON; will defer to core normalization', path:`tools[${i}].function.parameters` });
        }
      }
      if (params && typeof params !== 'object') {
        // 不再修改/丢弃参数形状，避免拦截请求；仅记录一次提示
        issues.push({ level:'info', code:'tools.parameters.shape-skip', message:'parameters shape not object; core will handle at entry', path:`tools[${i}].function.parameters` });
        params = undefined;
      }
      out.push({ type:'function', function: { ...(name?{name}:{ }), ...(desc?{description:desc}:{ }), ...(params?{parameters:params}:{ }) } });
    } else {
      // Unknown tool type; keep only if GLM may accept, otherwise drop to avoid 1210
      issues.push({ level:'warn', code:'tools.unsupported', message:`dropping unsupported tool type ${String(t.type)}`, path:`tools[${i}].type` });
    }
  }
  return out.length ? out : undefined;
}

export function sanitizeAndValidateOpenAIChat(input: UnknownObject, opts: PreflightOptions): PreflightResult {
  const issues: PreflightResult['issues'] = [];
  const src: any = input || {};
  const targetGLM = opts.target === 'glm';

  // Hard-disable input validations and coercions by default as requested.
  // Set RCC_DISABLE_INPUT_VALIDATION=0 to re-enable the previous sanitizer.
  try {
    const DISABLE = String(process.env.RCC_DISABLE_INPUT_VALIDATION ?? '1') !== '0';
    if (DISABLE) {
      // Minimal GLM compatibility still applies to avoid upstream 1210:
      //  - Strip historical assistant.tool_calls（仅保留最近一条消息中的 tool_calls）
      //  - 清理空的/无效的 tool_calls（function.name 为空的项）
      // 其它内容保持原样透传，不做改写/校验
      let passthrough: any = {};
      try { passthrough = JSON.parse(JSON.stringify(src)); } catch { passthrough = src; }
      // GLM 目标下：不再修改历史工具调用（避免记忆缺失）。保持原样透传。
      // GLM 目标下，最小兼容：tools 也需要映射为 OpenAI function 形状，避免上游 1214
      try {
        if (targetGLM) {
          const mapped = mapToolsForGLM((passthrough as any).tools, issues);
          if (mapped && mapped.length) {
            (passthrough as any).tools = mapped;
            // GLM 仅支持 auto，工具存在时统一设置为 auto（若未显式提供）
            const choiceRaw = (passthrough as any).tool_choice;
            if (typeof choiceRaw === 'undefined') {
              (passthrough as any).tool_choice = 'auto';
            } else if (String(choiceRaw) !== 'auto') {
              (passthrough as any).tool_choice = 'auto';
            }
          } else {
            delete (passthrough as any).tools;
          }
        }
      } catch { /* ignore tools mapping errors in minimal mode */ }
      return { payload: passthrough as Record<string, unknown>, issues: [] };
    }
  } catch { /* non-blocking */ }

  const out: Record<string, unknown> = {};

  // model
  if (typeof src.model === 'string') {out.model = src.model;}
  // Preserve common top-level fields for GLM/openai targets
  if (Array.isArray(src.tools)) { out.tools = src.tools; }
  if (src.tool_choice !== undefined) { out.tool_choice = src.tool_choice; }
  if (src.response_format && typeof src.response_format === 'object' && typeof src.response_format.type === 'string') {
    out.response_format = src.response_format;
  }
  if (typeof src.temperature === 'number') { out.temperature = src.temperature; }
  if (typeof src.top_p === 'number') { out.top_p = src.top_p; }
  if (typeof src.presence_penalty === 'number') { out.presence_penalty = src.presence_penalty; }
  if (typeof src.frequency_penalty === 'number') { out.frequency_penalty = src.frequency_penalty; }
  if (typeof src.max_tokens === 'number') { out.max_tokens = src.max_tokens; }
  if (typeof src.stream === 'boolean') { out.stream = src.stream; }

  // messages
  const rawMessages = Array.isArray(src.messages) ? src.messages : [];
  const mappedMessages = rawMessages.map((m: any, idx: number) => {
    const role0 = typeof m?.role === 'string' ? m.role : 'user';
    const role = ALLOWED_ROLES.has(role0) ? role0 : 'user';
    if (role0 !== role) {issues.push({ level:'warn', code:'messages.role.coerced', message:`coerced role ${role0} -> ${role}`, path:`messages[${idx}].role` });}

    const msg: any = { role };

    // content must be string for GLM
    const c = m?.content;
    if (role === 'tool') {
      msg.content = extractToolText(c);
    } else {
      // Normalize to string then strip hidden-thinking/tool markup in compatibility layer
      const raw = coerceStringContent(c);
      msg.content = stripThinkingAndToolMarkup(raw);
    }

    // Preserve name for tool role if provided
    if (role === 'tool') {
      // 保持工具角色，不做降级改写；仅保留 name 与 tool_call_id
      if (typeof m?.name === 'string') { msg.name = m.name; }
      if (typeof m?.tool_call_id === 'string') { msg.tool_call_id = m.tool_call_id; }
    }

    // If assistant tool_calls present
    if (role === 'assistant' && Array.isArray(m?.tool_calls) && m.tool_calls.length) {
      try {
        // GLM 目标需要 arguments 为 JSON 对象；其它目标保持 OpenAI 字符串
        const parseArgumentsObject = (input: any): any => {
          if (input === null || input === undefined) {return {};}
          if (typeof input === 'object') {return input;}
          if (typeof input === 'string') {
            const s = input;
            try { return JSON.parse(s); } catch {
              // 精确修复：当上游历史中 arguments 是无法解析的 JSON 字符串时，
              // 不再丢弃为 {}，而是以 { raw: <原字符串> } 形式保留，满足 GLM 对 object 的要求，
              // 同时避免丢失原始意图，保持“保留原始数据”的一致性。
              return { raw: s };
            }
          }
          return {};
        };

        const mapped: any[] = [];
        m.tool_calls.forEach((tc: any, j: number) => {
          const fn = tc?.function || {};
          const name = typeof fn?.name === 'string' && fn.name.trim() ? fn.name.trim() : undefined;
          if (!name) {
            issues.push({ level:'warn', code:'tool_calls.missing_name', message:'assistant.tool_calls missing function.name', path:`messages[${idx}].tool_calls[${j}]` });
            // GLM 目标：丢弃无效的 tool_call，避免上游 500
            if (targetGLM) { return; }
          }
          const argsValue = targetGLM ? parseArgumentsObject(fn?.arguments) : stringifyFunctionArguments(fn?.arguments);
          const out: any = { id: tc?.id, type: 'function', function: { arguments: argsValue } };
          if (name) { out.function.name = name; }
          mapped.push(out);
        });
        if (mapped.length > 0) {
          msg.tool_calls = mapped;
          if (targetGLM) { msg.content = null; }
        } else {
          // 无有效 tool_calls，保留/恢复文本 content
          delete msg.tool_calls;
          if (targetGLM && (msg.content === null)) {
            msg.content = '';
          }
        }
      } catch (e) {
        issues.push({ level:'warn', code:'tool_calls.normalize_failed', message:String((e as Error).message || e) });
      }
    }

    return msg;
  });

  // 不再清理历史工具调用（避免记忆缺失）；保持 mappedMessages 原样

  // Chat 路径不应在预检阶段将“用户文本”转换为工具消息；该语义应由 Responses 桥接负责
  // 因此，这里不再进行“用户文本→tool 消息”的转换，原样保留 mappedMessages 顺序
  const normalizedMessages: any[] = [...mappedMessages];

  let messages = normalizedMessages.filter((msg: any, idx: number) => {
    const text = typeof msg?.content === 'string' ? msg.content.trim() : '';
    if (msg.role === 'user' && text.length === 0) {
      issues.push({
        level: 'warn',
        code: 'messages.user.empty',
        message: 'Dropped empty user message with no content',
        path: `messages[${idx}]`
      });
      return false;
    }
    return true;
  });

  // 过滤历史中由旧版兜底逻辑产生的“拒绝/不支持”类工具结果，避免造成循环与噪声。
  // 特征：role=tool 且 content 以“unsupported call:”或“工具调用不可用”开头。
  try {
    messages = messages.filter((msg: any) => {
      if (!msg || msg.role !== 'tool') {return true;}
      const c = typeof msg.content === 'string' ? msg.content.trim() : '';
      if (!c) {return true;}
      const lowered = c.toLowerCase();
      if (lowered.startsWith('unsupported call:')) {return false;}
      if (c.startsWith('工具调用不可用')) {return false;}
      return true;
    });
  } catch { /* ignore */ }

  // 可选：是否丢弃空的 assistant 消息（由策略控制）
  if (targetGLM && messages.length && getGLMPolicy().dropEmptyAssistant) {
    messages = messages.filter((msg: any, idx: number) => {
      const isAssistant = msg?.role === 'assistant';
      const isEmpty = typeof msg?.content === 'string' ? msg.content.trim().length === 0 : true;
      const isLast = idx === (messages.length - 1);
      return !(isAssistant && isEmpty && !isLast);
    });
  }

  if (!messages.length) {
    issues.push({
      level: 'error',
      code: 'messages.none',
      message: 'No messages remain after sanitization; ensure at least one user message has content.'
    });
  }

  // 不再修改用户角色：不强制首条/末条转换为 user

  if (targetGLM && messages.length && getGLMPolicy().contextTrim) {
    const policy = getGLMPolicy();
    const r = (policy.contextSafetyRatio > 0 && policy.contextSafetyRatio < 1) ? policy.contextSafetyRatio : 0.85;
    const maxTokensBudget = Math.floor((policy.maxContextTokens || 200000) * r);
    if (maxTokensBudget > 0) {
      let totalTokens = messages.reduce((sum: number, msg: any) => sum + messageTokenCost(msg), 0);
      if (totalTokens > maxTokensBudget) {
        const trimmedMessages: any[] = [];
        const startIndex = messages[0]?.role === 'system' ? 1 : 0;
        // Protect the latest message so conversation can continue
        while ((messages.length > (startIndex + 1)) && totalTokens > maxTokensBudget) {
          const removed = messages.splice(startIndex, 1)[0];
          trimmedMessages.push(removed);
          totalTokens -= messageTokenCost(removed);
        }

        // If still over budget with only [system?, last] remaining, truncate the last message content
        if (totalTokens > maxTokensBudget && messages.length > startIndex) {
          const lastIdx = messages.length - 1;
          const lastMsg = messages[lastIdx] as any;
          if (typeof lastMsg?.content === 'string' && lastMsg.content.length > 0) {
            const systemCost = (messages[0]?.role === 'system') ? messageTokenCost(messages[0]) : 0;
            // Leave a small headroom of 5%
            const allowedTokens = Math.max(0, Math.floor((maxTokensBudget - systemCost) * 0.95));
            const approxChars = Math.max(0, allowedTokens * 4);
            if (approxChars < lastMsg.content.length) {
              // Keep the beginning of the message which usually contains instructions/context
              lastMsg.content = lastMsg.content.slice(0, approxChars);
              // Recompute tokens after truncation
              totalTokens = messages.reduce((sum: number, msg: any) => sum + messageTokenCost(msg), 0);
              issues.push({
                level: 'warn',
                code: 'messages.last.truncated',
                message: `Truncated last message to fit context budget (allowedTokens=${allowedTokens}).`,
                path: `messages[${lastIdx}].content`
              });
            }
          }
        }

        if (trimmedMessages.length) {
          issues.push({
            level: 'warn',
            code: 'messages.trimmed',
            message: `Trimmed ${trimmedMessages.length} oldest message(s) to maintain 15% safety margin`,
            path: 'messages'
          });
        }
      }
    }
  }

  // GLM 消息压缩：规范 content 为字符串，按策略保留/降级 tool 角色、处理 tool_calls
  if (targetGLM) {
    // 不再过滤 role:'tool'（避免破坏工具配对与记忆）
    messages = messages.map((m: any) => {
      const base: any = { role: m.role, content: coerceStringContent(m.content) };
      // 保留 tool 角色的 name 与 tool_call_id
      if (m?.role === 'tool') {
        if (typeof m?.name === 'string') { base.name = m.name; }
        if (typeof m?.tool_call_id === 'string') { base.tool_call_id = m.tool_call_id; }
        // 不再封装为 rcc.tool.v1，保持纯文本结果，避免污染与放大上下文
        base.content = coerceStringContent(m.content);
      }
      // 保留 assistant 的 tool_calls（仅在存在时）；GLM 目标下 arguments 为对象，且 content=null
      if (m?.role === 'assistant' && Array.isArray(m?.tool_calls) && m.tool_calls.length) {
        try {
          const isImagePath = (p: any): boolean => {
            const s = typeof p === 'string' ? p : '';
            return /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(s);
          };
          base.tool_calls = m.tool_calls.map((tc: any) => {
            const fn = tc?.function || {};
            const name = typeof fn?.name === 'string' ? fn.name : undefined;
            const args = targetGLM
              ? ((): any => {
                  if (fn?.arguments === null || fn?.arguments === undefined) {return {};}
                  if (typeof fn?.arguments === 'object') {return fn.arguments;}
                  if (typeof fn?.arguments === 'string') {
                    try { return JSON.parse(fn.arguments); } catch { return {}; }
                  }
                  return {};
                })()
              : stringifyFunctionArguments(fn?.arguments);
            const out: any = { type: 'function', function: { arguments: args } };
            if (tc?.id) {out.id = tc.id;}
            if (name) {(out.function as any).name = name;}
            return out;
          }).filter((entry: any) => {
            // Guard: drop view_image for non-image paths to avoid misclassification
            try {
              if (entry?.function?.name === 'view_image') {
                const a = entry?.function?.arguments;
                const pathVal = (targetGLM ? a?.path : ((): any => { try { return JSON.parse(a).path; } catch { return undefined; } })());
                if (!isImagePath(pathVal)) {return false;}
              }
            } catch { /* ignore */ }
            return true;
          });
          if (targetGLM) { base.content = null; }
        } catch { /* 保守处理：如异常则忽略 tool_calls */ }
      }
      return base;
    });

    // 不做“配对修复”（不合成 assistant.tool_calls），避免兜底与臆测；仅依赖客户端/模型生成的调用
  }

  // 过滤无意义的空消息（GLM 目标下）：content 为空/空串且无 tool_calls 的 assistant/user
  const filteredMessages = (() => {
    if (!targetGLM) {return messages;}
    try {
      return (messages as any[]).filter((mm: any) => {
        if (!mm || typeof mm !== 'object') {return false;}
        const role = mm.role;
        const hasToolCalls = Array.isArray(mm.tool_calls) && mm.tool_calls.length > 0;
        if (role === 'assistant' || role === 'user') {
          const c = mm.content;
          const emptyText = (c === '' || c === undefined || c === null);
          if (emptyText && !hasToolCalls) {return false;}
        }
        return true;
      });
    } catch { return messages; }
  })();

  out.messages = filteredMessages;

  // Sampling & limits
  if (typeof src.temperature === 'number') {out.temperature = src.temperature;}
  if (typeof src.top_p === 'number') {out.top_p = src.top_p;}
  if (typeof src.max_tokens === 'number') {out.max_tokens = src.max_tokens;}

  // Thinking payload passthrough (GLM opt-in only)
  if (src.thinking && typeof src.thinking === 'object') {
    if (!targetGLM || GLM_ALLOW_THINKING) {
      out.thinking = src.thinking;
    }
  }

  // Tools
  if (targetGLM) {
    // Enable tools by default for GLM; can be disabled via env RCC_GLM_FEATURE_TOOLS=0
    const enableTools = opts.enableTools ?? (process.env.RCC_GLM_FEATURE_TOOLS !== '0');
    if (enableTools) {
      const mapped = mapToolsForGLM(src.tools, issues);
      if (mapped && mapped.length) {
      // 不回写 mapped，保持原始 tools 以避免与核心入口重复处理
        if (typeof src.tool_choice !== 'undefined') {
          const choice = typeof src.tool_choice === 'string' ? src.tool_choice : 'auto';
          if (choice !== 'auto') {
            issues.push({ level:'warn', code:'tool_choice.coerced', message:`GLM only supports 'auto'; coerced ${String(src.tool_choice)} -> 'auto'`, path:'tool_choice' });
          }
          (out as any).tool_choice = 'auto';
        } else {
          (out as any).tool_choice = 'auto';
        }
      }
    }
    // Streaming support for GLM: preserve client's stream flag (default false)
    (out as any).stream = typeof src.stream === 'boolean' ? Boolean(src.stream) : false;
  } else {
    // For non-GLM targets, preserve stream flag if provided
    if (typeof src.stream === 'boolean') {(out as any).stream = src.stream;}
  }

  return { payload: out, issues };
}

export default {
  sanitizeAndValidateOpenAIChat,
};
