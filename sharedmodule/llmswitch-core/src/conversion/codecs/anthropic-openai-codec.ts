import type { ConversionCodec, ConversionContext, ConversionProfile } from '../types.js';

// CCR-aligned Anthropic <-> OpenAI (Chat) codec
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
    const sanitizeToolName = (name: string | undefined): string | undefined => {
      if (!name) return name;
      const s = name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
      return s.length ? s : undefined;
    };
    for (const m of srcMsgs) {
      if (!m || typeof m !== 'object') continue;
      const role = typeof m.role === 'string' ? m.role : 'user';
      const content = (m as any).content;
      if (Array.isArray(content)) {
        const textParts: string[] = [];
        const toolCalls: any[] = [];
        for (const block of content) {
          if (!block) continue;
          const t = String((block as any).type || '').toLowerCase();
          if (t === 'text' && typeof (block as any).text === 'string') {
            const s = (block as any).text.trim(); if (s) textParts.push(s);
          } else if (t === 'tool_use') {
            const rawName = typeof (block as any).name === 'string' ? (block as any).name : undefined;
            const name = sanitizeToolName(rawName);
            const id = typeof (block as any).id === 'string' ? (block as any).id : undefined;
            const input = (block as any).input ?? {};
            if (name) {
              let args = '{}';
              try { args = JSON.stringify(input ?? {}); } catch { args = '{}'; }
              toolCalls.push({ id, type: 'function', function: { name, arguments: args } });
            }
          }
        }
        const msg: any = { role, content: textParts.join('\n') };
        if (toolCalls.length) msg.tool_calls = toolCalls;
        newMessages.push(msg);
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
        const name = sanitizeToolName(rawName);
        const description = typeof t.description === 'string' ? t.description : undefined;
        const params = (t as any).input_schema && typeof (t as any).input_schema === 'object'
          ? pruneSchema((t as any).input_schema)
          : undefined;
        if (!name) return null;
        return { type: 'function', function: { name, ...(description ? { description } : {}), ...(params ? { parameters: params } : {}) } };
      }).filter(Boolean);

      const allowEnv = String(process.env.RCC_ALLOWED_TOOLS || '').trim();
      const allowFromEnv = allowEnv ? allowEnv.split(',').map(s => s.trim()).filter(Boolean) : [];
      const allow = new Set<string>([
        'shell','update_plan','view_image','list_mcp_resources','read_mcp_resource','list_mcp_resource_templates',
        ...allowFromEnv
      ]);
      const filtered = (mappedTools as any[]).filter((x: any) => allow.has(String(x?.function?.name || '')));
      const limit = Math.max(1, Number(process.env.RCC_TOOL_LIMIT || 32));
      const limited = filtered.slice(0, limit);
      if (limited.length > 0) {
        out.tools = limited as any[];
      } else {
        delete out.tools;
      }
    }

    // 4) 若存在 tools 且未指定 tool_choice，默认 auto
    try {
      if (Array.isArray(out.tools) && out.tools.length > 0) {
        if (typeof out.tool_choice === 'undefined') out.tool_choice = 'auto';
        else if (out.tool_choice !== 'auto') out.tool_choice = 'auto';
      }
    } catch { /* ignore */ }

    // Run unified OpenAI tooling stage to normalize/optimize tools once
    try {
      const { applyOpenAIToolingStage } = await import('../shared/openai-tooling-stage.js');
      return applyOpenAIToolingStage(out as any);
    } catch {
      return out;
    }
  }

  async convertResponse(payload: any, _profile: ConversionProfile, _context: ConversionContext): Promise<any> {
    await this.ensureInit();
    try {
      const src = (payload && typeof payload === 'object') ? (payload as any) : {};
      const choice = Array.isArray(src.choices) && src.choices.length ? src.choices[0] : {};
      const msg = choice?.message || {};
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
      const finish = choice?.finish_reason as string | undefined;
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
          const u = src.usage || {};
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
