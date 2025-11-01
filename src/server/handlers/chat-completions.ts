/**
 * Chat Completions Handler Implementation
 * Handles OpenAI-compatible chat completion requests
 */

import { type Request, type Response } from 'express';
import { BaseHandler, type ProtocolHandlerConfig } from './base-handler.js';
import { type RequestContext, type OpenAIChatCompletionRequest } from '../types.js';
import { RouteCodexError } from '../types.js';
import { RequestValidator } from '../utils/request-validator.js';
import { ResponseNormalizer } from '../utils/response-normalizer.js';
import { StreamingManager } from '../utils/streaming-manager.js';
import { ProtocolDetector } from '../protocol/protocol-detector.js';
import { OpenAIAdapter } from '../protocol/openai-adapter.js';
import { PipelineDebugLogger } from '../../modules/pipeline/utils/debug-logger.js';
import { ErrorContextBuilder, EnhancedRouteCodexError, type ErrorContext } from '../utils/error-context.js';
import os from 'os';
import path from 'path';

/**
 * Chat Completions Handler
 * Handles /v1/chat/completions endpoint
 */
export class ChatCompletionsHandler extends BaseHandler {
  private requestValidator: RequestValidator;
  private responseNormalizer: ResponseNormalizer;
  private streamingManager: StreamingManager;

  constructor(config: ProtocolHandlerConfig) {
    super(config);
    this.requestValidator = new RequestValidator();
    this.responseNormalizer = new ResponseNormalizer();
    this.streamingManager = new StreamingManager(config);
  }

  /**
   * Handle chat completions request
  */
  async handleRequest(req: Request, res: Response): Promise<void> {
    const startTime = Date.now();
    const requestId = this.generateRequestId();

    // 记录开始时间用于错误上下文
    (req as any).__startTime = startTime;
    // Capture raw request for debugging
    try {
      const rawBody = JSON.parse(JSON.stringify((req as any).body || {}));
      (req as any).__rawBody = rawBody;
      const fs = await import('fs/promises');
      const dir = path.join(os.homedir(), '.routecodex', 'codex-samples', 'openai-chat');
      await (fs as any).mkdir(dir, { recursive: true });
      const rawFile = path.join(dir, `${requestId}_raw-request.json`);
      const payload = {
        requestId,
        method: req.method,
        url: req.originalUrl || req.url,
        headers: this.sanitizeHeaders(req.headers),
        body: rawBody,
      };
      await (fs as any).writeFile(rawFile, JSON.stringify(payload, null, 2), 'utf-8');
    } catch (error) {
      // 快速死亡原则 - 暴露捕获失败的原因
      throw new EnhancedRouteCodexError(error as Error, {
        module: 'ChatCompletionsHandler',
        file: 'src/server/handlers/chat-completions.ts',
        function: 'handleRequest',
        line: 58,
        requestId,
        additional: {
          operation: 'raw-request-capture',
          payload: ErrorContextBuilder.safeStringify({
            requestId,
            method: req.method,
            url: req.originalUrl || req.url
          }, 500)
        }
      });
    }

    this.logModule('ChatCompletionsHandler', 'request_start', {
      requestId,
      model: req.body.model,
      messageCount: req.body.messages?.length || 0,
      streaming: req.body.stream || false,
      tools: !!req.body.tools,
      timestamp: startTime,
    });

    try {
      // 可选：受控的“静态”系统提示注入（默认关闭）。
      // 禁止样本抓取式注入；仅当明确配置 ROUTECODEX_ENABLE_SERVER_SYSTEM_PROMPT=1 且提供
      // ROUTECODEX_SERVER_SYSTEM_PROMPT=</path/to/prompt.txt> 时，才会替换/插入一条 system。
      try {
        const enable = String(process.env.ROUTECODEX_ENABLE_SERVER_SYSTEM_PROMPT || '0') === '1';
        const filePath = String(process.env.ROUTECODEX_SERVER_SYSTEM_PROMPT || '').trim();
        if (enable && filePath && Array.isArray((req.body as any)?.messages)) {
          const fs = await import('fs/promises');
          const sysText = await fs.readFile(filePath, 'utf-8');
          const messages = (req.body as any).messages as any[];
          const currentSys = (() => {
            try {
              const m = messages[0];
              return (m && typeof m === 'object' && m.role === 'system' && typeof m.content === 'string') ? String(m.content) : '';
            } catch { return ''; }
          })();
          const hasMdMarkers = /\bCLAUDE\.md\b|\bAGENT(?:S)?\.md\b/i.test(currentSys);
          const replaceSystemInOpenAIMessagesSimple = (msgs: any[], sys: string): any[] => {
            if (!Array.isArray(msgs)) {return msgs;}
            const out = msgs.slice();
            if (out.length > 0 && out[0] && out[0].role === 'system') {
              out[0] = { ...out[0], role: 'system', content: sys };
            } else {
              out.unshift({ role: 'system', content: sys });
            }
            return out;
          };
          if (!hasMdMarkers) {
            (req.body as any).messages = replaceSystemInOpenAIMessagesSimple(messages, sysText) as any[];
            try { res.setHeader('x-rc-system-prompt-source', 'static-file'); } catch { /* ignore */ }
          }
        }
      } catch (error) {
        // 注入失败不影响主流程
        this.logger.logModule('ChatCompletionsHandler', 'system-prompt-static-skip', {
          requestId,
          reason: (error as Error)?.message || String(error)
        });
      }

      // Strict protocol separation: Chat endpoint only accepts OpenAI Chat payload.
      // Do NOT auto-convert Anthropic/Responses-shaped payloads here to avoid cross-path pollution.
      try {
        const detector = new ProtocolDetector();
        const det = detector.detectFromRequest(req);
        const looksAnthropicContent = Array.isArray(req.body?.messages) && (req.body.messages as any[]).some((m: any) => Array.isArray(m?.content) && m.content.some((c: any) => c && typeof c === 'object' && typeof c.type === 'string'));
        if (det.protocol === 'anthropic' || det.protocol === 'responses' || looksAnthropicContent) {
          throw new RouteCodexError('Chat endpoint only accepts OpenAI Chat payload (messages: string or OpenAI content parts). Use the Responses endpoint for Responses-shaped payloads.', 'invalid_protocol', 400);
        }
      } catch (e) {
        if (e instanceof RouteCodexError) {throw e;}
      }

      // Tool guidance和归一化在 llmswitch-core 的 OpenAI 工具阶段统一处理
      try { res.setHeader('x-rc-conversion-profile', 'openai-openai'); } catch { /* ignore */ }

      // Skip strict request validation (preserve raw inputs)

      // Process request through pipeline
      const pipelineResponse = await this.processChatRequest(req, requestId);

      // Handle streaming vs non-streaming response (also honor Accept: text/event-stream)
      const accept = String(req.headers['accept'] || '').toLowerCase();
      const wantsSSE = (accept.includes('text/event-stream') || req.body?.stream === true);
      if (wantsSSE) {
        const streamModel = (pipelineResponse && typeof pipelineResponse === 'object' && 'data' in pipelineResponse)
          ? ((pipelineResponse as any).data?.model ?? req.body.model)
          : req.body.model;
        await this.streamingManager.streamResponse(pipelineResponse, requestId, res, streamModel);
        return;
      }

      // Return JSON response
      const payload = pipelineResponse && typeof pipelineResponse === 'object' && 'data' in pipelineResponse
        ? (pipelineResponse as Record<string, unknown>).data
        : pipelineResponse;
      // 工具文本→tool_calls 的归一化已在 llmswitch-core (openai-openai codec) 统一完成，这里不再做重复处理
      const normalized = this.responseNormalizer.normalizeOpenAIResponse(payload, 'chat');
      // Chat 路径不注入 Responses 的 required_action 结构，保持协议纯净
      this.sendJsonResponse(res, normalized, requestId);

      this.logCompletion(requestId, startTime, true);
    } catch (error) {
      this.logCompletion(requestId, startTime, false);
      // If the client requested SSE streaming, emit an SSE error and end the stream
      try {
        const accept = String(req.headers['accept'] || '').toLowerCase();
        const wantsSSE = (accept.includes('text/event-stream') || req.body?.stream === true);
        if (wantsSSE && !res.writableEnded) {
          try {
            if (!res.headersSent) {
              res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
              res.setHeader('Cache-Control', 'no-cache, no-transform');
              res.setHeader('Connection', 'keep-alive');
              try { res.setHeader('X-Accel-Buffering', 'no'); } catch { /* ignore */ }
              res.setHeader('x-request-id', requestId);
              try { (res as any).flushHeaders?.(); } catch { /* ignore */ }
            }
            const model = typeof req.body?.model === 'string' ? req.body.model : 'unknown';
            const errMsg = (error instanceof Error ? error.message : String(error)) || 'stream error';
            const errChunk = {
              id: `chatcmpl-${Date.now()}`,
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model,
              choices: [{ index: 0, delta: { content: `Error: ${errMsg}` }, finish_reason: 'error' }]
            } as any;
            res.write(`data: ${JSON.stringify(errChunk)}\n\n`);
            res.write(`data: [DONE]\n\n`);
          } catch { /* ignore */ }
          try { res.end(); } catch { /* ignore */ }
          return;
        }
      } catch { /* ignore */ }

      await this.handleEnhancedError(error as Error, res, requestId, req);
    }
  }

  /**
   * 增强的错误处理函数 - 符合9大架构原则
   * 实现快速死亡和暴露问题原则
   */
  private async handleEnhancedError(error: Error, res: Response, requestId: string, req: Request): Promise<void> {
    // 构建详细的错误上下文
    const context: ErrorContext = {
      module: 'ChatCompletionsHandler',
      file: 'src/server/handlers/chat-completions.ts',
      function: 'handleRequest',
      line: ErrorContextBuilder.extractLineNumber(error),
      requestId,
      additional: {
        endpoint: '/v1/chat/completions',
        method: req.method,
        url: req.url,
        model: req.body?.model,
        messageCount: req.body?.messages?.length,
        hasTools: !!req.body?.tools,
        streaming: req.body?.stream,
        processingTime: Date.now() - (req as any).__startTime || Date.now(),
        userAgent: req.headers['user-agent'],
        contentType: req.headers['content-type']
      }
    };

    // 如果错误已经是EnhancedRouteCodexError，直接使用
    if (error instanceof EnhancedRouteCodexError) {
      this.sendDetailedErrorResponse(res, error.detailedError);
      return;
    }

    // 否则创建增强错误
    const enhancedError = new EnhancedRouteCodexError(error, context);
    this.sendDetailedErrorResponse(res, enhancedError.detailedError);
  }

  /**
   * 发送详细的错误响应
   * 符合暴露问题原则，提供完整调试信息
   */
  private sendDetailedErrorResponse(res: Response, detailedError: any): void {
    try {
      // 设置状态码和响应头
      res.status(500).set({
        'Content-Type': 'application/json',
        'x-request-id': detailedError.error.context.requestId,
        'x-error-source': detailedError.source,
        'x-error-code': detailedError.error.code
      });

      // 发送详细的错误响应
      res.json(detailedError);
    } catch (responseError) {
      // 如果连错误响应都失败了，返回最基本的错误信息
      res.status(500).json({
        error: {
          code: 'CRITICAL_ERROR_RESPONSE_FAILURE',
          message: '系统发生严重错误，无法提供详细错误信息',
          type: 'CriticalError'
        },
        source: 'RouteCodex-Critical',
        remediation: {
          immediate: '检查服务器日志和系统状态',
          support: '联系技术支持团队'
        }
      });
    }
  }

  /**
   * Process chat completion request
   */
  private async processChatRequest(req: Request, requestId: string): Promise<any> {
    // Use pipeline manager only; no fallback allowed
    if (this.shouldUsePipeline() && this.getRoutePools()) {
      return await this.processWithPipeline(req, requestId);
    }
    throw new RouteCodexError('Chat pipeline unavailable (no route pools or pipeline manager)', 'pipeline_unavailable', 503);
  }

  /**
   * Process request through pipeline
   */
  private async processWithPipeline(req: Request, requestId: string): Promise<any> {
    const routeName = await this.decideRouteCategoryAsync(req);
    const pipelineId = this.pickPipelineId(routeName);
    const routeMeta = this.getRouteMeta();
    const meta = routeMeta ? routeMeta[pipelineId] : undefined;
    const providerId = meta?.providerId ?? 'unknown';
    const modelId = meta?.modelId ?? 'unknown';

    // Pre-convert OpenAI Responses payload to OpenAI Chat payload
    let chatPayload = { ...(req.body || {}) } as Record<string, unknown>;
    // 不在入口做跨路径的内容过滤；路径隔离在转换路由与编码器中保证。
    // 角色分布快照（llmswitch 前/后），便于诊断“tool 历史泄露”等问题
    const snapshotDir = (() => {
      try {
        const os = require('os'); const path = require('path'); const fs = require('fs');
        const dir = path.join(os.homedir(), '.routecodex', 'codex-samples', 'openai-chat');
        fs.mkdirSync(dir, { recursive: true });
        return dir;
      } catch { return null; }
    })();
    const roleCounts = (msgs: any[]): Record<string, number> => {
      const c: Record<string, number> = { system: 0, user: 0, assistant: 0, tool: 0, unknown: 0 };
      for (const m of Array.isArray(msgs) ? msgs : []) {
        const r = String(m?.role || '').toLowerCase();
        if (r === 'system' || r === 'user' || r === 'assistant' || r === 'tool') {c[r] += 1;} else {c.unknown += 1;}
      }
      return c;
    };
    const writeSnapshot = (kind: 'pre-llmswitch' | 'post-llmswitch', payload: any) => {
      try {
        if (!snapshotDir) {return;}
        const fs = require('fs'); const path = require('path');
        const file = path.join(snapshotDir, `${requestId}_${kind}.json`);
        const msgs = Array.isArray(payload?.messages) ? payload.messages : [];
        const counts = roleCounts(msgs);
        const tc = msgs.filter((m: any) => m && m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length);
        const ctSummary = (() => {
          const sum: Record<string, number> = {};
          for (const m of tc) {
            const t = (m.content === null) ? 'null' : (typeof m.content);
            sum[t] = (sum[t] || 0) + 1;
          }
          return sum;
        })();
        const stats = { kind, counts, total: msgs.length, assistant_tool_calls: tc.length, content_types: ctSummary };
        fs.writeFileSync(file, JSON.stringify({ requestId, stats }, null, 2), 'utf-8');
      } catch { /* ignore */ }
    };
    try { writeSnapshot('pre-llmswitch', chatPayload); } catch { /* ignore */ }
    // 不在入口执行 legacy OpenAI normalizer；统一由 pipeline conversion-router + canonicalizer 处理
    chatPayload = { ...(req.body || {}) } as Record<string, unknown>;
    try { writeSnapshot('post-llmswitch', chatPayload); } catch { /* ignore */ }

    // Ensure payload model aligns with selected route meta
    const normalizedPayload = { ...chatPayload, ...(modelId ? { model: modelId } : {}) } as Record<string, unknown>;
    // Inject route.requestId into payload metadata for downstream providers (capture + pairing)
    try {
      const meta = (normalizedPayload as any)._metadata && typeof (normalizedPayload as any)._metadata === 'object'
        ? { ...(normalizedPayload as any)._metadata }
        : {};
      (normalizedPayload as any)._metadata = { ...meta, requestId };
    } catch { /* non-blocking */ }

    const pipelineRequest = {
      data: normalizedPayload,
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
        targetProtocol: 'openai',
        endpoint: `${req.baseUrl || ''}${req.url || ''}`,
        entryEndpoint: '/v1/chat/completions',
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

    const pipelineTimeoutMs = Number(
      process.env.ROUTECODEX_TIMEOUT_MS ||
      process.env.RCC_TIMEOUT_MS ||
      process.env.ROUTECODEX_PIPELINE_MAX_WAIT_MS ||
      300000
    );
    const pipelineResponse = await Promise.race([
      this.getPipelineManager()?.processRequest?.(pipelineRequest) || Promise.reject(new Error('Pipeline manager not available')),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`Pipeline timeout after ${pipelineTimeoutMs}ms`)), Math.max(1, pipelineTimeoutMs)))
    ]);

    return pipelineResponse;
  }

}
