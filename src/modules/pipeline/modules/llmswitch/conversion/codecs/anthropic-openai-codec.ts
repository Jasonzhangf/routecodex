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
    // Minimal conversion: flatten Anthropc-style content arrays to string for OpenAI Chat
    const r = (payload && typeof payload === 'object') ? (payload as Record<string, unknown>) : {};
    const out: any = { ...r };
    if (Array.isArray(out.messages)) {
      out.messages = (out.messages as any[]).map((m: any) => {
        if (!m || typeof m !== 'object') return m;
        const role = typeof m.role === 'string' ? m.role : 'user';
        const c = (m as any).content;
        if (Array.isArray(c)) {
          const text = c
            .map((p: any) => (p && typeof p === 'object' && typeof p.text === 'string') ? p.text : (typeof p === 'string' ? p : ''))
            .filter((s: string) => !!String(s).trim())
            .join('\n');
          return { role, content: text };
        }
        return m;
      });
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
