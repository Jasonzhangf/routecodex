/**
 * Handler Types Module
 * Central type definitions for protocol handlers
 */

import type { Request, Response } from 'express';

/**
 * Request validation result interface
 */
export interface ValidationResult {
  isValid: boolean;
  errors: string[];
}

/**
 * Protocol handler configuration interface
 */
export interface ProtocolHandlerConfig {
  enableStreaming?: boolean;
  enableMetrics?: boolean;
  enableValidation?: boolean;
  rateLimitEnabled?: boolean;
  authEnabled?: boolean;
  targetUrl?: string;
  timeout?: number;
  enablePipeline?: boolean;
  pipelineProvider?: {
    defaultProvider: string;
    modelMapping: Record<string, string>;
  };
}

/**
 * Error response interface
 */
export interface ErrorResponse {
  status: number;
  body: {
    error: {
      message: string;
      type: string;
      code: string;
      param?: string | null;
      details?: Record<string, unknown>;
    };
  };
}

/**
 * Request handler interface
 */
export interface RequestHandler {
  handleRequest(req: Request, res: Response): Promise<void>;
}

/**
 * Stream handler interface
 */
export interface StreamHandler {
  handleStream(req: Request, res: Response): Promise<void>;
}

/**
 * Error responder interface
 */
export interface ErrorResponder {
  handleError(error: unknown, res: Response, requestId: string): Promise<void>;
}

/**
 * Handler metadata interface
 */
export interface HandlerMetadata {
  name: string;
  version: string;
  protocol: string;
  capabilities: string[];
}

/**
 * Handler lifecycle interface
 */
export interface HandlerLifecycle {
  initialize?(): Promise<void>;
  cleanup?(): Promise<void>;
  healthCheck?(): Promise<boolean>;
}
