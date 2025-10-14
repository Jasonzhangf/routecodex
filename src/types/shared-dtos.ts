/**
 * Shared DTOs for RouteCodex (mirror of current pipeline interfaces)
 *
 * These types intentionally mirror the existing shapes used across the
 * pipeline so downstream modules can import a single source of truth
 * without changing behavior.
 */

// Route selection info
export interface SharedRouteRequest {
  readonly providerId: string;
  readonly modelId: string;
  readonly requestId: string;
  readonly timestamp?: number;
}

// Pipeline request payload
export interface SharedPipelineRequest {
  readonly data: unknown;
  readonly route: {
    providerId: string;
    modelId: string;
    requestId: string;
    timestamp: number;
  };
  readonly metadata: Record<string, unknown>;
  readonly debug: {
    enabled: boolean;
    stages: Record<string, boolean>;
  };
}

// Pipeline error record
export interface SharedPipelineError {
  readonly stage: string;
  readonly code: string;
  readonly message: string;
  readonly details?: unknown;
  readonly timestamp: number;
}

// Pipeline response payload
export interface SharedPipelineResponse<T = unknown> {
  readonly data: T;
  readonly metadata: {
    pipelineId: string;
    processingTime: number;
    stages: string[];
    requestId?: string;
    errors?: SharedPipelineError[];
  };
  readonly debug?: {
    request: unknown;
    response: unknown;
    // Keep as unknown to avoid circular deps on TransformationLog
    transformations: unknown;
    timings: Record<string, number>;
  };
}
