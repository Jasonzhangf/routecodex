/**
 * Chat Completions Handler Implementation
 * Handles OpenAI-compatible chat completion requests
 */

import { type Request, type Response } from 'express';
import { BaseHandler, type ProtocolHandlerConfig } from './base-handler.js';
import { type RequestContext, type OpenAIChatCompletionRequest } from '../types.js';
import { RouteCodexError } from '../types.js';
import { StreamingManager } from '../utils/streaming-manager.js';
import { PipelineDebugLogger } from '../../modules/pipeline/utils/debug-logger.js';
import { getAppVersion, getCoreVersion } from '../utils/version.js';
import { ErrorContextBuilder, EnhancedRouteCodexError, type ErrorContext } from '../utils/error-context.js';
import os from 'os';
import path from 'path';

/**
 * Chat Completions Handler
 * Handles /v1/chat/completions endpoint
 */
export class ChatCompletionsHandler extends BaseHandler {
  private streamingManager: StreamingManager;

  constructor(config: ProtocolHandlerConfig) {
    super(config);
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
      // 禁止服务器端静态系统提示注入（V1路径移除）；仅保留客户端提供与 llmswitch-core 的幂等引导。
      // 此处不再对 req.body.messages 做任何替换或插入。
    
      // Strict protocol separation: Chat endpoint only accepts OpenAI Chat payload.
      // Do NOT auto-convert Anthropic/Responses-shaped payloads here to avoid cross-path pollution.
      // 放宽协议形状校验：不再在这里报 400，由后续 llmswitch 转换器在唯一入口做统一处理
      // 兼容携带 Anthropics/Responses 形状的 messages，后续模块会按路由自动转换

      // 工具治理移至 llmswitch-core 编解码器唯一入口；Server 不再做工具归一化/增强。
      try { res.setHeader('x-rc-conversion-profile', 'openai-openai'); } catch { /* ignore */ }

      // Skip strict request validation (preserve raw inputs)

      // Process request through pipeline
      const pipelineResponse = await this.processChatRequest(req, requestId);

      // Handle streaming vs non-streaming response (also honor Accept: text/event-stream)
      const accept = String(req.headers['accept'] || '').toLowerCase();
      const wantsSSE = accept.includes('text/event-stream') || req.body?.stream === true;
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
      // No local protocol conversion; forward provider JSON as-is
      this.sendJsonResponse(res, payload, requestId);

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
        const appVersion = getAppVersion();
        const coreVersion = getCoreVersion();
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
        fs.writeFileSync(file, JSON.stringify({ requestId, version: appVersion, coreVersion, stats }, null, 2), 'utf-8');
      } catch { /* ignore */ }
    };
    try { writeSnapshot('pre-llmswitch', chatPayload); } catch { /* ignore */ }
    // 不在入口执行 legacy OpenAI normalizer；统一由 pipeline conversion-router + canonicalizer 处理
    chatPayload = { ...(req.body || {}) } as Record<string, unknown>;

    // 工具治理已在 llmswitch-core 编解码器处理；这里不再调用 governTools，避免重复。
    try { writeSnapshot('post-llmswitch', chatPayload); } catch { /* ignore */ }

    // Ensure payload model aligns with selected route meta
    const normalizedPayload = { ...chatPayload, ...(modelId ? { model: modelId } : {}) } as Record<string, unknown>;
    // Inject route.requestId into payload metadata for downstream providers (capture + pairing)
    try {
      const appVersion = getAppVersion();
      const coreVersion = getCoreVersion();
      const meta = (normalizedPayload as any)._metadata && typeof (normalizedPayload as any)._metadata === 'object'
        ? { ...(normalizedPayload as any)._metadata }
        : {};
      (normalizedPayload as any)._metadata = { ...meta, requestId, appVersion, coreVersion };
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
    const startedAt = Date.now();
    const pipelineResponse = await Promise.race([
      this.getPipelineManager()?.processRequest?.(pipelineRequest) || Promise.reject(new Error('Pipeline manager not available')),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`Pipeline timeout after ${pipelineTimeoutMs}ms`)), Math.max(1, pipelineTimeoutMs)))
    ]);

    // 异步触发 V2 并跑（dry-run），不阻塞主链路
    try {
      const { ServiceContainer, ServiceTokens } = await import('../core/service-container.js');
      const container = ServiceContainer.getInstance();
      const dryRunManager = container.tryResolve<any>(ServiceTokens.V2_DRYRUN_MANAGER);
      if (dryRunManager) {
        const v1Duration = Date.now() - startedAt;
        const v2Req = {
          id: requestId,
          method: req.method,
          headers: this.sanitizeHeaders(req.headers),
          body: req.body,
          metadata: { timestamp: startedAt, source: 'chat-completions' }
        };
        const v1Resp = {
          id: `response-${requestId}`,
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: pipelineResponse && typeof pipelineResponse === 'object' && 'data' in pipelineResponse
            ? (pipelineResponse as Record<string, unknown>).data
            : pipelineResponse,
          metadata: { timestamp: Date.now(), duration: v1Duration }
        };
        // 非阻塞并发执行
        setImmediate(() => {
          try { dryRunManager.processRequest(requestId, v2Req, v1Resp, null, v1Duration); } catch { /* 忽略并跑错误 */ }
        });
      }
    } catch { /* 忽略并跑接线错误，不影响主流程 */ }

    return pipelineResponse;
  }

}
