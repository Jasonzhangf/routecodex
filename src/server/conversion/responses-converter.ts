/**
 * Responses <-> Chat conversion utilities
 * - Normalize incoming /v1/responses requests
 * - Convert Responses-shaped request to OpenAI Chat request (non-stream)
 * - Convert provider Chat responses to Responses JSON (non-stream)
 */

import type { Request } from 'express';

export interface NormalizedResponsesRequest {
  model: string;
  stream?: boolean;
  instructions?: string;
  input?: unknown;
  tools?: unknown;
  tool_choice?: unknown;
  parallel_tool_calls?: unknown;
}

export interface ChatRequestPayload {
  model: string;
  stream: boolean;
  messages: Array<Record<string, unknown>>;
  tools?: unknown;
  tool_choice?: unknown;
  parallel_tool_calls?: unknown;
}

export class ResponsesConverter {
  static inferStreamingFlag(body: any, req: Request): boolean | undefined {
    if (typeof body?.stream === 'boolean') return body.stream;
    const accept = String(req.headers['accept'] || '').toLowerCase();
    return accept.includes('text/event-stream') ? true : undefined;
  }

  static normalizeIncoming(body: any, req: Request): NormalizedResponsesRequest {
    const out: NormalizedResponsesRequest = {
      model: typeof body?.model === 'string' ? body.model : 'unknown'
    };
    const s = this.inferStreamingFlag(body, req);
    if (typeof s === 'boolean') out.stream = s;
    if (typeof body?.instructions === 'string') out.instructions = body.instructions;
    if (typeof body?.input !== 'undefined') out.input = body.input;
    if (typeof body?.tools !== 'undefined') out.tools = body.tools;
    if (typeof body?.tool_choice !== 'undefined') out.tool_choice = body.tool_choice;
    if (typeof body?.parallel_tool_calls !== 'undefined') out.parallel_tool_calls = body.parallel_tool_calls;

    // If the client sent Chat messages, derive input/instructions when missing
    try {
      const sys: string[] = [];
      const userTexts: string[] = [];
      if (Array.isArray(body?.messages)) {
        for (const m of body.messages) {
          if (!m || typeof m !== 'object') continue;
          const role = (m as any).role;
          const content = (m as any).content;
          if (role === 'system' && typeof content === 'string' && content.trim()) sys.push(content.trim());
          if (role === 'user' && typeof content === 'string' && content.trim()) userTexts.push(content.trim());
          if (role === 'user' && Array.isArray(content)) {
            for (const part of content) {
              if (part && typeof part === 'object' && typeof (part as any).text === 'string' && (part as any).text.trim()) {
                userTexts.push((part as any).text.trim());
              }
            }
          }
        }
      }
      if (!out.instructions && sys.length) out.instructions = sys.join('\n\n');
      if (typeof out.input === 'undefined' && userTexts.length) out.input = userTexts.join('\n');
    } catch { /* ignore */ }

    return out;
  }

  /** Build OpenAI Chat request from a Responses-shaped payload */
  static async toChatRequest(payload: NormalizedResponsesRequest | any, req?: Request, modelOverride?: string): Promise<ChatRequestPayload> {
    // Prefer llmswitch if available
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { ResponsesToChatLLMSwitch } = require('../../modules/pipeline/modules/llmswitch/llmswitch-response-chat.js');
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { PipelineDebugLogger } = require('../../modules/pipeline/utils/debug-logger.js');
      const logger = new PipelineDebugLogger(null, { enableConsoleLogging: false, enableDebugCenter: false });
      const deps = { errorHandlingCenter: {}, debugCenter: {}, logger } as any;
      const conv = new ResponsesToChatLLMSwitch({ type: 'llmswitch-response-chat', config: {} }, deps);
      if (typeof conv.initialize === 'function') { await conv.initialize(); }
      const dto = await conv.processIncoming({ data: payload, route: { providerId: 'unknown', modelId: modelOverride || payload?.model || 'unknown', requestId: (req as any)?.requestId || `req_${Date.now()}`, timestamp: Date.now() }, metadata: {}, debug: { enabled: false, stages: {} } });
      const result = (dto?.data || {}) as Record<string, unknown>;
      const chat: ChatRequestPayload = {
        model: String(result.model || modelOverride || payload?.model || 'unknown'),
        stream: false,
        messages: Array.isArray(result.messages) ? (result.messages as Array<Record<string, unknown>>) : [],
        ...(typeof result.tools !== 'undefined' ? { tools: result.tools } : {}),
        ...(typeof result.tool_choice !== 'undefined' ? { tool_choice: result.tool_choice } : {}),
        ...(typeof result.parallel_tool_calls !== 'undefined' ? { parallel_tool_calls: result.parallel_tool_calls } : {})
      };
      return chat;
    } catch {
      // Fallback minimal conversion
      const messages: Array<Record<string, unknown>> = [];
      const pushText = (role: string, value: unknown) => {
        if (value == null) return;
        if (typeof value === 'string') {
          const t = value.trim();
          if (t) messages.push({ role, content: t });
          return;
        }
        if (Array.isArray(value)) {
          const texts = (value as Array<any>)
            .map((v) => (v && typeof v.text === 'string') ? v.text.trim() : '')
            .filter(Boolean);
          if (texts.length) messages.push({ role, content: texts.join('\n') });
          return;
        }
        try { messages.push({ role, content: JSON.stringify(value) }); } catch { messages.push({ role, content: String(value) }); }
      };
      if (payload?.instructions) pushText('system', payload.instructions);
      if (payload?.input !== undefined) pushText('user', payload.input);
      return {
        model: String(modelOverride || payload?.model || 'unknown'),
        stream: false,
        messages,
        ...(typeof payload?.tools !== 'undefined' ? { tools: payload.tools } : {}),
        ...(typeof payload?.tool_choice !== 'undefined' ? { tool_choice: payload.tool_choice } : {}),
        ...(typeof payload?.parallel_tool_calls !== 'undefined' ? { parallel_tool_calls: payload.parallel_tool_calls } : {})
      } as ChatRequestPayload;
    }
  }

  /** Convert provider Chat payload to Responses JSON (non-stream) */
  static async fromProviderToResponses(payload: unknown, context?: { instructions?: string; metadata?: Record<string, unknown> }): Promise<Record<string, unknown>> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { ResponsesToChatLLMSwitch } = require('../../modules/pipeline/modules/llmswitch/llmswitch-response-chat.js');
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { PipelineDebugLogger } = require('../../modules/pipeline/utils/debug-logger.js');
      const logger = new PipelineDebugLogger(null, { enableConsoleLogging: false, enableDebugCenter: false });
      const deps = { errorHandlingCenter: {}, debugCenter: {}, logger } as any;
      const conv = new ResponsesToChatLLMSwitch({ type: 'llmswitch-response-chat', config: {} }, deps);
      if (typeof conv.initialize === 'function') { await conv.initialize(); }
      const converted = await conv.transformResponse(payload);
      if (converted && typeof converted === 'object' && (converted as any).object === 'response') {
        if (context && typeof context.instructions === 'string' && (context.instructions as string).trim()) {
          (converted as any).instructions = context.instructions;
        }
        if (context && context.metadata && typeof (converted as any).metadata === 'object') {
          (converted as any).metadata = { ...(converted as any).metadata, ...context.metadata };
        }
        return converted as Record<string, unknown>;
      }
    } catch { /* ignore */ }

    // Fallback minimal mapping (text only)
    const text = (() => {
      try {
        const s = (payload as any)?.choices?.[0]?.message?.content;
        if (typeof s === 'string') return s;
        if (Array.isArray(s)) {
          const t = s.map((p: any) => (p && typeof p.text === 'string') ? p.text : (typeof p === 'string' ? p : '')).filter(Boolean).join(' ');
          return t;
        }
      } catch { /* ignore */ }
      return '';
    })();
    const model = (payload as any)?.model || 'unknown';
    return {
      id: (payload as any)?.id || `resp_${Date.now()}`,
      object: 'response',
      created: Math.floor(Date.now() / 1000),
      model,
      status: 'completed',
      output: text ? [{ type: 'message', message: { role: 'assistant', content: [{ type: 'output_text', text }] } }] : [],
      output_text: text,
      ...(context?.instructions ? { instructions: context.instructions } : {})
    } as Record<string, unknown>;
  }

  static mapUsage(u: any): { input_tokens: number; output_tokens: number; total_tokens: number } | undefined {
    if (!u || typeof u !== 'object') return undefined;
    const input = (typeof u.input_tokens === 'number') ? u.input_tokens
      : (typeof u.prompt_tokens === 'number') ? u.prompt_tokens : 0;
    const output = (typeof u.output_tokens === 'number') ? u.output_tokens
      : (typeof u.completion_tokens === 'number') ? u.completion_tokens : 0;
    const total = (typeof u.total_tokens === 'number') ? u.total_tokens : (input + output);
    return { input_tokens: input, output_tokens: output, total_tokens: total };
  }
}

