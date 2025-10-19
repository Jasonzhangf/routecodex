import type { Request } from 'express';
import { ResponsesConfigUtil, type ResponsesConversionMapping } from '../config/responses-config.js';

export interface ChatMsg { role: string; content: string }
export interface ChatRequest { model: string; stream: boolean; messages: ChatMsg[]; tools?: unknown; tool_choice?: unknown; parallel_tool_calls?: unknown }

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

    // 1) instructions → system
    if (Array.isArray(map.instructionsPaths)) {
      for (const p of map.instructionsPaths) {
        if (p === 'instructions' && typeof body?.instructions === 'string') {
          pushMsg('system', body.instructions);
        }
      }
    }

    // 2) input[] nested expansion (non-flat)
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

    if (Array.isArray(body?.input)) {
      for (const item of (body.input as any[])) {
        if (!item || typeof item !== 'object') continue;
        const itType = String((item as any)[typeKey] || '').toLowerCase();
        if (itType === wrapperType) {
          const role = typeof (item as any)[roleKey] === 'string' ? (item as any)[roleKey] : 'user';
          const blocks = Array.isArray((item as any)[blocksKey]) ? (item as any)[blocksKey] : [];
          const texts = collectTexts(blocks);
          if (texts.length) pushMsg(role, texts.join(joiner));
        } else if (allowed.has(itType) && typeof (item as any)[textKey] === 'string') {
          pushMsg('user', (item as any)[textKey]);
        }
      }
    }

    // No fallback by design: must have at least one user
    if (!out.some(m => m.role === 'user')) {
      const err: any = new Error('Input cannot be empty (no non-empty user content)');
      err.status = 400; err.code = 'validation_error';
      throw err;
    }

    return {
      model: String(modelOverride || body?.model || 'unknown'),
      stream: false,
      messages: out,
      ...(typeof body?.tools !== 'undefined' ? { tools: body.tools } : {}),
      ...(typeof body?.tool_choice !== 'undefined' ? { tool_choice: body.tool_choice } : {}),
      ...(typeof body?.parallel_tool_calls !== 'undefined' ? { parallel_tool_calls: body.parallel_tool_calls } : {})
    };
  }

  static async chatToResponsesFromMapping(payload: any): Promise<Record<string, unknown>> {
    const { mappings } = await ResponsesConfigUtil.load();
    const toolEmitRequired = !!mappings.tools.emitRequiredAction;

    const model = payload?.model || 'unknown';
    const id = payload?.id || `resp_${Date.now()}`;
    const created = Math.floor(Date.now() / 1000);

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

    // Extract tool calls (OpenAI Chat)
    const toolCalls = Array.isArray(payload?.choices?.[0]?.message?.tool_calls)
      ? payload.choices[0].message.tool_calls as any[] : [];

    const output: any[] = [];
    if (text) {
      output.push({ type: 'message', message: { role: 'assistant', content: [{ type: 'output_text', text }] } });
    }
    for (const tc of toolCalls) {
      const callId = typeof tc?.id === 'string' ? tc.id : `call_${Math.random().toString(36).slice(2,8)}`;
      const fn = (tc && typeof tc.function === 'object') ? tc.function : undefined;
      const fnName = typeof fn?.name === 'string' ? fn.name : 'tool';
      const args = typeof fn?.arguments === 'string' ? fn.arguments : (fn?.arguments ? JSON.stringify(fn.arguments) : '');
      output.push({ type: 'tool_call', id: callId, name: fnName, arguments: args, tool_call: { id: callId, type: 'function', function: { name: fnName, arguments: args } } });
    }

    const usage = (() => {
      const u = payload?.usage;
      if (!u || typeof u !== 'object') return undefined;
      const input = typeof u.input_tokens === 'number' ? u.input_tokens : (typeof u.prompt_tokens === 'number' ? u.prompt_tokens : 0);
      const outputTokens = typeof u.output_tokens === 'number' ? u.output_tokens : (typeof u.completion_tokens === 'number' ? u.completion_tokens : 0);
      const total = typeof u.total_tokens === 'number' ? u.total_tokens : (input + outputTokens);
      return { input_tokens: input, output_tokens: outputTokens, total_tokens: total };
    })();

    const resp: any = { id, object: 'response', created, model, status: 'completed', output, output_text: text, ...(usage ? { usage } : {}) };
    // required_action is emitted via SSE from handler; here we keep JSON minimal
    if (toolEmitRequired && toolCalls.length) {
      resp.required_action = {
        type: 'submit_tool_outputs',
        submit_tool_outputs: {
          tool_calls: toolCalls.map((tc: any) => ({ id: tc?.id || '', name: tc?.function?.name || '', arguments: typeof tc?.function?.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc?.function?.arguments || {}) }))
        }
      };
    }
    return resp;
  }
}

