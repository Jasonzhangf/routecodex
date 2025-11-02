/**
 * Chat Completions Handler V2
 *
 * V2版本的Chat Completions处理器
 * 集成hooks系统，模块化设计
 */

import { type Request, type Response } from 'express';
import type { RequestContextV2 } from '../core/route-codex-server-v2.js';

/**
 * V2处理器基类
 */
export abstract class BaseHandlerV2 {
  protected generateRequestId(): string {
    return `req-v2-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  protected createContext(req: Request): RequestContextV2 {
    return {
      requestId: (req as any).__requestId || this.generateRequestId(),
      timestamp: Date.now(),
      method: req.method,
      url: req.url,
      userAgent: req.get('user-agent'),
      ip: req.ip,
      endpoint: req.path
    };
  }

  protected sendJsonResponse(res: Response, data: any, context: RequestContextV2): void {
    try {
      res.setHeader('x-request-id', context.requestId);
      res.setHeader('x-server-version', 'v2');
      res.json(data);
    } catch (error) {
      console.error('[BaseHandlerV2] Failed to send response:', error);
      res.status(500).json({
        error: {
          message: 'Internal Server Error',
          type: 'response_error',
          code: 'response_error'
        }
      });
    }
  }
}

/**
 * Chat Completions Handler V2
 */
export class ChatCompletionsHandlerV2 extends BaseHandlerV2 {
  private hooksEnabled: boolean;
  private pipelineEnabled: boolean;

  constructor(hooksEnabled: boolean = true, pipelineEnabled: boolean = false) {
    super();
    this.hooksEnabled = hooksEnabled;
    this.pipelineEnabled = pipelineEnabled;
    console.log(`[ChatCompletionsHandlerV2] Initialized (hooks: ${hooksEnabled}, pipeline: ${pipelineEnabled})`);
  }

  /**
   * 处理Chat Completions请求
   */
  async handleRequest(req: Request, res: Response): Promise<void> {
    const context = this.createContext(req);
    const startTime = Date.now();

    console.log(`[ChatCompletionsHandlerV2] Processing request ${context.requestId}`);

    try {
      // 执行请求前Hooks (预留)
      if (this.hooksEnabled) {
        await this.executePreRequestHooks(req, context);
      }

      // 验证请求
      await this.validateRequest(req, context);

      // 处理请求
      const response = await this.processRequest(req, context);

      // 执行响应后Hooks (预留)
      if (this.hooksEnabled) {
        await this.executePostResponseHooks(response, context);
      }

      // 发送响应
      this.sendJsonResponse(res, response, context);

      const duration = Date.now() - startTime;
      console.log(`[ChatCompletionsHandlerV2] Request ${context.requestId} completed in ${duration}ms`);

    } catch (error) {
      await this.handleError(error as Error, res, context);
    }
  }

  /**
   * 验证请求
   */
  private async validateRequest(req: Request, context: RequestContextV2): Promise<void> {
    const body = req.body;

    if (!body) {
      throw new Error('Request body is required');
    }

    if (!body.model) {
      throw new Error('Model is required');
    }

    if (!body.messages || !Array.isArray(body.messages)) {
      throw new Error('Messages must be an array');
    }

    if (body.messages.length === 0) {
      throw new Error('Messages array cannot be empty');
    }

    // 验证消息格式
    for (const [index, message] of body.messages.entries()) {
      if (!message.role || !message.content) {
        throw new Error(`Message at index ${index} must have 'role' and 'content' fields`);
      }

      const validRoles = ['system', 'user', 'assistant', 'tool'];
      if (!validRoles.includes(message.role)) {
        throw new Error(`Invalid role '${message.role}' in message at index ${index}`);
      }
    }

    console.log(`[ChatCompletionsHandlerV2] Request validation passed for ${context.requestId}`);
  }

  /**
   * 处理请求
   */
  private async processRequest(req: Request, context: RequestContextV2): Promise<any> {
    const body = req.body;

    // 如果启用了Pipeline集成
    if (this.pipelineEnabled) {
      return await this.processWithPipeline(body, context);
    }

    // 否则返回模拟响应
    return this.createMockResponse(body, context);
  }

  /**
   * 创建模拟响应
   */
  private createMockResponse(body: any, context: RequestContextV2): any {
    return {
      id: `chatcmpl-${context.requestId}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: body.model,
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: `[V2 Mock Response] This is a placeholder response from RouteCodex Server V2. Request ID: ${context.requestId}. Model: ${body.model}. Messages: ${body.messages.length}.`
        },
        finish_reason: 'stop'
      }],
      usage: {
        prompt_tokens: this.estimateTokens(body.messages),
        completion_tokens: 50,
        total_tokens: this.estimateTokens(body.messages) + 50
      }
    };
  }

  /**
   * 使用Pipeline处理请求 (预留)
   */
  private async processWithPipeline(body: any, context: RequestContextV2): Promise<any> {
    console.log(`[ChatCompletionsHandlerV2] Pipeline processing not yet implemented for ${context.requestId}`);

    // TODO: 集成Pipeline系统
    // 目前返回模拟响应
    return this.createMockResponse(body, context);
  }

  /**
   * 执行请求前Hooks (预留)
   */
  private async executePreRequestHooks(req: Request, context: RequestContextV2): Promise<void> {
    console.log(`[ChatCompletionsHandlerV2] Executing pre-request hooks for ${context.requestId}`);

    // TODO: 集成系统hooks
    // 这里将调用系统hooks模块的request_preprocessing hooks
  }

  /**
   * 执行响应后Hooks (预留)
   */
  private async executePostResponseHooks(response: any, context: RequestContextV2): Promise<void> {
    console.log(`[ChatCompletionsHandlerV2] Executing post-response hooks for ${context.requestId}`);

    // TODO: 集成系统hooks
    // 这里将调用系统hooks模块的response_postprocessing hooks
  }

  /**
   * 错误处理
   */
  private async handleError(error: Error, res: Response, context: RequestContextV2): Promise<void> {
    console.error(`[ChatCompletionsHandlerV2] Error processing request ${context.requestId}:`, error);

    // 错误hooks处理 (预留)
    if (this.hooksEnabled) {
      try {
        await this.executeErrorHooks(error, context);
      } catch (hookError) {
        console.error(`[ChatCompletionsHandlerV2] Error in error hooks:`, hookError);
      }
    }

    // 发送错误响应
    try {
      res.setHeader('x-request-id', context.requestId);
      res.setHeader('x-server-version', 'v2');

      if (error.message.includes('required')) {
        res.status(400).json({
          error: {
            message: error.message,
            type: 'validation_error',
            code: 'validation_error'
          }
        });
      } else {
        res.status(500).json({
          error: {
            message: 'Internal Server Error',
            type: 'internal_error',
            code: 'internal_error'
          }
        });
      }
    } catch (responseError) {
      console.error(`[ChatCompletionsHandlerV2] Failed to send error response:`, responseError);
      res.status(500).send('Internal Server Error');
    }
  }

  /**
   * 执行错误Hooks (预留)
   */
  private async executeErrorHooks(error: Error, context: RequestContextV2): Promise<void> {
    console.log(`[ChatCompletionsHandlerV2] Executing error hooks for ${context.requestId}`);

    // TODO: 集成系统hooks
    // 这里将调用系统hooks模块的error_handling hooks
  }

  /**
   * 估算Token数量 (简单实现)
   */
  private estimateTokens(messages: any[]): number {
    let totalTokens = 0;

    for (const message of messages) {
      if (typeof message.content === 'string') {
        // 简单估算：4个字符 ≈ 1个token
        totalTokens += Math.ceil(message.content.length / 4);
      } else if (Array.isArray(message.content)) {
        // 多模态内容
        for (const content of message.content) {
          if (content.type === 'text' && content.text) {
            totalTokens += Math.ceil(content.text.length / 4);
          }
        }
      }
    }

    return Math.max(totalTokens, 1); // 至少1个token
  }
}