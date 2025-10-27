/**
 * Preflight validator/sanitizer for OpenAI-style chat payloads targeting specific providers.
 *
 * For GLM (Zhipu BigModel):
 * - messages.content must be string
 * - roles limited to system|user|assistant|tool (fallback to user)
 * - assistant.tool_calls.function.arguments must be a JSON string
 * - stream should be false (Workflow will re-stream if required)
 * - Optional: include tools (function calling) when feature flag enabled
 */

import type { UnknownObject } from '../../../types/common-types.js';
import { extractToolText as extractToolTextShared } from './tool-result-text.js';

export interface PreflightOptions {
  target: 'glm' | 'openai' | 'generic';
  enableTools?: boolean; // when true, retain tools for GLM; otherwise strip to minimize 1210 errors
}

export interface PreflightResult {
  payload: Record<string, unknown>;
  issues: Array<{ level: 'info' | 'warn' | 'error'; code: string; message: string; path?: string }>;
}

const ALLOWED_ROLES = new Set(['system', 'user', 'assistant', 'tool']);
// Defaults bias toward preserving information (no destructive cleanups)
// Defaults:
// - Prefer converting tool role to user for broader GLM compatibility unless explicitly enabled
// 默认开启 tool 角色支持，避免将 tool 压扁为 user 文本导致上下文缺失
const GLM_USE_TOOL_ROLE = String(process.env.RCC_GLM_USE_TOOL_ROLE || '1').trim() !== '0';
// - Keep only last assistant.tool_calls by default when stripping history
const GLM_KEEP_LAST_ASSISTANT_TOOLCALLS = String(process.env.RCC_GLM_KEEP_LAST_ASSISTANT_TOOLCALLS ?? '1').trim() === '1';
const DEFAULT_GLM_MAX_CONTEXT_TOKENS = Number(process.env.RCC_GLM_MAX_CONTEXT_TOKENS ?? 200000);
const DEFAULT_GLM_CONTEXT_SAFETY_RATIO = Number(process.env.RCC_GLM_CONTEXT_SAFETY_RATIO ?? 0.85);
const DISABLE_GLM_CONTEXT_TRIM = String(process.env.RCC_GLM_DISABLE_TRIM || '1').trim() === '1';
const DISABLE_GLM_EMPTY_USER_FILTER = String(process.env.RCC_GLM_DISABLE_EMPTY_USER_FILTER || '').trim() === '1';
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
  if (typeof text !== 'string' || !text) return '' + (text ?? '');
  let out = text;
  try {
    // Remove <think>...</think> blocks (single or multiline)
    out = out.replace(/<think>[\s\S]*?<\/think>/g, '');
    // Remove stray <think> or </think> tokens if unmatched
    out = out.replace(/<\/?think>/g, '');
    // Remove inline <tool_call>…</tool_call> blocks that some clients embed in prompts
    out = out.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '');
    out = out.replace(/<\/?tool_call>/g, '');
  } catch { /* non-blocking */ }
  return out;
}

function stringifyFunctionArguments(args: any): string {
  if (typeof args === 'string') {return args;}
  if (args === null || args === undefined) {return '{}';}
  try { return JSON.stringify(args); } catch { return String(args); }
}

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
        try { params = JSON.parse(params); } catch { issues.push({ level:'warn', code:'tools.parameters.parse', message:'parameters not valid JSON, passing as-is', path:`tools[${i}].function.parameters` }); }
      }
      if (params && typeof params !== 'object') {
        issues.push({ level:'warn', code:'tools.parameters.shape', message:'parameters must be object; dropping', path:`tools[${i}].function.parameters` });
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
      if (targetGLM && !GLM_USE_TOOL_ROLE) {
        // Convert unsupported 'tool' role to 'user' for GLM safety
        msg.role = 'user';
        // Optionally prefix with hint including tool name/id
        const prefixParts: string[] = [];
        if (typeof m?.name === 'string' && m.name.trim()) prefixParts.push(`tool:${m.name.trim()}`);
        if (typeof m?.tool_call_id === 'string' && m.tool_call_id.trim()) prefixParts.push(`id:${m.tool_call_id.trim()}`);
        const prefix = prefixParts.length ? `[${prefixParts.join(' ')}] ` : '';
        msg.content = `${prefix}${msg.content || ''}`.trim();
      } else {
        if (typeof m?.name === 'string') { msg.name = m.name; }
        if (typeof m?.tool_call_id === 'string') { msg.tool_call_id = m.tool_call_id; }
      }
    }

    // If assistant tool_calls present, ensure arguments are string; GLM expects content string anyway.
    if (role === 'assistant' && Array.isArray(m?.tool_calls) && m.tool_calls.length) {
      try {
        msg.tool_calls = m.tool_calls.map((tc: any, j: number) => {
          const fn = tc?.function || {};
          const name = typeof fn?.name === 'string' ? fn.name : undefined;
          const args = stringifyFunctionArguments(fn?.arguments);
          if (!name) {issues.push({ level:'warn', code:'tool_calls.missing_name', message:'assistant.tool_calls missing function.name', path:`messages[${idx}].tool_calls[${j}]` });}
          return { id: tc?.id, type: 'function', function: { ...(name?{name}:{ }), arguments: args } };
        });
        // GLM request schema for messages does not require tool_calls on assistant history; keep but safe-typed
      } catch (e) {
        issues.push({ level:'warn', code:'tool_calls.normalize_failed', message:String((e as Error).message || e) });
      }
    }

    return msg;
  });

  // Preserve assistant.tool_calls by default; only strip when explicitly forced
  try {
    // By default, strip assistant.tool_calls from historical messages to avoid GLM 1210
    const forceStrip = (process.env.RCC_GLM_FORCE_TOOLCALL_STRIP === '1') || (process.env.RCC_GLM_FORCE_TOOLCALL_STRIP === undefined);
    if (targetGLM && forceStrip && Array.isArray(mappedMessages) && mappedMessages.length > 0) {
      const n = mappedMessages.length;
      if (GLM_KEEP_LAST_ASSISTANT_TOOLCALLS) {
        for (let i = 0; i < n - 1; i++) {
          const mm: any = mappedMessages[i];
          if (mm && mm.role === 'assistant' && Array.isArray(mm.tool_calls)) delete mm.tool_calls;
        }
      } else {
        for (let i = 0; i < n; i++) {
          const mm: any = mappedMessages[i];
          if (mm && mm.role === 'assistant' && Array.isArray(mm.tool_calls)) delete mm.tool_calls;
        }
      }
    }
  } catch { /* non-blocking */ }

  let messages = mappedMessages.filter((msg: any, idx: number) => {
    if (DISABLE_GLM_EMPTY_USER_FILTER) { return true; }
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

  // Drop assistant messages with empty content (after tool_calls stripping) except possibly the last
  if (targetGLM && messages.length) {
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

  // Ensure first message is not assistant-only; GLM is stricter and prefers user/system leading
  try {
    if (targetGLM && messages.length > 0 && messages[0]?.role === 'assistant') {
      // Downgrade first assistant to user to satisfy parsers
      (messages[0] as any).role = 'user';
      issues.push({ level: 'warn', code: 'messages.first.assistant_to_user', message: 'Coerced first assistant to user for GLM' });
    }
  } catch { /* ignore */ }

  // Ensure last message is user for GLM safety; coerce empty to a simple prompt
  if (targetGLM && messages.length > 0) {
    const last = messages[messages.length - 1] as any;
    if (last.role !== 'user') {
      last.role = 'user';
    }
    if (typeof last.content !== 'string' || last.content.trim().length === 0) {
      last.content = (typeof last.content === 'string' ? last.content : '') || 'Continue.';
    }
  }

  if (targetGLM && messages.length && !DISABLE_GLM_CONTEXT_TRIM) {
    const safetyRatio = DEFAULT_GLM_CONTEXT_SAFETY_RATIO > 0 && DEFAULT_GLM_CONTEXT_SAFETY_RATIO < 1
      ? DEFAULT_GLM_CONTEXT_SAFETY_RATIO
      : 0.85;
    const maxTokensBudget = Math.floor(DEFAULT_GLM_MAX_CONTEXT_TOKENS * safetyRatio);
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

  // GLM 消息压缩：仅规范 content 为字符串，但保留工具相关字段（tool/tool_calls）
  if (targetGLM) {
    messages = messages.map((m: any) => {
      const base: any = { role: m.role, content: coerceStringContent(m.content) };
      // 保留 tool 角色的 name 与 tool_call_id
      if (m?.role === 'tool') {
        if (typeof m?.name === 'string') { base.name = m.name; }
        if (typeof m?.tool_call_id === 'string') { base.tool_call_id = m.tool_call_id; }
      }
      // 保留 assistant 的 tool_calls（仅在存在时）
      if (m?.role === 'assistant' && Array.isArray(m?.tool_calls) && m.tool_calls.length) {
        try {
          base.tool_calls = m.tool_calls.map((tc: any) => {
            const fn = tc?.function || {};
            const name = typeof fn?.name === 'string' ? fn.name : undefined;
            const args = stringifyFunctionArguments(fn?.arguments);
            const out: any = { type: 'function', function: { arguments: args } };
            if (tc?.id) out.id = tc.id;
            if (name) (out.function as any).name = name;
            return out;
          });
        } catch { /* 保守处理：如异常则忽略 tool_calls */ }
      }
      return base;
    });
  }

  out.messages = messages;

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
        (out as any).tools = mapped;
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
