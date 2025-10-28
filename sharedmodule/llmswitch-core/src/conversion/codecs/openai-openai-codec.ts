import type { ConversionCodec, ConversionContext, ConversionProfile } from '../types.js';
import { normalizeChatRequest, normalizeChatResponse, normalizeTools } from '../index.js';

// Ported from root package (no behavior changes). Types relaxed to avoid root coupling.
export class OpenAIOpenAIConversionCodec implements ConversionCodec {
  readonly id = 'openai-openai';
  private initialized = false;

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(private readonly dependencies: any) {}

  async initialize(): Promise<void> { this.initialized = true; }

  async convertRequest(payload: any, profile: ConversionProfile, context: ConversionContext): Promise<any> {
    await this.ensureInit();
    const dto: any = {
      data: payload,
      route: {
        providerId: 'unknown',
        modelId: (payload && typeof payload === 'object' && (payload as any).model) ? String((payload as any).model) : 'unknown',
        requestId: context.requestId ?? `req_${Date.now()}`,
        timestamp: Date.now()
      },
      metadata: {
        endpoint: context.endpoint ?? context.entryEndpoint,
        entryEndpoint: context.entryEndpoint,
        targetProtocol: profile.outgoingProtocol
      },
      debug: { enabled: false, stages: {} }
    };
    // Normalize OpenAI Chat request; unify tool definitions using core normalizeTools
    const normalized = normalizeChatRequest(dto.data);
    try {
      const tools = (normalized as any)?.tools;
      if (Array.isArray(tools)) {
        (normalized as any).tools = normalizeTools(tools as any[]);
      }
    } catch { /* ignore */ }
    try {
      const msgs = Array.isArray((normalized as any)?.messages) ? (normalized as any).messages : [];
      for (const m of msgs) {
        if (!m || m.role !== 'assistant' || !Array.isArray(m.tool_calls)) continue;
        m.tool_calls = m.tool_calls.map((tc: any) => {
          if (!tc || typeof tc !== 'object') return tc;
          const fn = tc.function || {};
          // Ensure arguments is a JSON string without reshaping; trust schema
          if (fn && typeof fn === 'object' && fn.arguments !== undefined && typeof fn.arguments !== 'string') {
            try { fn.arguments = JSON.stringify(fn.arguments); } catch { fn.arguments = '""'; }
          }
          return { ...tc, function: fn };
        });
      }
    } catch { /* ignore */ }
    return normalized;
  }

  async convertResponse(payload: any, _profile: ConversionProfile, context: ConversionContext): Promise<any> {
    await this.ensureInit();
    // unwrap nested { data: {...} } wrappers until we reach an object
    const unwrap = (obj: any): any => {
      let cur = obj;
      const guard = new Set<any>();
      while (cur && typeof cur === 'object' && !Array.isArray(cur) && !guard.has(cur)) {
        guard.add(cur);
        if ('choices' in cur || 'id' in cur || 'object' in cur) { break; }
        if ('data' in cur && cur.data && typeof cur.data === 'object') { cur = cur.data; continue; }
        break;
      }
      return cur;
    };
    const unwrapped = unwrap(payload);
    const dto: any = {
      data: unwrapped,
      metadata: {
        requestId: context.requestId ?? `req_${Date.now()}`,
        pipelineId: (context.metadata as any)?.pipelineId as string ?? 'conversion-router',
        processingTime: 0,
        stages: []
      }
    };
    // Minimal response normalization: ensure final shape; do not reshape tool_calls
    return normalizeChatResponse(dto.data);
  }

  private async ensureInit(): Promise<void> { if (!this.initialized) await this.initialize(); }
}

