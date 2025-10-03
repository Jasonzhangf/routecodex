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

export interface PreflightOptions {
  target: 'glm' | 'openai' | 'generic';
  enableTools?: boolean; // when true, retain tools for GLM; otherwise strip to minimize 1210 errors
}

export interface PreflightResult {
  payload: Record<string, unknown>;
  issues: Array<{ level: 'info' | 'warn' | 'error'; code: string; message: string; path?: string }>;
}

const ALLOWED_ROLES = new Set(['system', 'user', 'assistant', 'tool']);
const DEFAULT_GLM_MAX_CONTEXT_TOKENS = Number(process.env.RCC_GLM_MAX_CONTEXT_TOKENS ?? 200000);
const DEFAULT_GLM_CONTEXT_SAFETY_RATIO = Number(process.env.RCC_GLM_CONTEXT_SAFETY_RATIO ?? 0.85);
const DISABLE_GLM_CONTEXT_TRIM = String(process.env.RCC_GLM_DISABLE_TRIM || '').trim() === '1';
const DISABLE_GLM_EMPTY_USER_FILTER = String(process.env.RCC_GLM_DISABLE_EMPTY_USER_FILTER || '').trim() === '1';

const estimateTokens = (text: string): number => {
  if (!text) return 0;
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

function coerceStringContent(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    const text = value
      .map((p: any) => {
        if (p && typeof p === 'object') {
          if (typeof p.text === 'string') return p.text; // OpenAI-style {type:'text',text:'...'}
          if (typeof p.content === 'string') return p.content;
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
  if (value == null) return '';
  return String(value);
}

function stringifyFunctionArguments(args: unknown): string {
  if (typeof args === 'string') return args;
  if (args == null) return '{}';
  try { return JSON.stringify(args); } catch { return String(args); }
}

function mapToolsForGLM(raw: unknown, issues: PreflightResult['issues']): unknown[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const out: unknown[] = [];
  for (let i = 0; i < raw.length; i++) {
    const t = raw[i] as any;
    if (!t || typeof t !== 'object') continue;
    if (t.type === 'function' || (!t.type && t.function)) {
      const fn = t.function || {};
      const name = typeof fn?.name === 'string' ? fn.name : undefined;
      const desc = typeof fn?.description === 'string' ? fn.description : undefined;
      let params = fn?.parameters;
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
  if (typeof src.model === 'string') out.model = src.model;

  // messages
  const rawMessages = Array.isArray(src.messages) ? src.messages : [];
  const mappedMessages = rawMessages.map((m: any, idx: number) => {
    const role0 = typeof m?.role === 'string' ? m.role : 'user';
    const role = ALLOWED_ROLES.has(role0) ? role0 : 'user';
    if (role0 !== role) issues.push({ level:'warn', code:'messages.role.coerced', message:`coerced role ${role0} -> ${role}`, path:`messages[${idx}].role` });

    const msg: any = { role };

    // content must be string for GLM
    const c = m?.content;
    msg.content = coerceStringContent(c);

    // Preserve name for tool role if provided
    if (role === 'tool' && typeof m?.name === 'string') {
      msg.name = m.name;
    }
    if (role === 'tool' && typeof m?.tool_call_id === 'string') {
      msg.tool_call_id = m.tool_call_id;
    }

    // If assistant tool_calls present, ensure arguments are string; GLM expects content string anyway.
    if (role === 'assistant' && Array.isArray(m?.tool_calls) && m.tool_calls.length) {
      try {
        msg.tool_calls = m.tool_calls.map((tc: any, j: number) => {
          const fn = tc?.function || {};
          const name = typeof fn?.name === 'string' ? fn.name : undefined;
          const args = stringifyFunctionArguments(fn?.arguments);
          if (!name) issues.push({ level:'warn', code:'tool_calls.missing_name', message:'assistant.tool_calls missing function.name', path:`messages[${idx}].tool_calls[${j}]` });
          return { id: tc?.id, type: 'function', function: { ...(name?{name}:{ }), arguments: args } };
        });
        // GLM request schema for messages does not require tool_calls on assistant history; keep but safe-typed
      } catch (e) {
        issues.push({ level:'warn', code:'tool_calls.normalize_failed', message:String((e as Error).message || e) });
      }
    }

    return msg;
  });

  const messages = mappedMessages.filter((msg: any, idx: number) => {
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

  if (!messages.length) {
    issues.push({
      level: 'error',
      code: 'messages.none',
      message: 'No messages remain after sanitization; ensure at least one user message has content.'
    });
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
        while (messages.length > startIndex && totalTokens > maxTokensBudget) {
          const removed = messages.splice(startIndex, 1)[0];
          trimmedMessages.push(removed);
          totalTokens -= messageTokenCost(removed);
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

  out.messages = messages;

  // Sampling & limits
  if (typeof src.temperature === 'number') out.temperature = src.temperature;
  if (typeof src.top_p === 'number') out.top_p = src.top_p;
  if (typeof src.max_tokens === 'number') out.max_tokens = src.max_tokens;

  // Thinking payload passthrough
  if (src.thinking && typeof src.thinking === 'object') out.thinking = src.thinking;

  // Tools
  if (targetGLM) {
    // Enable tools by default for GLM; can be disabled via flag
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
    // Always force non-stream to avoid upstream SSE differences; Workflow re-streams.
    (out as any).stream = false;
  } else {
    // For non-GLM targets, preserve stream flag if provided
    if (typeof src.stream === 'boolean') (out as any).stream = src.stream;
  }

  return { payload: out, issues };
}

export default {
  sanitizeAndValidateOpenAIChat,
};
