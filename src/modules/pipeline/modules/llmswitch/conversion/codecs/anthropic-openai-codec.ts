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
            const name = typeof (block as any).name === 'string' ? (block as any).name : undefined;
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
      const mappedTools = (out.tools as any[]).map((t: any) => {
        if (!t || typeof t !== 'object') return t;
        const name = typeof t.name === 'string' ? t.name : undefined;
        const description = typeof t.description === 'string' ? t.description : undefined;
        const params = (t as any).input_schema && typeof (t as any).input_schema === 'object'
          ? (t as any).input_schema
          : undefined;
        if (!name) return null;
        return { type: 'function', function: { name, ...(description ? { description } : {}), ...(params ? { parameters: params } : {}) } };
      }).filter(Boolean);
      if (mappedTools.length) { out.tools = mappedTools; }
    }

    return out;
  }

  async convertResponse(payload: any, profile: ConversionProfile, context: ConversionContext): Promise<any> {
    await this.ensureInit();
    // No-op for response in this minimal codec
    return payload;
  }

  private async ensureInit(): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }
  }
}
// (removed duplicate class definition)
