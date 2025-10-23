/**
 * Responses <-> Chat conversion utilities
 * - Normalize incoming /v1/responses requests
 * - Convert Responses-shaped request to OpenAI Chat request (non-stream)
 * - Convert provider Chat responses to Responses JSON (non-stream)
 */

import type { Request } from 'express';
import { RouteCodexError } from '../types.js';

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
    } catch (e) {
      // 不允许 fallback：严格报错
      const msg = (e as Error)?.message || 'Responses→Chat conversion failed';
      throw new RouteCodexError(msg, 'conversion_error', 400);
    }
    // 理论上不可达：上面的 try 要么 return，要么抛错
    throw new RouteCodexError('Responses→Chat conversion returned no result', 'conversion_error', 500);
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
      throw new RouteCodexError('Provider→Responses produced non-Responses payload', 'conversion_error', 502);
    } catch (e) {
      const msg = (e as Error)?.message || 'Provider→Responses conversion failed';
      throw new RouteCodexError(msg, 'conversion_error', 502);
    }
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
