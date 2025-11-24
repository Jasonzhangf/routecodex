import type { PipelinePhase } from './types.js';

export interface PipelineNodeError extends Error {
  nodeId: string;
  implementation: string;
  pipelineId: string;
  requestId: string;
  phase: PipelinePhase;
  stage: string;
  metadata?: Record<string, unknown>;
  cause?: unknown;
}

export interface PipelineNodeWarning {
  nodeId: string;
  implementation: string;
  pipelineId: string;
  requestId: string;
  phase: PipelinePhase;
  stage: string;
  message: string;
  detail?: unknown;
}

export type PipelineErrorCallback = (error: PipelineNodeError) => Promise<void>;
export type PipelineWarningCallback = (warning: PipelineNodeWarning) => Promise<void>;

export function isPipelineNodeError(error: unknown): error is PipelineNodeError {
  return Boolean(
    error &&
    typeof error === 'object' &&
    'nodeId' in error &&
    'implementation' in error &&
    'pipelineId' in error &&
    'requestId' in error
  );
}

interface ErrorFactoryOptions {
  error: unknown;
  nodeId: string;
  implementation: string;
  pipelineId: string;
  requestId: string;
  phase: PipelinePhase;
  stage: string;
  metadata?: Record<string, unknown>;
}

export function createPipelineNodeError(options: ErrorFactoryOptions): PipelineNodeError {
  const base = options.error instanceof Error ? options.error : undefined;
  const message = base?.message || String(options.error ?? 'Unknown pipeline node error');
  const error: PipelineNodeError = Object.assign(new Error(message), {
    nodeId: options.nodeId,
    implementation: options.implementation,
    pipelineId: options.pipelineId,
    requestId: options.requestId,
    phase: options.phase,
    stage: options.stage,
    metadata: options.metadata,
    cause: base?.cause ?? (base ? base : options.error)
  });
  if (base?.stack) {
    error.stack = base.stack;
  }
  return error;
}

interface WarningFactoryOptions {
  nodeId: string;
  implementation: string;
  pipelineId: string;
  requestId: string;
  phase: PipelinePhase;
  stage: string;
  message: string;
  detail?: unknown;
}

export function createPipelineNodeWarning(options: WarningFactoryOptions): PipelineNodeWarning {
  return {
    nodeId: options.nodeId,
    implementation: options.implementation,
    pipelineId: options.pipelineId,
    requestId: options.requestId,
    phase: options.phase,
    stage: options.stage,
    message: options.message,
    detail: options.detail
  };
}
