import type { ConversionCodec, ConversionContext, ConversionProfile } from '../types.js';
import { FilterEngine, type FilterContext,
  RequestToolCallsStringifyFilter,
  RequestToolChoicePolicyFilter,
  ResponseToolTextCanonicalizeFilter,
  ResponseToolArgumentsStringifyFilter,
  ResponseFinishInvariantsFilter
} from '../../filters/index.js';

// Anthropic <-> OpenAI (Chat) codec
// - Request: Anthropic Messages → OpenAI Chat (tool_use → assistant.tool_calls)
// - Response: OpenAI Chat → Anthropic Messages (tool_calls → tool_use)
export class AnthropicOpenAIConversionCodec implements ConversionCodec {
  readonly id = 'anthropic-openai';
  private initialized = false;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(private readonly _deps: any) {}

  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
  }

  private async ensureInit(): Promise<void> { if (!this.initialized) await this.initialize(); }

  async convertRequest(payload: any, _profile: ConversionProfile, _context: ConversionContext): Promise<any> {
    await this.ensureInit();
    const r = (payload && typeof payload === 'object') ? (payload as Record<string, unknown>) : {};
    const out: any = { ...r };

    // 1) 把顶层 system 注入为第一条 system 消息
    const sys = typeof out.system === 'string' && out.system.trim() ? String(out.system) : undefined;
    const newMessages: any[] = [];
    if (sys) newMessages.push({ role: 'system', content: sys });

    // 2) Messages: content[] → text，tool_use → assistant.tool_calls（arguments 为单一 JSON 字符串）
    const srcMsgs: any[] = Array.isArray(out.messages) ? (out.messages as any[]) : [];
    // 保持工具名原样（信任 schema）；如需限制应由上游 provider/配置控制
    const keepToolName = (name: string | undefined): string | undefined => (name ? String(name) : name);
    for (const m of srcMsgs) {
      if (!m || typeof m !== 'object') continue;
      const role = typeof m.role === 'string' ? m.role : 'user';
      const content = (m as any).content;
      if (Array.isArray(content)) {
        const textParts: string[] = [];
        const toolCalls: any[] = [];
        const toolResults: any[] = [];
        for (const block of content) {
          if (!block) continue;
          const t = String((block as any).type || '').toLowerCase();
          if (t === 'text' && typeof (block as any).text === 'string') {
            const s = (block as any).text.trim(); if (s) textParts.push(s);
          } else if (t === 'tool_use') {
            const rawName = typeof (block as any).name === 'string' ? (block as any).name : undefined;
            const name = keepToolName(rawName);
            const id = typeof (block as any).id === 'string' ? (block as any).id : undefined;
            const input = (block as any).input ?? {};
            if (name) {
              let args = '{}';
              try { args = JSON.stringify(input ?? {}); } catch { args = '{}'; }
              toolCalls.push({ id, type: 'function', function: { name, arguments: args } });
            }
          } else if (t === 'tool_result') {
            // 将 Anthropics tool_result → OpenAI Chat 工具结果消息（role: 'tool'）
            const callId = (block as any).tool_call_id
              || (block as any).call_id
              || (block as any).tool_use_id
              || (block as any).id
              || undefined;
            let contentStr: string = '';
            const c = (block as any).content;
            if (typeof c === 'string') contentStr = c;
            else if (c != null) {
              try { contentStr = JSON.stringify(c); } catch { contentStr = String(c); }
            }
            toolResults.push({ role: 'tool', tool_call_id: callId, content: contentStr });
          }
        }
        // 仅在存在文本或工具调用时才生成该消息；
        // 当仅有 tool_result 时不生成空壳消息（避免出现 role=user 且 content='' 的无效消息）。
        if (textParts.length > 0 || toolCalls.length > 0) {
          const msg: any = { role, content: textParts.join('\n') };
          if (toolCalls.length) msg.tool_calls = toolCalls;
          newMessages.push(msg);
        }
        // 追加 tool 结果消息，保持顺序在该条消息之后（近似原始顺序）
        for (const tr of toolResults) newMessages.push(tr);
      } else if (typeof content === 'string') {
        newMessages.push({ role, content });
      } else {
        newMessages.push({ role, content: String(content ?? '') });
      }
    }
    if (newMessages.length) out.messages = newMessages; else delete out.messages;
    if (sys) delete out.system;

    // 3) 工具定义：Anthropic tools → OpenAI function tools（白名单 + 限流 + 去 $schema）
    if (Array.isArray(out.tools)) {
      const pruneSchema = (schema: any): any => {
        try {
          if (!schema || typeof schema !== 'object') return undefined;
          const clone = JSON.parse(JSON.stringify(schema));
          if ('$schema' in clone) delete clone['$schema'];
          return clone;
        } catch { return undefined; }
      };
      const mappedTools = (out.tools as any[]).map((t: any) => {
        if (!t || typeof t !== 'object') return t;
        const rawName = typeof t.name === 'string' ? t.name : undefined;
        const name = keepToolName(rawName);
        const description = typeof t.description === 'string' ? t.description : undefined;
        const params = (t as any).input_schema && typeof (t as any).input_schema === 'object'
          ? pruneSchema((t as any).input_schema)
          : undefined;
        if (!name) return null;
        return { type: 'function', function: { name, ...(description ? { description } : {}), ...(params ? { parameters: params } : {}) } };
      }).filter(Boolean);
      // 不做白名单过滤或重命名；按“信任 schema”透传（必要时仅移除 $schema）
      out.tools = mappedTools as any[];
    }

    // 4) 若存在 tools 且未指定 tool_choice，默认 auto
    try {
      if (Array.isArray(out.tools) && out.tools.length > 0) {
        if (typeof out.tool_choice === 'undefined') out.tool_choice = 'auto';
        else if (out.tool_choice !== 'auto') out.tool_choice = 'auto';
      }
    } catch { /* ignore */ }

    // Apply request-side filters (idempotent, no system injection)
    const reqCtxBase: Omit<FilterContext,'stage'> = {
      requestId: String(_context.requestId || `req_${Date.now()}`),
      model: String((out as any).model || 'unknown'),
      endpoint: '/v1/messages',
      profile: 'anthropic-openai',
      debug: { emit: () => {} }
    };
    const engReq = new FilterEngine();
    engReq.registerFilter(new RequestToolCallsStringifyFilter());
    engReq.registerFilter(new RequestToolChoicePolicyFilter());
    let staged = await engReq.run('request_pre', out as any, reqCtxBase);
    staged = await engReq.run('request_map', staged, reqCtxBase);
    staged = await engReq.run('request_post', staged, reqCtxBase);
    return staged;
  }

  async convertResponse(payload: any, _profile: ConversionProfile, _context: ConversionContext): Promise<any> {
    await this.ensureInit();
    try {
      const src = (payload && typeof payload === 'object') ? (payload as any) : {};
      // 在映射为 Anthropic 形状之前，先用响应侧 Filter 规范化（tool_calls/arguments/finish_reason）
      const resCtxBase: Omit<FilterContext,'stage'> = {
        requestId: String(_context.requestId || `req_${Date.now()}`),
        model: undefined,
        endpoint: '/v1/messages',
        profile: 'anthropic-openai',
        debug: { emit: () => {} }
      };
      const engRes = new FilterEngine();
      engRes.registerFilter(new ResponseToolTextCanonicalizeFilter());
      engRes.registerFilter(new ResponseToolArgumentsStringifyFilter());
      engRes.registerFilter(new ResponseFinishInvariantsFilter());
      let staged = await engRes.run('response_pre', src, resCtxBase);
      staged = await engRes.run('response_map', staged, resCtxBase);
      staged = await engRes.run('response_post', staged, resCtxBase);
      const choice = Array.isArray(src.choices) && src.choices.length ? src.choices[0] : {};
      const msg = (staged as any)?.choices?.[0]?.message || choice?.message || {};
      const contentBlocks: any[] = [];
      const text = typeof msg?.content === 'string' ? msg.content : '';
      if (text && text.trim()) contentBlocks.push({ type: 'text', text });
      if (Array.isArray(msg?.tool_calls)) {
        for (const tc of (msg.tool_calls as any[])) {
          const name = typeof tc?.function?.name === 'string' ? tc.function.name : undefined;
          const id = typeof tc?.id === 'string' ? tc.id : undefined;
          const argStr = typeof tc?.function?.arguments === 'string' ? tc.function.arguments : (tc?.function?.arguments != null ? JSON.stringify(tc.function.arguments) : '{}');
          let input: any = {};
          try { input = JSON.parse(argStr); } catch { input = {}; }
          if (name) contentBlocks.push({ type: 'tool_use', id: id || `tool_${Math.random().toString(36).slice(2,10)}`, name, input });
        }
      }
      const stopReasonMap: Record<string, string> = { tool_calls: 'tool_use', stop: 'end_turn', length: 'max_tokens' };
      const finish = ((staged as any)?.choices?.[0]?.finish_reason ?? choice?.finish_reason) as string | undefined;
      const stop_reason = (finish && stopReasonMap[finish]) ? stopReasonMap[finish]
        : (contentBlocks.some(b => b?.type === 'tool_use') ? 'tool_use' : 'end_turn');

      const out = {
        id: src.id || `msg_${Date.now()}_${Math.random().toString(36).slice(2,9)}`,
        type: 'message',
        role: 'assistant',
        model: src.model || 'unknown',
        content: contentBlocks,
        stop_reason,
        usage: ((): any => {
          const u = (staged as any)?.usage || src.usage || {};
          const input_tokens = (typeof u.prompt_tokens === 'number') ? u.prompt_tokens : (typeof u.input_tokens === 'number' ? u.input_tokens : 0);
          const output_tokens = (typeof u.completion_tokens === 'number') ? u.completion_tokens : (typeof u.output_tokens === 'number' ? u.output_tokens : 0);
          return (input_tokens || output_tokens) ? { input_tokens, output_tokens } : undefined;
        })()
      } as any;
      return out;
    } catch {
      return payload;
    }
  }
}
