import type { ModuleDependencies } from '../../../../interfaces/pipeline-interfaces.js';
import type { ConversionCodec, ConversionContext, ConversionProfile } from '../types.js';
import type { SharedPipelineRequest, SharedPipelineResponse } from '../../../../../../types/shared-dtos.js';

export class AnthropicOpenAIConversionCodec implements ConversionCodec {
  readonly id = 'anthropic-openai';
  private initialized = false;
  constructor(private readonly dependencies: ModuleDependencies) {}

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }
    this.initialized = true;
  }

  async convertRequest(payload: any, profile: ConversionProfile, context: ConversionContext): Promise<any> {
    await this.ensureInit();
    const r = (payload && typeof payload === 'object') ? (payload as Record<string, unknown>) : {};
    const out: any = { ...r };

    // 1) system 字段注入到消息头（OpenAI Chat 使用 system role）
    const sys = typeof out.system === 'string' && out.system.trim() ? String(out.system) : undefined;
    const newMessages: any[] = [];
    if (sys) { newMessages.push({ role: 'system', content: sys }); }

    // 2) 消息转换：Anthropic content[] → OpenAI content(string) + tool_calls（从 tool_use 提取）
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
              let args = '{}'; try { args = JSON.stringify(input ?? {}); } catch { args = '{}'; }
              toolCalls.push({ id, type: 'function', function: { name, arguments: args } });
            }
          }
        }
        const msg: any = { role, content: textParts.join('\n') };
        if (toolCalls.length) { msg.tool_calls = toolCalls; }
        newMessages.push(msg);
      } else if (typeof content === 'string') {
        newMessages.push({ role, content });
      } else {
        // Fallback：保留为字符串
        newMessages.push({ role, content: String(content ?? '') });
      }
    }
    if (newMessages.length) { out.messages = newMessages; } else { delete out.messages; }
    if (sys) { delete out.system; }

    // 3) 工具定义转换：Anthropic tools → OpenAI function tools
    if (Array.isArray(out.tools)) {
      const pruneSchema = (schema: any): any => {
        try {
          if (!schema || typeof schema !== 'object') return undefined;
          const clone = JSON.parse(JSON.stringify(schema));
          // 移除可能不被上游接受的 meta 字段
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
      // 过滤仅允许的工具（对齐 CCR：仅保留我们支持的、且上游可接受的函数工具）
      const allowEnv = String(process.env.RCC_ALLOWED_TOOLS || '').trim();
      const allowFromEnv = allowEnv ? allowEnv.split(',').map(s => s.trim()).filter(Boolean) : [];
      const allow = new Set<string>([ 'shell','update_plan','view_image','list_mcp_resources','read_mcp_resource','list_mcp_resource_templates', ...allowFromEnv ]);
      const filtered = (mappedTools as any[]).filter((x: any) => allow.has(String(x?.function?.name || '')));
      // 限制工具数量，避免上游超限（可通过 RCC_TOOL_LIMIT 调整，默认 32）
      const limit = Math.max(1, Number(process.env.RCC_TOOL_LIMIT || 32));
      const limited = filtered.slice(0, limit);
      // 必须用映射/过滤结果替换原 tools；若为空则删除，避免下游收到非 OpenAI 形状引发 1214
      if (limited.length > 0) {
        out.tools = limited as any[];
      } else {
        delete out.tools;
      }
    }

    // 4) 若存在 tools 且未指定 tool_choice，默认使用 auto（与 CCR 对齐）
    try {
      if (Array.isArray(out.tools) && out.tools.length > 0) {
        if (typeof out.tool_choice === 'undefined') {
          out.tool_choice = 'auto';
        }
      }
    } catch { /* ignore */ }

    return out;
  }

  async convertResponse(payload: any, profile: ConversionProfile, context: ConversionContext): Promise<any> {
    await this.ensureInit();
    try {
      const src = (payload && typeof payload === 'object') ? (payload as any) : {};
      // Expect OpenAI Chat response with choices[].message
      const choice = Array.isArray(src.choices) && src.choices.length ? src.choices[0] : {};
      const msg = choice?.message || {};
      const contentBlocks: any[] = [];
      const text = typeof msg?.content === 'string' ? msg.content : '';
      if (text && text.trim()) {
        contentBlocks.push({ type: 'text', text });
      }
      if (Array.isArray(msg?.tool_calls)) {
        for (const tc of (msg.tool_calls as any[])) {
          const name = typeof tc?.function?.name === 'string' ? tc.function.name : undefined;
          const id = typeof tc?.id === 'string' ? tc.id : undefined;
          const argStr = typeof tc?.function?.arguments === 'string' ? tc.function.arguments : (tc?.function?.arguments != null ? JSON.stringify(tc.function.arguments) : '{}');
          let input: any = {};
          try { input = JSON.parse(argStr); } catch { input = {}; }
          if (name) {
            contentBlocks.push({ type: 'tool_use', id: id || `tool_${Math.random().toString(36).slice(2,10)}`, name, input });
          }
        }
      }
      const stopReasonMap: Record<string, string> = {
        tool_calls: 'tool_use',
        stop: 'end_turn',
        length: 'max_tokens',
      };
      const finish = choice?.finish_reason as string | undefined;
      const stop_reason = (finish && stopReasonMap[finish]) ? stopReasonMap[finish] : (contentBlocks.some(b => b?.type === 'tool_use') ? 'tool_use' : 'end_turn');

      // Build Anthropic Messages response
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

  private async ensureInit(): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }
  }
}
// (removed duplicate class definition)
