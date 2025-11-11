/**
 * Minimal hook type definitions for V2 server integration.
 * These types and enums are intentionally lightweight to avoid
 * hard-coupling with external hook packages while enabling
 * runtime-safe imports in V2 Hook modules.
 */

export interface HookExecutionContext {
  requestId: string;
  stage: UnifiedHookStage | string;
  startTime?: number;
  moduleId?: string;
  serverVersion?: 'v1' | 'v2';
}

export interface HookDataPacket<T = unknown> {
  data: T;
  metadata?: Record<string, unknown>;
}

export interface HookResult<T = unknown> {
  success: boolean;
  data?: T;
  metadata?: Record<string, unknown>;
  executionTime?: number;
  observations?: string[];
  error?: Error;
}

export interface HookExecutionResult<T = unknown> extends HookResult<T> {
  hookName: string;
  stage: UnifiedHookStage;
  target: 'request' | 'response' | string;
  metrics?: unknown;
}

export interface IBidirectionalHook {
  readonly name: string;
  readonly stage: UnifiedHookStage;
  readonly priority: number;
  readonly target: 'request' | 'response' | string;
  readonly isDebugHook?: boolean;
  execute(context: HookExecutionContext, data: HookDataPacket): Promise<HookResult> | HookResult;
}

export enum UnifiedHookStage {
  // Request path
  PIPELINE_PREPROCESSING = 'pipeline_preprocessing',
  REQUEST_PREPROCESSING = 'request_preprocessing',
  REQUEST_VALIDATION = 'request_validation',
  AUTHENTICATION = 'authentication',
  HTTP_REQUEST = 'http_request',

  // Response path
  RESPONSE_POSTPROCESSING = 'response_postprocessing',
  RESPONSE_VALIDATION = 'response_validation',

  // Error / finalize
  ERROR_HANDLING = 'error_handling',
  FINALIZATION = 'finalization',
}
