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
  stripHistoricalAssistantToolCalls: boolean;
  keepOnlyLastAssistantToolCalls: boolean;
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
      stripHistoricalAssistantToolCalls: true,
      keepOnlyLastAssistantToolCalls: true,
      dropEmptyAssistant: true,
      convertUserEchoToTool: true,
      repairPairing: true,
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
    // 默认也开启历史工具调用剥离，仅保留最近一轮
    stripHistoricalAssistantToolCalls: true,
    keepOnlyLastAssistantToolCalls: true,
    dropEmptyAssistant: false,
    convertUserEchoToTool: true,
    repairPairing: true,
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

// Detect user-side tool echo that was injected as plain text (should not be sent upstream to GLM)
function isToolEchoUserText(text: string): boolean {
  try {
    if (typeof text !== 'string') return false;
    const t = text.trim();
    if (t.startsWith('[id:call_')) return true; // treat any explicit call-id echo as tool echo
    const lower = t.toLowerCase();
    // Typical parse error echo
    if (lower.includes('failed to parse function arguments')) return true;
    // Heuristic for ls -la style listing echoed as user content
    // Look for a leading [id:call_*] followed by common listing tokens
    const body = t.includes(']') ? t.slice(t.indexOf(']') + 1) : t;
    const hasTotal = /\btotal\s+\d+/i.test(body);
    const hasPermLine = /^(drwx|\-rw\-|\-rwx|\-r--|\-rw\+|drwxr)/mi.test(body);
    if (hasTotal || hasPermLine) return true;
  } catch { /* ignore */ }
  return false;
}

function convertToolEchoUserToToolMessage(text: string): { role: 'tool'; content: string; tool_call_id?: string } | null {
  try {
    const t = String(text || '').trim();
    let callId: string | undefined;
    let body = t;
  const m = t.match(/^\s*\[id:([^\]]+)\]\s*(.*)$/);
    if (m) {
      callId = m[1].trim();
      body = m[2] || '';
    }
  // Produce unified rcc.tool.v1 envelope (best-effort; only output text available here)
  const envelope = {
      version: 'rcc.tool.v1',
      tool: { name: 'tool', call_id: callId || null },
      arguments: {},
      executed: { command: [] as string[] },
      result: { output: body }
    } as Record<string, unknown>;
    let content = '';
    try { content = JSON.stringify(envelope); } catch { content = body; }
    const msg: any = { role: 'tool', content };
    if (callId) msg.tool_call_id = callId;
    return msg;
  } catch {
    return null;
  }
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
      if (targetGLM && Array.isArray(passthrough?.messages)) {
        try {
          const msgs: any[] = passthrough.messages as any[];
          // 找到最后一条包含 tool_calls 的 assistant 消息索引
          let lastAssistantWithCalls = -1;
          for (let i = msgs.length - 1; i >= 0; i--) {
            const m = msgs[i];
            if (m && m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
              lastAssistantWithCalls = i; break;
            }
          }
          // 处理所有 assistant 消息：
          for (let i = 0; i < msgs.length; i++) {
            const m = msgs[i];
            if (!m || m.role !== 'assistant') continue;
            if (!Array.isArray(m.tool_calls)) continue;
            // 过滤无效的 tool_calls（name 为空/缺失）
            m.tool_calls = m.tool_calls.filter((tc: any) => {
              const nm = (tc?.function?.name ?? '').toString().trim();
              return nm.length > 0;
            });
            // 非最后一条包含调用的 assistant，清理其剩余的 tool_calls
            if (i !== lastAssistantWithCalls && m.tool_calls.length) {
              delete m.tool_calls;
            }
            // 若清理后变成空数组，则直接删除该字段（避免发送空数组触发上游 500/1210）
            if (Array.isArray(m.tool_calls) && m.tool_calls.length === 0) {
              delete m.tool_calls;
            }
          }
          // 删除空的 user/assistant 消息（content 为空或仅空白，且无 tool_calls）
          const filtered: any[] = [];
          for (const m of msgs) {
            if (!m || typeof m !== 'object') continue;
            const role = String(m.role || '').toLowerCase();
            const hasCalls = Array.isArray(m.tool_calls) && m.tool_calls.length > 0;
            const contentStr = (typeof m.content === 'string') ? m.content.trim() : '';
            if ((role === 'user' || role === 'assistant') && !hasCalls && contentStr.length === 0) {
              // drop
              continue;
            }
            filtered.push(m);
          }
          (passthrough as any).messages = filtered;
        } catch { /* 保守处理，出错则完全透传 */ }
      }
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
      if (targetGLM && !getGLMPolicy().keepToolRole) {
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

    // If assistant tool_calls present
    if (role === 'assistant' && Array.isArray(m?.tool_calls) && m.tool_calls.length) {
      try {
        // GLM 目标需要 arguments 为 JSON 对象；其它目标保持 OpenAI 字符串
        const parseArgumentsObject = (input: any): any => {
          if (input === null || input === undefined) return {};
          if (typeof input === 'object') return input;
          if (typeof input === 'string') {
            try { return JSON.parse(input); } catch { return {}; }
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

  // Preserve assistant.tool_calls by default; only strip when explicitly forced
  try {
    const policy = getGLMPolicy();
    if (targetGLM && policy.stripHistoricalAssistantToolCalls && Array.isArray(mappedMessages) && mappedMessages.length > 0) {
      const n = mappedMessages.length;
      if (policy.keepOnlyLastAssistantToolCalls) {
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

  // Convert user-side tool echo texts into proper tool messages to preserve history without polluting user turns
  let normalizedMessages: any[] = [];
  for (let i = 0; i < mappedMessages.length; i++) {
    const msg = mappedMessages[i];
    if (msg?.role === 'user' && typeof msg?.content === 'string' && isToolEchoUserText(msg.content)) {
      const converted = convertToolEchoUserToToolMessage(msg.content);
      if (converted) {
        issues.push({ level: 'info', code: 'messages.user.toolecho_converted', message: 'Converted user tool echo to tool message', path: `messages[${i}]` });
        normalizedMessages.push(converted);
        continue;
      }
    }
    normalizedMessages.push(msg);
  }

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
    // 过滤掉 tool 角色（策略: keepToolRole=false）
    if (!getGLMPolicy().keepToolRole) {
      messages = messages.filter((m: any) => m?.role !== 'tool');
    }
    messages = messages.map((m: any) => {
      const base: any = { role: m.role, content: coerceStringContent(m.content) };
      // 保留 tool 角色的 name 与 tool_call_id
      if (m?.role === 'tool') {
        if (typeof m?.name === 'string') { base.name = m.name; }
        if (typeof m?.tool_call_id === 'string') { base.tool_call_id = m.tool_call_id; }
        // 规范化工具结果为 JSON 字符串内容
        try {
          const raw = coerceStringContent(m.content);
          let parsed: any = null;
          try { parsed = JSON.parse(raw); } catch { parsed = null; }
          const envelope = parsed && typeof parsed === 'object'
            ? parsed
            : {
                version: 'rcc.tool.v1',
                tool: { name: base.name || null, call_id: base.tool_call_id || null },
                result: { output: raw }
              };
          base.content = JSON.stringify(envelope);
        } catch { /* 若封装失败则保留原字符串 */ }
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
                  if (fn?.arguments === null || fn?.arguments === undefined) return {};
                  if (typeof fn?.arguments === 'object') return fn.arguments;
                  if (typeof fn?.arguments === 'string') {
                    try { return JSON.parse(fn.arguments); } catch { return {}; }
                  }
                  return {};
                })()
              : stringifyFunctionArguments(fn?.arguments);
            const out: any = { type: 'function', function: { arguments: args } };
            if (tc?.id) out.id = tc.id;
            if (name) (out.function as any).name = name;
            return out;
          }).filter((entry: any) => {
            // Guard: drop view_image for non-image paths to avoid misclassification
            try {
              if (entry?.function?.name === 'view_image') {
                const a = entry?.function?.arguments;
                const pathVal = (targetGLM ? a?.path : ((): any => { try { return JSON.parse(a).path; } catch { return undefined; } })());
                if (!isImagePath(pathVal)) return false;
              }
            } catch { /* ignore */ }
            return true;
          });
          if (targetGLM) { base.content = null; }
        } catch { /* 保守处理：如异常则忽略 tool_calls */ }
      }
      return base;
    });

    // 配对修复：若存在 tool 消息但缺少对应的 assistant.tool_calls，则在其前插入一条合成的 assistant 调用
    // GLM 目标下禁用该修复，避免生成 name 占位且 arguments 字符串的非法调用
    try {
      if (targetGLM || !getGLMPolicy().repairPairing) { /* skip on GLM */ } else {
        const paired = new Set<string>();
        const hasAssistantCall = (id: string): boolean => messages.some((x: any) => x?.role === 'assistant' && Array.isArray(x?.tool_calls) && x.tool_calls.some((tc: any) => String(tc?.id || '') === id));
        for (let i = 0; i < messages.length; i++) {
          const msg: any = messages[i];
          if (msg?.role !== 'tool') continue;
          const callId = typeof msg?.tool_call_id === 'string' ? msg.tool_call_id : undefined;
          if (!callId || paired.has(callId)) continue;
          if (!hasAssistantCall(callId)) {
            let name = 'tool';
            let args = '{}';
            try {
              const raw = String(msg?.content || '');
              const parsed = JSON.parse(raw);
              if (parsed && typeof parsed === 'object') {
                const t = (parsed as any).tool;
                if (t && typeof t.name === 'string' && t.name.trim()) name = t.name.trim();
                const a = (parsed as any).arguments;
                if (a && typeof a === 'object') { try { args = JSON.stringify(a); } catch { args = '{}'; } }
              }
            } catch { /* ignore */ }
            const assistantCall = { role: 'assistant', content: null as any, tool_calls: [ { id: callId, type: 'function', function: { name, arguments: args } } ] };
            messages.splice(i, 0, assistantCall);
            i++; // skip over inserted assistant
          }
          paired.add(callId);
        }
      }
    } catch { /* non-blocking */ }
  }

  // 过滤无意义的空消息（GLM 目标下）：content 为空/空串且无 tool_calls 的 assistant/user
  const filteredMessages = (() => {
    if (!targetGLM) return messages;
    try {
      return (messages as any[]).filter((mm: any) => {
        if (!mm || typeof mm !== 'object') return false;
        const role = mm.role;
        const hasToolCalls = Array.isArray(mm.tool_calls) && mm.tool_calls.length > 0;
        if (role === 'assistant' || role === 'user') {
          const c = mm.content;
          const emptyText = (c === '' || c === undefined || c === null);
          if (emptyText && !hasToolCalls) return false;
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
