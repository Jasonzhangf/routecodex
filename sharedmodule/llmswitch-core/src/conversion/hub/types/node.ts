import type { JsonObject } from './json.js';

export interface HubNodeRequestContext {
  id: string;
  endpoint: string;
  context?: Record<string, unknown>;
}

export interface HubNodeContext {
  request: HubNodeRequestContext;
}

export interface HubNodeResult {
  success: boolean;
  data?: Record<string, unknown>;
  error?: {
    code: string;
    message: string;
    details?: JsonObject;
    cause?: Error;
  };
  metadata: {
    node: string;
    executionTime: number;
    startTime: number;
    endTime: number;
    dataProcessed?: {
      messages?: number;
      tools?: number;
      tokens?: number;
      responseSize?: number;
    };
  };
}
