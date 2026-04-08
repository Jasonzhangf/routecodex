import type { Request, Response } from 'express';
import type { ErrorHandlingCenter } from 'rcc-errorhandling';

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
  timingBreakdown?: {
    hubResponseExcludedMs?: number;
    clientInjectWaitMs?: number;
  };
  usageLogInfo?: {
    providerKey?: string;
    model?: string;
    routeName?: string;
    poolId?: string;
    finishReason?: string;
    usage?: Record<string, unknown>;
    externalLatencyMs?: number;
    trafficWaitMs?: number;
    clientInjectWaitMs?: number;
    sseDecodeMs?: number;
    codecDecodeMs?: number;
    providerAttemptCount?: number;
    retryCount?: number;
    hubStageTop?: Array<{
      stage: string;
      totalMs: number;
      count?: number;
      avgMs?: number;
      maxMs?: number;
    }>;
    requestStartedAtMs: number;
    timingRequestIds?: string[];
    sessionId?: unknown;
    conversationId?: unknown;
    projectPath?: unknown;
  };
}

export interface HandlerContext {
  executePipeline: ((input: PipelineExecutionInput) => Promise<PipelineExecutionResult>) | null;
  errorHandling?: ErrorHandlingCenter | null;
}

export type EndpointHandler = (req: Request, res: Response, ctx: HandlerContext) => Promise<void>;
