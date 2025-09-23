/**
 * HTTP Server Debug Integration Example
 *
 * This file demonstrates how to integrate the HttpServerDebugAdapter with an existing
 * HTTP server to enable comprehensive debugging and monitoring capabilities.
 */

import { DebugSystemManager } from './debug-system-manager.js';
import { HttpServerDebugAdapterImpl } from './http-server-debug-adapter.js';
import { DebugUtilsStatic as DebugUtils } from '../utils/debug-utils.js';
import type {
  DebugHttpRequest,
  DebugHttpResponse,
  DebugAdapterConfig
} from '../types/debug-types.js';

/**
 * HTTP Server Debug Integration
 *
 * This class provides a wrapper around an HTTP server to add debugging capabilities
 * including request/response capture, performance monitoring, and error tracking.
 */
export class HttpServerDebugIntegration {
  private debugManager: DebugSystemManager;
  private httpAdapter?: HttpServerDebugAdapterImpl;
  private serverInfo: {
    host: string;
    port: number;
    protocol: string;
  };
  private config: DebugAdapterConfig;
  private requestMiddleware?: (request: any, next: Function) => Promise<any>;
  private responseMiddleware?: (response: any, next: Function) => Promise<any>;

  /**
   * Constructor
   */
  constructor(
    serverInfo: {
      host: string;
      port: number;
      protocol: string;
    },
    config: DebugAdapterConfig = {
      id: 'http-server-debug',
      type: 'server',
      className: 'HttpServerDebugAdapterImpl',
      enabled: true
    },
    debugManager?: DebugSystemManager
  ) {
    this.serverInfo = serverInfo;
    this.config = config;
    this.debugManager = debugManager || DebugSystemManager.getInstance();
  }

  /**
   * Initialize the integration
   */
  async initialize(): Promise<void> {
    try {
      // Create HTTP server debug adapter
      this.httpAdapter = new HttpServerDebugAdapterImpl(
        this.config,
        DebugUtils.getInstance(),
        this.serverInfo
      );

      // Register adapter with debug manager
      await this.debugManager.registerAdapter(this.httpAdapter);

      // Setup middleware
      this.setupMiddleware();

      console.log(`HTTP Server Debug Integration initialized for ${this.serverInfo.host}:${this.serverInfo.port}`);

    } catch (error) {
      console.error('Failed to initialize HTTP Server Debug Integration:', error);
      throw error;
    }
  }

  /**
   * Setup request and response middleware
   */
  private setupMiddleware(): void {
    // Request middleware
    this.requestMiddleware = async (request: any, next: Function) => {
      const startTime = Date.now();

      try {
        // Create debug request
        const debugRequest: DebugHttpRequest = {
          id: DebugUtils.generateId('http_req'),
          method: request.method || 'GET',
          url: request.url || '/',
          headers: this.sanitizeHeaders(request.headers || {}),
          body: this.sanitizeBody(request.body),
          params: this.extractParams(request),
          query: this.extractQuery(request),
          timestamp: startTime,
          metadata: {
            remoteAddress: this.extractRemoteAddress(request),
            userAgent: this.extractUserAgent(request),
            originalUrl: request.originalUrl || request.url
          }
        };

        // Capture request
        await this.httpAdapter!.captureRequest(debugRequest);

        // Add debug info to request for later use
        request._debug = {
          id: debugRequest.id,
          startTime,
          debugRequest
        };

        return await next(request);

      } catch (error) {
        console.warn('Request middleware error:', error);
        return await next(request);
      }
    };

    // Response middleware
    this.responseMiddleware = async (response: any, next: Function) => {
      try {
        const request = response.req || response.request;
        const debugInfo = request?._debug;

        if (debugInfo) {
          // Create debug response
          const debugResponse: DebugHttpResponse = {
            requestId: debugInfo.id,
            status: response.statusCode || response.status || 200,
            headers: this.sanitizeHeaders(response.getHeaders ? response.getHeaders() : response.headers || {}),
            body: this.sanitizeBody(response.body),
            responseTime: Date.now() - debugInfo.startTime,
            timestamp: Date.now(),
            metadata: {
              contentType: response.get('content-type') || response.headers?.['content-type'],
              contentLength: response.get('content-length') || response.headers?.['content-length']
            }
          };

          // Capture response
          await this.httpAdapter!.captureResponse(debugResponse);
        }

        return await next(response);

      } catch (error) {
        console.warn('Response middleware error:', error);
        return await next(response);
      }
    };
  }

  /**
   * Get Express middleware for request interception
   */
  getRequestMiddleware(): (req: any, res: any, next: Function) => void {
    return async (req: any, res: any, next: Function) => {
      if (!this.requestMiddleware) {
        return next();
      }

      try {
        await this.requestMiddleware!(req, () => Promise.resolve());
        next();
      } catch (error) {
        console.warn('Request middleware error:', error);
        next();
      }
    };
  }

  /**
   * Get Express middleware for response interception
   */
  getResponseMiddleware(): (req: any, res: any, next: Function) => void {
    return async (req: any, res: any, next: Function) => {
      if (!this.responseMiddleware) {
        return next();
      }

      // Store original end method
      const originalEnd = res.end;
      const originalJson = res.json;
      const originalSend = res.send;

      // Override end method
      res.end = function(chunk?: any, encoding?: any) {
        const result = originalEnd.call(this, chunk, encoding);

        // Call response middleware
        if (res._debugResponseMiddleware) {
          res._debugResponseMiddleware(res, () => Promise.resolve()).catch(console.warn);
        }

        return result;
      };

      // Override json method
      res.json = function(body: any) {
        const result = originalJson.call(this, body);
        this.body = body;
        return result;
      };

      // Override send method
      res.send = function(body: any) {
        const result = originalSend.call(this, body);
        this.body = body;
        return result;
      };

      // Store response middleware reference
      res._debugResponseMiddleware = this.responseMiddleware;

      next();
    };
  }

  /**
   * Get HTTP server wrapper for debugging
   */
  getServerWrapper(): {
    onRequest: (listener: (request: any, response: any) => void) => void;
    onConnection: (listener: (socket: any) => void) => void;
    onClose: (listener: () => void) => void;
    onError: (listener: (error: Error) => void) => void;
  } {
    return {
      onRequest: (listener: (request: any, response: any) => void) => {
        // Wrap request listener with debugging
        const wrappedListener = async (request: any, response: any) => {
          const startTime = Date.now();

          try {
            // Create debug request
            const debugRequest: DebugHttpRequest = {
              id: DebugUtils.generateId('http_req'),
              method: request.method || 'GET',
              url: request.url || '/',
              headers: this.sanitizeHeaders(request.headers || {}),
              body: this.sanitizeBody(request.body),
              params: {},
              query: {},
              timestamp: startTime,
              metadata: {
                remoteAddress: this.extractRemoteAddress(request),
                userAgent: this.extractUserAgent(request)
              }
            };

            // Capture request
            await this.httpAdapter!.captureRequest(debugRequest);

            // Store debug info
            request._debug = {
              id: debugRequest.id,
              startTime,
              debugRequest
            };

            // Setup response capture
            this.setupResponseCapture(response, debugRequest.id, startTime);

            // Call original listener
            return await listener(request, response);

          } catch (error) {
            console.warn('Request listener error:', error);
            return listener(request, response);
          }
        };

        return wrappedListener;
      },

      onConnection: (listener: (socket: any) => void) => {
        return listener;
      },

      onClose: (listener: () => void) => {
        return listener;
      },

      onError: (listener: (error: Error) => void) => {
        return listener;
      }
    };
  }

  /**
   * Setup response capture for raw HTTP responses
   */
  private setupResponseCapture(response: any, requestId: string, startTime: number): void {
    let bodyChunks: Buffer[] = [];
    let originalWrite = response.write;
    let originalEnd = response.end;
    const self = this;

    // Override write method to capture response body
    response.write = function(chunk: any, encoding?: any) {
      if (chunk) {
        if (Buffer.isBuffer(chunk)) {
          bodyChunks.push(chunk);
        } else {
          bodyChunks.push(Buffer.from(chunk, encoding || 'utf8'));
        }
      }
      return originalWrite.call(this, chunk, encoding);
    };

    // Override end method to capture final response
    response.end = function(chunk?: any, encoding?: any) {
      if (chunk) {
        if (Buffer.isBuffer(chunk)) {
          bodyChunks.push(chunk);
        } else {
          bodyChunks.push(Buffer.from(chunk, encoding || 'utf8'));
        }
      }

      const body = Buffer.concat(bodyChunks).toString('utf8');

      // Create debug response
      const debugResponse: DebugHttpResponse = {
        requestId,
        status: response.statusCode || 200,
        headers: self.sanitizeHeaders(response._headers || response.headers || {}),
        body: self.sanitizeBody(body),
        responseTime: Date.now() - startTime,
        timestamp: Date.now(),
        metadata: {
          contentType: response._headers?.['content-type'] || response.headers?.['content-type'],
          contentLength: response._headers?.['content-length'] || response.headers?.['content-length']
        }
      };

      // Capture response asynchronously
      self.httpAdapter!.captureResponse(debugResponse).catch(console.warn);

      // Call original end method
      return originalEnd.call(this, chunk, encoding);
    };
  }

  /**
   * Sanitize headers by removing sensitive information
   */
  private sanitizeHeaders(headers: Record<string, any>): Record<string, string> {
    const sanitized: Record<string, string> = {};
    const sensitiveHeaders = [
      'authorization',
      'cookie',
      'x-api-key',
      'x-auth-token',
      'token',
      'password',
      'secret'
    ];

    for (const [key, value] of Object.entries(headers)) {
      if (sensitiveHeaders.some(sensitive => key.toLowerCase().includes(sensitive))) {
        sanitized[key] = '[REDACTED]';
      } else {
        sanitized[key] = String(value);
      }
    }

    return sanitized;
  }

  /**
   * Sanitize body for logging
   */
  private sanitizeBody(body: any): any {
    if (!body) {
      return undefined;
    }

    if (typeof body === 'string') {
      // Try to parse as JSON first
      try {
        const parsed = JSON.parse(body);
        return DebugUtils.sanitizeData(parsed, {
          maxDepth: 3,
          maxArrayLength: 10,
          maxStringLength: 100
        });
      } catch {
        // Return as string, truncated if too long
        return body.length > 1000 ? body.substring(0, 1000) + '...[TRUNCATED]' : body;
      }
    }

    if (typeof body === 'object') {
      return DebugUtils.sanitizeData(body, {
        maxDepth: 3,
        maxArrayLength: 10,
        maxStringLength: 100
      });
    }

    return String(body);
  }

  /**
   * Extract parameters from request
   */
  private extractParams(request: any): Record<string, string> {
    if (request.params) {
      return request.params;
    }
    return {};
  }

  /**
   * Extract query parameters from request
   */
  private extractQuery(request: any): Record<string, string> {
    if (request.query) {
      return request.query;
    }
    return {};
  }

  /**
   * Extract remote address from request
   */
  private extractRemoteAddress(request: any): string {
    return request.ip ||
           request.connection?.remoteAddress ||
           request.socket?.remoteAddress ||
           request.info?.remoteAddress ||
           'unknown';
  }

  /**
   * Extract user agent from request
   */
  private extractUserAgent(request: any): string {
    return request.headers?.['user-agent'] ||
           request.headers?.['User-Agent'] ||
           'unknown';
  }

  /**
   * Get debug statistics
   */
  async getDebugStatistics(): Promise<any> {
    if (!this.httpAdapter) {
      return { error: 'Debug adapter not initialized' };
    }

    const stats = this.httpAdapter.getStats();
    const health = this.httpAdapter.getHealth();
    const recentRequests = this.httpAdapter.getRecentRequests(50);
    const recentResponses = this.httpAdapter.getRecentResponses(50);

    return {
      serverInfo: this.serverInfo,
      statistics: stats,
      health,
      recentRequests: recentRequests.map(req => ({
        id: req.id,
        method: req.method,
        url: req.url,
        timestamp: req.timestamp,
        responseTime: recentResponses.find(res => res.requestId === req.id)?.responseTime
      })),
      uptime: Date.now() - (this.httpAdapter as any).startTime
    };
  }

  /**
   * Get debug data for specific request
   */
  async getRequestDebugData(requestId: string): Promise<any> {
    if (!this.httpAdapter) {
      return { error: 'Debug adapter not initialized' };
    }

    try {
      return await this.httpAdapter.getHttpRequestData(requestId);
    } catch (error) {
      return { error: 'Request not found', requestId };
    }
  }

  /**
   * Export debug data
   */
  async exportDebugData(format: 'json' | 'csv' = 'json'): Promise<any> {
    if (!this.httpAdapter) {
      return { error: 'Debug adapter not initialized' };
    }

    const stats = this.httpAdapter.getStats();
    const recentRequests = this.httpAdapter.getRecentRequests(1000);
    const recentResponses = this.httpAdapter.getRecentResponses(1000);

    if (format === 'json') {
      return {
        exportInfo: {
          format: 'json',
          timestamp: Date.now(),
          serverInfo: this.serverInfo,
          totalRequests: recentRequests.length,
          totalResponses: recentResponses.length
        },
        statistics: stats,
        requests: recentRequests,
        responses: recentResponses
      };
    }

    // CSV export would be implemented here
    return { error: 'CSV export not implemented yet' };
  }

  /**
   * Cleanup integration
   */
  async destroy(): Promise<void> {
    try {
      if (this.httpAdapter) {
        await this.debugManager.unregisterAdapter(this.httpAdapter.id);
        this.httpAdapter = undefined;
      }

      this.requestMiddleware = undefined;
      this.responseMiddleware = undefined;

      console.log('HTTP Server Debug Integration destroyed');

    } catch (error) {
      console.error('Failed to destroy HTTP Server Debug Integration:', error);
    }
  }
}

/**
 * Factory function to create HTTP server debug integration
 */
export function createHttpServerDebugIntegration(
  serverInfo: {
    host: string;
    port: number;
    protocol: string;
  },
  config?: DebugAdapterConfig,
  debugManager?: DebugSystemManager
): HttpServerDebugIntegration {
  return new HttpServerDebugIntegration(serverInfo, config, debugManager);
}