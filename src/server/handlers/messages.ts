/**
 * Messages Handler Implementation
 * Handles Anthropic-compatible messages requests
 */

import { type Request, type Response } from 'express';
import { BaseHandler, type ProtocolHandlerConfig } from './base-handler.js';
import { RouteCodexError } from '../types.js';
import { StreamingManager } from '../utils/streaming-manager.js';

/**
 * Messages Handler
 * Handles /v1/messages endpoint for Anthropic compatibility
 */
export class MessagesHandler extends BaseHandler {
  private streamingManager: StreamingManager;

  constructor(config: ProtocolHandlerConfig) {
    super(config);
    this.streamingManager = new StreamingManager(config);
  }

  /**
   * Handle messages request
   */
  async handleRequest(req: Request, res: Response): Promise<void> {
    const startTime = Date.now();
    const requestId = this.generateRequestId();

    this.logger.logModule('MessagesHandler', 'request_start', {
      requestId,
      model: req.body.model,
      messageCount: req.body.messages?.length || 0,
      maxTokens: req.body.max_tokens,
      streaming: req.body.stream || false,
      tools: !!req.body.tools,
      timestamp: startTime,
    });

    try {
      // 不做自作主张的输入校验；失败在后续阶段快速暴露（不兜底）

      // Process request
      const pipelineResponse = await this.processMessagesRequest(req, requestId);

      // Handle streaming vs non-streaming response
      if (req.body.stream) {
        const streamModel = (pipelineResponse && typeof pipelineResponse === 'object' && 'data' in pipelineResponse)
          ? ((pipelineResponse as any).data?.model ?? req.body.model)
          : req.body.model;

        // 默认开启真流式：未设置时视为启用；仅当显式为 '0' 或 'false' 时关闭
        // 与 OpenAI 通路保持一致：默认不用特定 O2A 流转换，除非显式开启
        const _flag = process.env.RCC_O2A_STREAM;
        const useO2AStream = (_flag === '1') || (_flag?.toLowerCase?.() === 'true');
        try {
          // Prefer true streaming conversion when upstream is a Readable and RCC_O2A_STREAM=1
          const topReadable = pipelineResponse && typeof (pipelineResponse as any).pipe === 'function' ? (pipelineResponse as any) : null;
          const nestedReadable = (!topReadable && pipelineResponse && typeof (pipelineResponse as any).data?.pipe === 'function') ? (pipelineResponse as any).data : null;
          const readable = topReadable || nestedReadable;
          if (useO2AStream && readable) {
          const mod = await import('rcc-llmswitch-core');
          const core: any = (mod as any).LLMSwitchV2 || mod;
          const windowMs = Number(process.env.RCC_O2A_COALESCE_MS || 1000) || 1000;
          await core.transformOpenAIStreamToAnthropic(readable, res, { requestId, model: streamModel, windowMs, useEventHeaders: true });
            return;
          }
        } catch {
          // fall through to generic streamer on failure
        }

        await this.streamingManager.streamAnthropicResponse(pipelineResponse, requestId, res, streamModel);
        return;
      }

      // Return JSON response (convert OpenAI→Anthropic for non-streaming)
      const raw = pipelineResponse && typeof pipelineResponse === 'object' && 'data' in pipelineResponse
        ? (pipelineResponse as Record<string, unknown>).data
        : pipelineResponse;

      const toAnthropicMessage = (openai: any): any => {
        try {
          const ch = Array.isArray(openai?.choices) ? openai.choices[0] : null;
          const msg = ch?.message || {};
          const contentBlocks: any[] = [];
          // text content
          if (typeof msg?.content === 'string' && msg.content.length) {
            contentBlocks.push({ type: 'text', text: msg.content });
          }
          // tool calls → tool_use blocks
          if (Array.isArray(msg?.tool_calls)) {
            for (const tc of msg.tool_calls) {
              const fn = tc?.function || {};
              const name = typeof fn?.name === 'string' ? fn.name : undefined;
              let input: any = {};
              if (typeof fn?.arguments === 'string') { try { input = JSON.parse(fn.arguments); } catch { input = {}; } }
              else if (fn?.arguments && typeof fn.arguments === 'object') { input = fn.arguments; }
              contentBlocks.push({ type: 'tool_use', id: tc?.id || `call_${Date.now()}`, name, input });
            }
          }
          const finish = ch?.finish_reason === 'tool_calls' ? 'tool_use' : (ch?.finish_reason || 'stop');
          const out = {
            id: openai?.id || `msg_${Date.now()}`,
            type: 'message',
            role: 'assistant',
            model: openai?.model || (raw as any)?.model || req.body?.model,
            content: contentBlocks,
            stop_reason: finish,
            usage: openai?.usage || undefined
          };
          return out;
        } catch {
          return raw;
        }
      };

      const looksOpenAI = raw && typeof raw === 'object' && Array.isArray((raw as any).choices);
      const payload = looksOpenAI ? toAnthropicMessage(raw) : raw;
      this.sendJsonResponse(res, payload, requestId);

      this.logCompletion(requestId, startTime, true);
    } catch (error) {
      this.logCompletion(requestId, startTime, false);
      await this.handleError(error as Error, res, requestId);
    }
  }

  /**
   * Process messages request
   */
  private async processMessagesRequest(req: Request, requestId: string): Promise<any> {
    if (this.shouldUsePipeline() && this.getRoutePools()) {
      return await this.processWithPipeline(req, requestId);
    }

    throw new RouteCodexError('Messages pipeline unavailable', 'pipeline_unavailable', 503);
  }

  /**
   * Process request through pipeline
   */
  private async processWithPipeline(req: Request, requestId: string): Promise<any> {
    const routeName = await this.decideRouteCategoryAsync(req, '/v1/messages');
    const pipelineId = this.pickPipelineId(routeName);
    const routeMeta = this.getRouteMeta();
    const meta = routeMeta ? routeMeta[pipelineId] : undefined;
    const providerId = meta?.providerId ?? 'unknown';
    const modelId = meta?.modelId ?? 'unknown';

    // Convert Anthropic messages to standard format
    const payload = { ...(req.body || {}), ...(modelId ? { model: modelId } : {}) };
    const pipelineRequest = {
      data: payload,
      route: {
        providerId,
        modelId,
        requestId,
        timestamp: Date.now(),
        pipelineId,
      },
      metadata: {
        method: req.method,
        url: req.url,
        headers: this.sanitizeHeaders(req.headers),
        targetProtocol: 'anthropic',
        endpoint: `${req.baseUrl || ''}${req.url || ''}`,
        entryEndpoint: '/v1/messages',
      },
      debug: {
        enabled: this.config.enableMetrics ?? true,
        stages: {
          llmSwitch: true,
          workflow: true,
          compatibility: true,
          provider: true,
        },
      },
    };

    const pipelineTimeoutMs = Number(process.env.ROUTECODEX_PIPELINE_MAX_WAIT_MS || 300000);
    const pipelineResponse = await Promise.race([
      this.getPipelineManager()?.processRequest?.(pipelineRequest) || Promise.reject(new Error('Pipeline manager not available')),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`Pipeline timeout after ${pipelineTimeoutMs}ms`)), Math.max(1, pipelineTimeoutMs)))
    ]);

    return pipelineResponse;
  }
}
