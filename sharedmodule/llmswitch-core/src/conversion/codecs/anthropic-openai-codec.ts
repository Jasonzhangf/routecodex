import type { ConversionCodec, ConversionContext, ConversionProfile } from '../types.js';

// Ported from root package (no behavior change); minimal conversion for request; response passthrough
export class AnthropicOpenAIConversionCodec implements ConversionCodec {
  readonly id = 'anthropic-openai';
  private initialized = false;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(private readonly dependencies: any) {}

  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
  }

  async convertRequest(payload: any, _profile: ConversionProfile, _context: ConversionContext): Promise<any> {
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

  async convertResponse(payload: any, _profile: ConversionProfile, _context: ConversionContext): Promise<any> {
    await this.ensureInit();
    // No-op for response in this minimal codec
    return payload;
  }

  private async ensureInit(): Promise<void> { if (!this.initialized) await this.initialize(); }
}

