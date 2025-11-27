import type { Request, Response } from 'express';
import type { ErrorHandlingCenter } from '../../modules/errorhandling/error-handling-center-shim.js';

export interface PipelineExecutionInput {
  entryEndpoint: string;
  method: string;
  requestId: string;
  headers: Record<string, unknown>;
  query: Record<string, unknown>;
  body: unknown;
  metadata?: Record<string, unknown>;
}

export interface PipelineExecutionResult {
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
}

export interface HandlerContext {
  executePipeline: ((input: PipelineExecutionInput) => Promise<PipelineExecutionResult>) | null;
  errorHandling?: ErrorHandlingCenter | null;
}

export type EndpointHandler = (req: Request, res: Response, ctx: HandlerContext) => Promise<void>;
