import { extractXMLToolCallsFromText, extractApplyPatchCallsFromText, extractExecuteBlocksFromText } from './text-markup-normalizer.js';
import { validateToolCall } from '../../tools/tool-registry.js';

type Unknown = Record<string, unknown>;

function isObject(v: unknown): v is Unknown {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function normalizeKey(raw: string): string {
  try {
    const t = String(raw || '').trim();
    if (!t) return '';
    const m = t.match(/([A-Za-z_][A-Za-z0-9_]*)$/);
    return m ? m[1] : t;
  } catch { return String(raw || ''); }
}

function dedupeAdjacentToolCalls(msg: Record<string, unknown>): void {
  try {
    const calls = Array.isArray((msg as any).tool_calls) ? ((msg as any).tool_calls as any[]) : [];
    if (calls.length <= 1) return;
    const filtered: any[] = [];
    const sameKey = (a: any, b: any) => {
      const aid = String(a?.id || '').trim();
      const bid = String(b?.id || '').trim();
      if (aid && bid) return aid === bid; // 统一标准：优先以 id 去重
      const an = String(a?.function?.name || '').trim();
      const bn = String(b?.function?.name || '').trim();
      const aa = typeof a?.function?.arguments === 'string' ? a.function.arguments : JSON.stringify(a?.function?.arguments ?? '');
      const ba = typeof b?.function?.arguments === 'string' ? b.function.arguments : JSON.stringify(b?.function?.arguments ?? '');
      return an === bn && aa === ba;
    };
    for (const c of calls) {
      const prev = filtered.length ? filtered[filtered.length - 1] : null;
      if (prev && sameKey(prev, c)) continue;
      filtered.push(c);
    }
    (msg as any).tool_calls = filtered;
  } catch { /* ignore */ }
}

function tryParseJson(s: string): any | null {
  try { return JSON.parse(s); } catch { return null; }
}

function inferFunctionNameFromArgs(args: unknown): string | null {
  try {
    let argStr = '';
    if (typeof args === 'string') { argStr = args; }
    else if (args && typeof args === 'object') { argStr = JSON.stringify(args); }
    else { argStr = String(args ?? ''); }
    const lower = argStr.toLowerCase();

    if (/\*\*\*\s*begin\s*patch[\s\S]*\*\*\*\s*end\s*patch/i.test(argStr)) { return 'apply_patch'; }
    if (/"command"\s*:\s*\[/.test(argStr) || /bash\s*-lc/.test(lower)) { return 'shell'; }
    const obj = tryParseJson(argStr);
    if (obj && typeof obj === 'object') {
      if (Array.isArray((obj as any).command) || typeof (obj as any).command === 'string') return 'shell';
      if (Array.isArray((obj as any).steps) && (obj as any).steps.some((s: any) => typeof s?.status === 'string')) return 'update_plan';
      const p = (obj as any).path || (obj as any).image || (obj as any).file;
      if (typeof p === 'string' && /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(p)) return 'view_image';
      const hasServer = typeof (obj as any).server === 'string';
      const hasUri = typeof (obj as any).uri === 'string';
      if (hasServer && hasUri) return 'read_mcp_resource';
      if (hasServer && (obj as any).cursor !== undefined) return 'list_mcp_resources';
    }
    return null;
  } catch { return null; }
}

function removeIntentBlocks(text: string): string {
  try {
    let out = String(text);
    // Remove XML <tool_call> ... </tool_call>
    out = out.replace(/<tool_call[\s\S]*?<\/tool_call>\s*/gi, '');
    // Remove unified diff patch blocks
    out = out.replace(/\*\*\*\s*Begin\s*Patch[\s\S]*?\*\*\*\s*End\s*Patch\s*/gi, '');
    // Remove <function=execute> blocks
    out = out.replace(/<function=execute>[\s\S]*?<\/function>\s*/gi, '');
    // Remove loose XML variant: function-name line followed by one or more arg_key/arg_value pairs
    out = out.replace(/(?:^|\n)[ \t]*[a-zA-Z0-9_\-\.]{2,}[ \t]*\n(?:[ \t]*<\s*arg_key\s*>[\s\S]*?<\/\s*arg_key\s*>\s*<\s*arg_value\s*>[\s\S]*?<\/\s*arg_value\s*>\s*)+/gi, '');
    return out;
  } catch { return text; }
}

// Remove thinking/thought markup while preserving inner text
function stripThinkingTagsPreserve(text: string): string {
  try {
    if (typeof text !== 'string' || !text) return `${text ?? ''}`;
    let out = String(text);
    // XML-like tags
    out = out.replace(/<\s*think\s*>/gi, '');
    out = out.replace(/<\s*\/\s*think\s*>/gi, '');
    out = out.replace(/<\s*thinking\s*>/gi, '');
    out = out.replace(/<\s*\/\s*thinking\s*>/gi, '');
    // Fenced code blocks: ```thinking ... ``` → keep inner
    out = out.replace(/```\s*(thinking|reasoning)\s*\n([\s\S]*?)\n```/gi, (_m, _tag, inner) => inner || '');
    // Bracket tags: [THINKING]...[/THINKING]
    out = out.replace(/\[\s*(THINKING|REASONING)\s*\]([\s\S]*?)\[\s*\/\s*(THINKING|REASONING)\s*\]/gi, (_m, _a, inner) => inner || '');
    return out;
  } catch {
    return text;
  }
}

function normalizeAssistantMessage(message: Record<string, unknown>): Record<string, unknown> {
  try {
    if (!message || typeof message !== 'object') return message;
    const msg: any = { ...(message as any) };
    // 统一标准：默认不从 reasoning_content 收割文本化工具意图（可用 RCC_TEXT_MARKUP_COMPAT=1 临时开启）
    // 文本化收割默认关闭（移除 rcc.tool.v1 相关逻辑）；若将来启用，仅处理 XML/patch/execute 类标记
    try {
      const allowTextual = String((process as any)?.env?.RCC_TEXT_MARKUP_COMPAT ?? '1').trim() !== '0';
      if (allowTextual && typeof msg.reasoning_content === 'string' && msg.reasoning_content.trim().length) {
        const rc = String(msg.reasoning_content);
        let calls = (
          extractXMLToolCallsFromText(rc) ||
          extractApplyPatchCallsFromText(rc) ||
          extractExecuteBlocksFromText(rc)
        ) || [];
        // Loose fallback for half-residual XML blocks: infer name from keys if missing preceding function line
        if ((!calls || calls.length === 0) && /<\s*arg_key\s*>/i.test(rc)) {
          try {
            const argPairs = Array.from(rc.matchAll(/<\s*arg_key\s*>\s*([^<]+?)\s*<\/\s*arg_key\s*>\s*<\s*arg_value\s*>\s*([\s\S]*?)\s*<\/\s*arg_value\s*>/gi));
            if (argPairs.length) {
              const args: Record<string, unknown> = {};
              for (const mm of argPairs as any[]) {
                const m: any = mm;
                const k = (m[1] || '').trim(); let vRaw = (m[2] || '').trim(); let v: unknown = vRaw;
                if ((vRaw.startsWith('[') && vRaw.endsWith(']')) || (vRaw.startsWith('{') && vRaw.endsWith('}'))) { try { v = JSON.parse(vRaw); } catch { v = vRaw; } }
                (args as any)[normalizeKey(k)] = v;
              }
              let inferred = '';
              const keys = Object.keys(args);
              if (keys.includes('command')) inferred = 'shell';
              else if (keys.includes('patch')) inferred = 'apply_patch';
              else if (keys.includes('plan')) inferred = 'update_plan';
              else if (keys.includes('path')) inferred = 'view_image';
              if (inferred) {
                try {
                  if (inferred === 'view_image') { const p = (args as any).path; if (typeof p !== 'string' || !/\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(p)) inferred = ''; }
                } catch { /* ignore */ }
              }
              if (inferred) {
                const argStr = JSON.stringify(args);
                calls = [{ id: `call_${Math.random().toString(36).slice(2,10)}`, name: inferred, args: argStr }];
              }
            }
          } catch { /* ignore */ }
        }
        if (calls.length) {
          const existing = Array.isArray(msg.tool_calls) ? (msg.tool_calls as any[]) : [];
          msg.tool_calls = existing.concat(calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.args } })));
        }
        // 先移除工具意图包裹（不删除正文），再移除思考标签外壳，保留文本
        msg.reasoning_content = stripThinkingTagsPreserve(removeIntentBlocks(rc));
      }
    } catch { /* ignore */ }
    // If already structured, ensure proper JSON argument handling and dedupe
    if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
      msg.tool_calls = msg.tool_calls.map((tc: any) => {
        const fn = (tc && typeof tc.function === 'object') ? tc.function : {};
        let args = (fn as any).arguments;
        let argStr: string;

        // Enhanced argument parsing for GLM compatibility
        if (typeof args === 'string') {
          // If it's already a string, ensure it's valid JSON
          try {
            // Try to parse to validate, then re-stringify to ensure consistency
            const parsed = JSON.parse(args);
            argStr = JSON.stringify(parsed);
          } catch (error) {
            // If parsing fails, it might be double-encoded or malformed
            try {
              // Try parsing again (double-encoded case)
              const doubleParsed = JSON.parse(JSON.parse(args));
              argStr = JSON.stringify(doubleParsed);
            } catch (secondError) {
              // If still fails, treat as malformed but preserve
              argStr = args;
              console.warn(`LLMSwitch-Core: 工具调用参数解析失败，保持原样: ${args.substring(0, 100)}...`);
            }
          }
        } else if (args && typeof args === 'object') {
          try { argStr = JSON.stringify(args); }
          catch { argStr = '{}'; console.warn(`LLMSwitch-Core: 工具调用参数对象序列化失败，使用空对象`); }
        } else { argStr = '{}'; }

        // Infer name only when high-confidence features are present
        const rawName = typeof (fn as any).name === 'string' ? String((fn as any).name).trim() : '';
        if (!rawName) {
          const inferred = inferFunctionNameFromArgs(argStr);
          if (inferred) { (fn as any).name = inferred; }
        }
        // Ensure type when function exists
        if (!tc?.type && fn) { tc.type = 'function'; }

        return { id: tc?.id, type: 'function', function: { name: String((fn as any).name || ''), arguments: argStr } };
      });
      // 标准 validation: drop invalid tool calls, normalize args when available
      try {
        const kept: any[] = [];
        for (const tc of (msg.tool_calls as any[])) {
          try {
            const rawNm = String(tc?.function?.name || '').trim();
            const argStr = typeof tc?.function?.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc?.function?.arguments ?? {});
            const nm = rawNm || (inferFunctionNameFromArgs(argStr) || '');
            const v = validateToolCall(nm, argStr);
            if (!v.ok) continue;
            const norm = (typeof v.normalizedArgs === 'string') ? v.normalizedArgs : argStr;
            kept.push({ id: tc?.id, type: 'function', function: { name: nm, arguments: norm } });
          } catch { kept.push(tc); }
        }
        (msg as any).tool_calls = kept;
      } catch { /* ignore */ }
      dedupeAdjacentToolCalls(msg);
      return msg;
    }
    // Final pass: dedupe adjacent identical tool_calls (统一标准)
    dedupeAdjacentToolCalls(msg);
    let text = typeof msg.content === 'string' ? msg.content : null;
    if (!text) return message;
    // rcc.tool.v1 清洗逻辑已移除；仅按允许的文本标记进行识别
    // 文本化收割默认开启；如需临时关闭，设 RCC_TEXT_MARKUP_COMPAT=0
    try {
      const allowTextual = String((process as any)?.env?.RCC_TEXT_MARKUP_COMPAT ?? '1').trim() !== '0';
      if (allowTextual) {
        let calls = (
          extractXMLToolCallsFromText(text) ||
          extractApplyPatchCallsFromText(text) ||
          extractExecuteBlocksFromText(text)
        );
        if ((!calls || calls.length === 0) && /<\s*arg_key\s*>/i.test(text)) {
          try {
            const argPairs = Array.from(text.matchAll(/<\s*arg_key\s*>\s*([^<]+?)\s*<\/\s*arg_key\s*>\s*<\s*arg_value\s*>\s*([\s\S]*?)\s*<\/\s*arg_value\s*>/gi));
            if (argPairs.length) {
              const args: Record<string, unknown> = {};
              for (const mm of argPairs as any[]) {
                const m: any = mm;
                const k = (m[1] || '').trim(); let vRaw = (m[2] || '').trim(); let v: unknown = vRaw;
                if ((vRaw.startsWith('[') && vRaw.endsWith(']')) || (vRaw.startsWith('{') && vRaw.endsWith('}'))) { try { v = JSON.parse(vRaw); } catch { v = vRaw; } }
                (args as any)[normalizeKey(k)] = v;
              }
              let inferred = '';
              const keys = Object.keys(args);
              if (keys.includes('command')) inferred = 'shell';
              else if (keys.includes('patch')) inferred = 'apply_patch';
              else if (keys.includes('plan')) inferred = 'update_plan';
              else if (keys.includes('path')) inferred = 'view_image';
              if (inferred) {
                try {
                  if (inferred === 'view_image') { const p = (args as any).path; if (typeof p !== 'string' || !/\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(p)) inferred = ''; }
                } catch { /* ignore */ }
              }
              if (inferred) {
                const argStr = JSON.stringify(args);
                calls = [{ id: `call_${Math.random().toString(36).slice(2,10)}`, name: inferred, args: argStr }];
              }
            }
          } catch { /* ignore */ }
        }
        if (calls && calls.length) {
          let tcs = calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.args } }));
          // Validate & normalize
          try {
            const kept: any[] = [];
            for (const tc of tcs) {
              try {
                const rawNm = String(tc?.function?.name || '').trim();
                const argStr = typeof tc?.function?.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc?.function?.arguments ?? {});
                const nm = rawNm || (inferFunctionNameFromArgs(argStr) || '');
                const v = validateToolCall(nm, argStr);
                if (!v.ok) continue;
                const norm = (typeof v.normalizedArgs === 'string') ? v.normalizedArgs : argStr;
                kept.push({ id: tc?.id, type: 'function', function: { name: nm, arguments: norm } });
              } catch { kept.push(tc); }
            }
            tcs = kept;
          } catch { /* ignore */ }
          (msg as any).tool_calls = tcs;
          (msg as any).content = '';
          dedupeAdjacentToolCalls(msg);
          return msg;
        }
      }
    } catch { /* ignore textual harvesting when disabled */ }
  } catch { /* ignore */ }
  // 无工具情况下也执行思考标签剥离（幂等，且不改变工具抽取顺序）
  try {
    if (typeof (message as any).content === 'string' && (message as any).content.length) {
      (message as any).content = stripThinkingTagsPreserve(String((message as any).content));
    }
    if (typeof (message as any).reasoning_content === 'string' && (message as any).reasoning_content.length) {
      (message as any).reasoning_content = stripThinkingTagsPreserve(removeIntentBlocks(String((message as any).reasoning_content)));
    }
  } catch { /* ignore */ }
  return message;
}

// Request-side: canonicalize assistant textual tool markup into tool_calls across the messages array.
export function canonicalizeChatRequestTools(chat: Record<string, unknown>): Record<string, unknown> {
  if (!chat || typeof chat !== 'object') return chat;
  try {
    const messages = Array.isArray((chat as any).messages) ? ((chat as any).messages as Array<Record<string, unknown>>) : [];
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      if (!m || (m as any).role !== 'assistant') continue;
      // 不再处理 rcc.tool.v1 结果包（移除相关清洗）
      const normalized = normalizeAssistantMessage(m as any) as any;
      // OpenAI/GLM 一致性：assistant 含 tool_calls 时 content 应为 null。
      // 仅在 content 为空/空白字符串时设置为 null，避免覆盖真实文本。
      try {
        if (Array.isArray((normalized as any).tool_calls) && (normalized as any).tool_calls.length > 0) {
          const c = (normalized as any).content;
          if (typeof c === 'string' && c.trim().length === 0) {
            (normalized as any).content = null;
          }
        }
      } catch { /* ignore */ }
      messages[i] = normalized;
    }

  // 不再提升/改写任何 assistant 文本为 tool，也不再按 rcc.tool.v1 进行最小化
  } catch { /* ignore */ }
  return chat;
}

// Response-side: canonicalize assistant textual tool markup in the primary choice message.
export function canonicalizeChatResponseTools(resp: Record<string, unknown>): Record<string, unknown> {
  if (!resp || typeof resp !== 'object') return resp;
  try {
    const choices = Array.isArray((resp as any).choices) ? ((resp as any).choices as Array<Record<string, unknown>>) : [];
    if (choices.length > 0) {
      const first = choices[0] && typeof choices[0] === 'object' ? choices[0] : undefined;
      const msg = first && typeof (first as any).message === 'object' ? (first as any).message as Record<string, unknown> : undefined;
      if (msg) {
        const normalized = normalizeAssistantMessage(msg as any) as any;
        // 标准 validation: drop invalid tool calls and normalize arguments
        try {
          if (Array.isArray((normalized as any).tool_calls)) {
            const fixed: any[] = [];
            for (const tc of ((normalized as any).tool_calls as any[])) {
              try {
                const nm = String(tc?.function?.name || '').trim();
                const argStr = typeof tc?.function?.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc?.function?.arguments ?? {});
                const v = validateToolCall(nm, argStr);
                if (!v.ok) continue;
                const norm = (typeof v.normalizedArgs === 'string') ? v.normalizedArgs : argStr;
                fixed.push({ id: tc?.id || `call_${Math.random().toString(36).slice(2, 10)}`, type: 'function', function: { name: nm, arguments: norm } });
              } catch { fixed.push(tc); }
            }
            (normalized as any).tool_calls = fixed;
          }
        } catch { /* ignore validation errors */ }
        // Dedupe once more at choice level to guarantee no adjacent duplicates
        try { dedupeAdjacentToolCalls(normalized); } catch { /* ignore */ }
        (first as any).message = normalized;
        const frRaw = String((first as any).finish_reason || '').toLowerCase();
        const hasCalls = Array.isArray((normalized as any).tool_calls) && (normalized as any).tool_calls.length > 0;
        if (!hasCalls) {
          // Conditionally harvest from content when finish_reason indicates tool intent or when stop + markers
          const text = typeof (normalized as any).content === 'string' ? String((normalized as any).content) : '';
          const markers = /<\s*tool_call\b/i.test(text) || /<\s*arg_key\b/i.test(text) || /<function=execute>/i.test(text) || /\*\*\*\s*Begin\s*Patch/i.test(text);
          const shouldHarvest = (frRaw === 'tool_calls') || (frRaw === 'stop' && markers);
          if (shouldHarvest && text && text.trim().length) {
            try {
              let calls = (
                extractXMLToolCallsFromText(text) ||
                extractApplyPatchCallsFromText(text) ||
                extractExecuteBlocksFromText(text)
              ) || [];
              if ((!calls || calls.length === 0) && /<\s*arg_key\s*>/i.test(text)) {
                try {
                  const argPairs = Array.from(text.matchAll(/<\s*arg_key\s*>\s*([^<]+?)\s*<\/\s*arg_key\s*>\s*<\s*arg_value\s*>\s*([\s\S]*?)\s*<\/\s*arg_value\s*>/gi));
                  if (argPairs.length) {
                    const args: Record<string, unknown> = {};
                    for (const mm of argPairs as any[]) {
                      const m: any = mm;
                      const k = (m[1] || '').trim(); let vRaw = (m[2] || '').trim(); let v: unknown = vRaw;
                      if ((vRaw.startsWith('[') && vRaw.endsWith(']')) || (vRaw.startsWith('{') && vRaw.endsWith('}'))) { try { v = JSON.parse(vRaw); } catch { v = vRaw; } }
                      (args as any)[normalizeKey(k)] = v;
                    }
                    let inferred = '';
                    const keys = Object.keys(args);
                    if (keys.includes('command')) inferred = 'shell';
                    else if (keys.includes('patch')) inferred = 'apply_patch';
                    else if (keys.includes('plan')) inferred = 'update_plan';
                    else if (keys.includes('path')) inferred = 'view_image';
                    if (inferred) {
                      try { if (inferred === 'view_image') { const p = (args as any).path; if (typeof p !== 'string' || !/\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(p)) inferred = ''; } } catch {}
                    }
                    if (inferred) {
                      const argStr = JSON.stringify(args);
                      calls = [{ id: `call_${Math.random().toString(36).slice(2,10)}`, name: inferred, args: argStr }];
                    }
                  }
                } catch { /* ignore */ }
              }
              if (calls && calls.length) {
                const tcs = calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.args } }));
                (first as any).message.tool_calls = tcs;
                (first as any).message.content = '';
                (first as any).finish_reason = 'tool_calls';
              }
            } catch { /* ignore */ }
          }
        } else {
          if ((first as any).finish_reason == null) (first as any).finish_reason = 'tool_calls';
        }
      }
    }
  } catch { /* ignore */ }
  return resp;
}
