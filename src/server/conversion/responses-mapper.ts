import type { Request } from 'express';
import { ResponsesConfigUtil, type ResponsesConversionMapping } from '../config/responses-config.js';

export interface ChatMsg extends Record<string, unknown> { role: string; content?: string | Array<Record<string, unknown>> }
export interface ChatRequest { model: string; stream: boolean; messages: Array<Record<string, unknown>>; tools?: unknown; tool_choice?: unknown; parallel_tool_calls?: unknown }

export class ResponsesMapper {
  static async toChatRequestFromMapping(body: any, req?: Request, modelOverride?: string): Promise<ChatRequest> {
    const { mappings } = await ResponsesConfigUtil.load();
    const map = mappings.request;
    const ib = map.inputBlocks;
    const typeKey = ib.typeKey || 'type';
    const roleKey = ib.roleKey || 'role';
    const blocksKey = ib.blocksKey || 'content';
    const textKey = ib.textKey || 'text';
    const wrapperType = String(ib.wrapperType || 'message').toLowerCase();
    const allowed = new Set((ib.allowedContentTypes || ['input_text','text']).map(s => String(s).toLowerCase()));
    const ignoreRoles = new Set((ib.ignoreRoles || []).map(r => String(r).toLowerCase()));
    const dedupe = !!ib.dedupe;
    const joiner = typeof ib.dedupeDelimiter === 'string' ? ib.dedupeDelimiter : '\n\n';
    const seen = new Set<string>();

    const out: ChatMsg[] = [];
    const pushMsg = (role: string, text: string) => {
      const r = String(role || '').toLowerCase();
      if (ignoreRoles.has(r)) return;
      const t = String(text || '').trim();
      if (!t) return;
      const key = `${r}|${t}`;
      if (dedupe && seen.has(key)) return;
      if (dedupe) seen.add(key);
      out.push({ role: role as string, content: t });
    };
    const pushSystem = (text: string) => {
      const t = String(text || '').trim();
      if (!t) return;
      const key = `system|${t}`;
      if (dedupe && seen.has(key)) return;
      if (dedupe) seen.add(key);
      out.push({ role: 'system', content: t });
    };

    // 1) instructions → system
    if (Array.isArray(map.instructionsPaths)) {
      for (const p of map.instructionsPaths) {
        if (p === 'instructions' && typeof body?.instructions === 'string') {
          // system 指令不受 ignoreRoles 影响
          pushSystem(body.instructions);
        }
      }
    }

    // 2) input[] expansion（包含文本、顶层工具调用与结果）
    const collectTexts = (arr: any[]): string[] => {
      const texts: string[] = [];
      for (const part of arr || []) {
        if (!part || typeof part !== 'object') continue;
        const kind = String((part as any)[typeKey] || '').toLowerCase();
        if (allowed.has(kind) && typeof (part as any)[textKey] === 'string') {
          const t = String((part as any)[textKey]).trim(); if (t) texts.push(t);
          continue;
        }
        const nested = (part as any)[blocksKey];
        if (Array.isArray(nested)) texts.push(...collectTexts(nested));
      }
      return texts;
    };

    // 提取工具输出文本（支持 content 为数组、output 为字符串/对象/JSON 字符串）
    const extractToolOutput = (blk: any): string => {
      if (!blk || typeof blk !== 'object') return '';
      const flattenParts = (v: any): string[] => {
        const texts: string[] = [];
        const push = (s?: string) => { if (typeof s === 'string') { const t = s.trim(); if (t) texts.push(t); } };
        if (Array.isArray(v)) {
          for (const p of v) {
            if (!p) continue;
            if (typeof p === 'string') { push(p); continue; }
            if (typeof p === 'object') {
              if (typeof (p as any).text === 'string') { push((p as any).text); continue; }
              if (typeof (p as any).content === 'string') { push((p as any).content); continue; }
              if (Array.isArray((p as any).content)) { texts.push(...flattenParts((p as any).content)); continue; }
            }
          }
        }
        return texts;
      };
      // text 字段或 content 为字符串
      const directText = typeof blk?.text === 'string' ? blk.text.trim()
        : (typeof blk?.content === 'string' ? blk.content.trim() : '');
      if (directText) return directText;
      // content 为数组（常见于工具结果）
      if (Array.isArray(blk?.content)) {
        const t = flattenParts(blk.content).join('\n').trim();
        if (t) return t;
      }
      // output 字段容纳字符串或对象
      const out = blk?.output;
      if (typeof out === 'string') {
        const s = out.trim(); if (!s) return '';
        try { const p = JSON.parse(s); if (p && typeof p === 'object' && typeof (p as any).output === 'string') return String((p as any).output); } catch { /* ignore */ }
        return s;
      }
      if (out && typeof out === 'object') {
        if (typeof (out as any).output === 'string') return String((out as any).output);
        if (typeof (out as any).text === 'string') return String((out as any).text);
        if (typeof (out as any).content === 'string') return String((out as any).content);
        if (Array.isArray((out as any).content)) {
          const t = flattenParts((out as any).content).join('\n').trim();
          if (t) return t;
        }
        try { return JSON.stringify(out); } catch { return ''; }
      }
      return '';
    };

    // 先扫一遍，构造 Chat 消息（包含顶层 function_call / function_call_output）
    const messagesOut: Array<Record<string, unknown>> = [];
    let lastFunctionCallId: string | null = null;

    // Build tools schema map for normalization by declared parameters
    const toolsArray: any[] = Array.isArray(body?.tools) ? (body.tools as any[]) : [];
    const toolsMap: Record<string, any> = {};
    for (const t of toolsArray) {
      try {
        const nm = (t && (t.name || (t.function && t.function.name))) as string | undefined;
        const params = (t && (t.parameters || (t.function && t.function.parameters))) as any;
        if (nm && params) toolsMap[String(nm)] = params;
      } catch { /* ignore */ }
    }
    const isCommandArraySchema = (schema: any): boolean => {
      try {
        const props = schema?.properties;
        const def = props?.command;
        return def?.type === 'array' && def?.items?.type === 'string';
      } catch { return false; }
    };
    const isCommandStringSchema = (schema: any): boolean => {
      try {
        const props = schema?.properties;
        const def = props?.command;
        return def?.type === 'string';
      } catch { return false; }
    };
    const parseMaybeDoubleJSON = (raw: unknown): any => {
      let v: any = raw;
      for (let i = 0; i < 2 && typeof v === 'string'; i++) {
        try { v = JSON.parse(v as string); } catch { break; }
      }
      return v;
    };
    const ensureStringArray = (arr: unknown): arr is string[] => Array.isArray(arr) && arr.every(x => typeof x === 'string');
    const error400 = (msg: string) => { const e: any = new Error(msg); e.status = 400; e.code = 'validation_error'; return e; };
    const serializeArgsStrictBySchema = (name: string | undefined, rawArgs: unknown): string => {
      const toolName = (typeof name === 'string' && name.trim()) ? String(name) : undefined;
      const schema = toolName ? toolsMap[toolName] : undefined;
      if (!schema) throw error400(`Missing tool schema for function: ${toolName || 'unknown'}`);
      const v0 = parseMaybeDoubleJSON(rawArgs);
      if (!v0 || typeof v0 !== 'object') throw error400('Tool arguments must be a JSON object (stringified)');
      const v: any = { ...(v0 as any) };
      if (isCommandArraySchema(schema)) {
        if (!ensureStringArray(v.command)) throw error400('Invalid command: expected array<string>');
      } else if (isCommandStringSchema(schema)) {
        if (Array.isArray(v.command)) {
          if (!ensureStringArray(v.command)) throw error400('Invalid command array: must be array<string>');
          v.command = (v.command as string[]).join(' ');
        } else if (typeof v.command !== 'string') {
          throw error400('Invalid command: expected string');
        }
      }
      try { return JSON.stringify(v); } catch { throw error400('Failed to serialize tool arguments'); }
    };

    const pushAssistantToolCall = (name: string | undefined, args: unknown, callId?: string) => {
      const serialized = serializeArgsStrictBySchema(name, args).trim();
      const toolId = callId && String(callId).trim() ? String(callId).trim() : `call_${Math.random().toString(36).slice(2, 8)}`;
      lastFunctionCallId = toolId;
      const fnName = (typeof name === 'string' && name.trim()) ? name.trim() : 'tool';
      messagesOut.push({ role: 'assistant', tool_calls: [{ id: toolId, type: 'function', function: { name: fnName, arguments: serialized } }] });
    };

    if (Array.isArray(body?.input)) {
      for (const it of body.input as any[]) {
        if (!it || typeof it !== 'object') continue;
        const itType = String((it as any)[typeKey] || '').toLowerCase();
        if (itType === 'function_call' || itType === 'tool_call') {
          const nm = (it as any).name || (it as any)?.function?.name;
          const args = (it as any).arguments ?? (it as any)?.function?.arguments ?? {};
          const id = (it as any).id || (it as any).call_id;
          pushAssistantToolCall(typeof nm === 'string' ? nm : undefined, args, typeof id === 'string' ? id : undefined);
          continue;
        }
          if (itType === 'function_call_output' || itType === 'tool_result' || itType === 'tool_message') {
            const text = extractToolOutput(it);
            if (!text) { throw error400(`Invalid tool result payload: empty output for ${itType}`); }
            const explicitId = (typeof (it as any).id === 'string' ? (it as any).id
              : (typeof (it as any).call_id === 'string' ? (it as any).call_id
                : (typeof (it as any).tool_call_id === 'string' ? (it as any).tool_call_id
                  : (typeof (it as any).tool_use_id === 'string' ? (it as any).tool_use_id : undefined))));
            const tool_call_id = explicitId || lastFunctionCallId || undefined;
            const msg: Record<string, unknown> = tool_call_id ? { role: 'tool', content: text, tool_call_id } : { role: 'tool', content: text };
            messagesOut.push(msg);
            continue;
          }
        
        // 常规 message（文本）
        if (itType === String(wrapperType)) {
          const role = typeof (it as any)[roleKey] === 'string' ? (it as any)[roleKey] : 'user';
          const blocks = Array.isArray((it as any)[blocksKey]) ? (it as any)[blocksKey] : [];
          const texts = collectTexts(blocks);
          if (texts.length) pushMsg(role, texts.join(joiner));
        }
      }
    }

    if (Array.isArray(body?.input)) {
      // 仅取本轮输入：选择最后一个 wrapperType='message' 的项作为用户消息
      const arr = body.input as any[];
      let lastMsg: any | null = null;
      for (let i = arr.length - 1; i >= 0; i--) {
        const it = arr[i];
        if (it && typeof it === 'object') {
          const itType = String((it as any)[typeKey] || '').toLowerCase();
          if (itType === wrapperType) { lastMsg = it; break; }
        }
      }
      if (lastMsg) {
        const role = typeof (lastMsg as any)[roleKey] === 'string' ? (lastMsg as any)[roleKey] : 'user';
        const blocks = Array.isArray((lastMsg as any)[blocksKey]) ? (lastMsg as any)[blocksKey] : [];
        const texts = collectTexts(blocks);
        if (texts.length) pushMsg(role, texts.join(joiner));
      } else {
        // 如没有 message 包装，退化为把整个 input 展开为一条 user 文本
        const texts = collectTexts(arr);
        if (texts.length) pushMsg('user', texts.join(joiner));
      }
    }

    // No fallback by design: must have at least one user
    const messagesCombined: Array<Record<string, unknown>> = [...messagesOut, ...out];
    if (!messagesCombined.some(m => m.role === 'user')) {
      const err: any = new Error('Input cannot be empty (no non-empty user content)');
      err.status = 400; err.code = 'validation_error';
      throw err;
    }

    // If request carries any tool result in this turn, prefer letting the model decide next action
    const hasToolResult = Array.isArray(body?.input)
      && (body.input as any[]).some((it: any) => it && typeof it === 'object' && ['function_call_output','tool_result','tool_message'].includes(String(it.type || '').toLowerCase()));
    const toolChoiceOut = hasToolResult ? undefined : body?.tool_choice;

    return {
      model: String(modelOverride || body?.model || 'unknown'),
      stream: false,
      messages: messagesCombined,
      ...(typeof body?.tools !== 'undefined' ? { tools: body.tools } : {}),
      ...(typeof toolChoiceOut !== 'undefined' ? { tool_choice: toolChoiceOut } : {}),
      ...(typeof body?.parallel_tool_calls !== 'undefined' ? { parallel_tool_calls: body.parallel_tool_calls } : {})
    };
  }

  static async chatToResponsesFromMapping(payload: any): Promise<Record<string, unknown>> {
    const { mappings } = await ResponsesConfigUtil.load();
    const toolEmitRequired = !!mappings.tools.emitRequiredAction;
    const passthrough = mappings.response.passthroughFields || [];
    const defaults = mappings.response.defaultValues || {};

    const model = payload?.model || 'unknown';
    const id = payload?.id || `resp_${Date.now()}`;
    const created_at = Math.floor(Date.now() / 1000);

    // Extract text
    const text = (() => {
      const s = payload?.choices?.[0]?.message?.content;
      if (typeof s === 'string') return s.trim();
      if (Array.isArray(s)) {
        const t = s.map((p: any) => (p && typeof p.text === 'string') ? p.text : (typeof p === 'string' ? p : ''))
                   .filter(Boolean).join(' ').trim();
        return t;
      }
      return '';
    })();

    // Helper: canonicalize server.method → canonical function name + inject server param
    const canonicalizeTool = (name: string | undefined, argsStr: string): { name: string; args: string } => {
      const whitelist = new Set(['read_mcp_resource', 'list_mcp_resources', 'list_mcp_resource_templates']);
      if (!name || typeof name !== 'string') return { name: 'tool', args: argsStr };
      const dot = name.indexOf('.');
      if (dot <= 0) return { name, args: argsStr };
      const prefix = name.slice(0, dot).trim();
      const base = name.slice(dot + 1).trim();
      if (!whitelist.has(base)) return { name, args: argsStr };
      let obj: any;
      try { obj = JSON.parse(argsStr || '{}'); } catch { throw new Error('Tool call arguments must be valid JSON'); }
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('Tool call arguments must be a JSON object');
      if (obj.server == null || obj.server === '') obj.server = prefix;
      return { name: base, args: JSON.stringify(obj) };
    };

    // Extract tool calls (OpenAI Chat)
    const toolCalls = Array.isArray(payload?.choices?.[0]?.message?.tool_calls)
      ? payload.choices[0].message.tool_calls as any[] : [];

    const output: any[] = [];
    // Map provider Chat reasoning_content (if present) into a reasoning output item
    const reasoningText = (() => {
      try {
        const rc = payload?.choices?.[0]?.message?.reasoning_content;
        if (typeof rc === 'string') {
          const t = rc.trim();
          return t.length ? t : '';
        }
      } catch { /* ignore */ }
      return '';
    })();
    if (reasoningText) {
      output.push({ type: 'reasoning', content: [{ type: 'output_text', text: reasoningText }] });
    }
    if (text) {
      output.push({ type: 'message', message: { role: 'assistant', content: [{ type: 'output_text', text }] } });
    }
    for (const tc of toolCalls) {
      const callId = typeof tc?.id === 'string' ? tc.id : `call_${Math.random().toString(36).slice(2,8)}`;
      const fn = (tc && typeof tc.function === 'object') ? tc.function : undefined;
      const fnNameRaw = typeof fn?.name === 'string' ? fn.name : 'tool';
      const argsRaw = typeof fn?.arguments === 'string' ? fn.arguments : (fn?.arguments ? JSON.stringify(fn.arguments) : '{}');
      const { name: fnName, args } = canonicalizeTool(fnNameRaw, argsRaw);
      // OpenAI Responses spec uses function_call item
      output.push({ type: 'function_call', id: callId, call_id: callId, name: fnName, arguments: args, status: 'in_progress' });
    }

    const usage = (() => {
      const u = payload?.usage;
      if (!u || typeof u !== 'object') return undefined;
      const input = typeof u.input_tokens === 'number' ? u.input_tokens : (typeof u.prompt_tokens === 'number' ? u.prompt_tokens : 0);
      const outputTokens = typeof u.output_tokens === 'number' ? u.output_tokens : (typeof u.completion_tokens === 'number' ? u.completion_tokens : 0);
      const total = typeof u.total_tokens === 'number' ? u.total_tokens : (input + outputTokens);
      return { input_tokens: input, output_tokens: outputTokens, total_tokens: total };
    })();

    const hasToolCalls = toolCalls.length > 0;
    const resp: any = {
      id,
      object: 'response',
      created_at,
      model,
      status: hasToolCalls ? 'in_progress' : 'completed',
      output,
      output_text: text,
      ...(usage ? { usage } : {})
    };
    // When tool calls are present, request client to submit tool outputs
    if (hasToolCalls) {
      resp.required_action = {
        type: 'submit_tool_outputs',
        submit_tool_outputs: {
          tool_calls: toolCalls.map((tc: any) => ({
            id: typeof tc?.id === 'string' ? tc.id : `call_${Math.random().toString(36).slice(2,8)}`,
            type: 'function',
            function: {
              name: String(tc?.function?.name || 'tool'),
              arguments: typeof tc?.function?.arguments === 'string'
                ? tc.function.arguments
                : (tc?.function?.arguments ? JSON.stringify(tc.function.arguments) : '{}')
            }
          }))
        }
      };
    }
    // Note: SSE path composes events; required_action emitted for non-stream JSON only
    for (const field of passthrough) {
      if (resp[field] === undefined && defaults[field] !== undefined) {
        resp[field] = defaults[field];
      }
    }
    return resp;
  }

  static async enrichResponsePayload(payload: Record<string, unknown>, source?: Record<string, unknown>, requestMeta?: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { mappings } = await ResponsesConfigUtil.load();
    const passthrough = mappings.response.passthroughFields || [];
    const defaults = mappings.response.defaultValues || {};
    const out: Record<string, unknown> = { ...(payload || {}) };
    const getFrom = (obj: Record<string, unknown> | undefined, key: string) => {
      if (!obj) return undefined;
      const value = (obj as any)[key];
      return value === undefined ? undefined : value;
    };
    for (const field of passthrough) {
      if (out[field] !== undefined) continue;
      const fromSource = getFrom(source, field);
      if (fromSource !== undefined) { out[field] = fromSource; continue; }
      const fromReq = getFrom(requestMeta, field);
      if (fromReq !== undefined) { out[field] = fromReq; continue; }
      if (defaults[field] !== undefined) { out[field] = defaults[field]; }
    }
    return out;
  }

  /**
   * Convert OpenAI Responses JSON back to OpenAI Chat messages format.
   * Deterministic mapping:
   * - function_call items -> assistant message with tool_calls[] (content: '')
   * - tool result items (function_call_output/tool_result/tool_message) -> tool role message with tool_call_id
   * - message items -> assistant role message with flattened text content
   * No heuristics beyond strict JSON serialization for structured content.
   */
  static async responsesToChatFromMapping(resp: any): Promise<{ model: string; messages: Array<Record<string, unknown>> }> {
    const model = (resp && typeof resp.model === 'string') ? resp.model : 'unknown';
    const messages: Array<Record<string, unknown>> = [];
    const idMap: Map<string, string> = new Map();

    const getTextFromContentArray = (arr: any[]): string => {
      const out: string[] = [];
      for (const p of arr || []) {
        if (typeof p === 'string') { const t = p.trim(); if (t) out.push(t); continue; }
        if (p && typeof p === 'object') {
          if (typeof (p as any).text === 'string') { const t = (p as any).text.trim(); if (t) out.push(t); }
          else if (typeof (p as any).content === 'string') { const t = (p as any).content.trim(); if (t) out.push(t); }
        }
      }
      return out.join('\n');
    };

    const outputs: any[] = Array.isArray(resp?.output) ? resp.output as any[] : [];
    for (const it of outputs) {
      if (!it || typeof it !== 'object') continue;
      const t = String((it as any).type || '').toLowerCase();
      if (t === 'function_call' || t === 'tool_call') {
        const id = (typeof (it as any).id === 'string' ? (it as any).id : (typeof (it as any).call_id === 'string' ? (it as any).call_id : `call_${Math.random().toString(36).slice(2,8)}`));
        const name = (it as any).name || (it as any)?.tool_name || 'tool';
        let args = (it as any).arguments ?? (it as any)?.tool_call?.function?.arguments ?? '';
        if (typeof args !== 'string') {
          try { args = JSON.stringify(args ?? {}); } catch { args = '{}'; }
        }
        idMap.set(id, id);
        messages.push({ role: 'assistant', content: '', tool_calls: [ { id, type: 'function', function: { name: String(name), arguments: String(args) } } ] });
        continue;
      }
      if (t === 'function_call_output' || t === 'tool_result' || t === 'tool_message') {
        // Extract textual content deterministically
        let content = '';
        if (typeof (it as any).text === 'string') content = (it as any).text.trim();
        else if (typeof (it as any).content === 'string') content = (it as any).content.trim();
        else if (Array.isArray((it as any).content)) { content = getTextFromContentArray((it as any).content).trim(); }
        else if ((it as any).output !== undefined) {
          const out = (it as any).output;
          if (typeof out === 'string') content = out.trim();
          else if (out && typeof out === 'object') { try { content = JSON.stringify(out); } catch { content = ''; } }
        }
        const callId = (typeof (it as any).call_id === 'string' ? (it as any).call_id
          : (typeof (it as any).id === 'string' ? (it as any).id : undefined));
        const tool_call_id = callId && idMap.has(callId) ? callId : (idMap.size ? Array.from(idMap.keys()).slice(-1)[0] : undefined);
        const toolMsg: Record<string, unknown> = tool_call_id ? { role: 'tool', content: String(content || ''), tool_call_id } : { role: 'tool', content: String(content || '') };
        messages.push(toolMsg);
        continue;
      }
      if (t === 'message') {
        const m = (it as any).message || {};
        const role = typeof m.role === 'string' ? m.role : 'assistant';
        let text = '';
        if (Array.isArray(m.content)) text = getTextFromContentArray(m.content);
        else if (typeof m.content === 'string') text = m.content;
        messages.push({ role, content: text });
        continue;
      }
    }

    // Fallback: if no outputs present, derive from output_text
    if (messages.length === 0 && typeof resp?.output_text === 'string') {
      const t = String(resp.output_text).trim();
      if (t) messages.push({ role: 'assistant', content: t });
    }

    return { model, messages };
  }
}
