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
  sseStream?: unknown;
  continuationOwner?: 'direct' | 'relay';
  metadata?: Record<string, unknown>;
  timingBreakdown?: {
    hubResponseExcludedMs?: number;
    clientInjectWaitMs?: number;
  };
  usageLogInfo?: {
    providerKey?: string;
    model?: string;
    requestModel?: string;
    providerProtocol?: string;
    routeName?: string;
    poolId?: string;
    entryPort?: number;
    finishReason?: string;
    stoplessMode?: 'on' | 'off' | 'endless';
    stoplessArmed?: boolean;
    usage?: Record<string, unknown>;
    externalLatencyMs?: number;
    externalLatencyStartedAtMs?: number;
    trafficWaitMs?: number;
    clientInjectWaitMs?: number;
    sseDecodeMs?: number;
    codecDecodeMs?: number;
    providerDecodeTag?: string;
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
    logSessionColorKey?: unknown;
    clientTmuxSessionId?: unknown;
    client_tmux_session_id?: unknown;
    tmuxSessionId?: unknown;
    tmux_session_id?: unknown;
    rccSessionClientTmuxSessionId?: unknown;
    rcc_session_client_tmux_session_id?: unknown;
    sessionId?: unknown;
    session_id?: unknown;
    conversationId?: unknown;
    conversation_id?: unknown;
    projectPath?: unknown;
    firstContentAtMs?: number;
    lastContentAtMs?: number;
    providerRequestId?: string;
    inputRequestId?: string;
  };
}

export interface HandlerContext {
  executePipeline: ((input: PipelineExecutionInput) => Promise<PipelineExecutionResult>) | null;
  errorHandling?: ErrorHandlingCenter | null;
  portContext?: {
    localPort?: number;
    matchedPort?: number;
    routingPolicyGroup?: string;
    logNamespace?: string;
    stopMessageEnabled?: boolean;
    stopMessageExcludeDirect?: boolean;
  };
}

export type EndpointHandler = (req: Request, res: Response, ctx: HandlerContext) => Promise<void>;
