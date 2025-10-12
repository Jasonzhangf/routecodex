export interface SharedRouteRequest {
  readonly providerId: string;
  readonly modelId: string;
  readonly requestId: string;
  readonly timestamp?: number;
}

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

export interface SharedPipelineError {
  readonly stage: string;
  readonly code: string;
  readonly message: string;
  readonly details?: unknown;
  readonly timestamp: number;
}

export interface SharedPipelineResponse {
  readonly data: unknown;
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
    transformations: unknown;
    timings: Record<string, number>;
  };
}

