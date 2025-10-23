/**
 * Pipeline error handling utilities
 */

/**
 * Pipeline error class
 */
export class PipelineError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly details?: any
  ) {
    super(message);
    this.name = 'PipelineError';
  }
}

/**
 * Pipeline error codes
 */
export enum PipelineErrorCode {
  INITIALIZATION_ERROR = 'INITIALIZATION_ERROR',
  CONFIGURATION_ERROR = 'CONFIGURATION_ERROR',
  MODULE_ERROR = 'MODULE_ERROR',
  PROVIDER_ERROR = 'PROVIDER_ERROR',
  TIMEOUT_ERROR = 'TIMEOUT_ERROR',
  VALIDATION_ERROR = 'VALIDATION_ERROR'
}

/**
 * Create a pipeline error
 */
export function createPipelineError(
  code: PipelineErrorCode,
  message: string,
  details?: any
): PipelineError {
  return new PipelineError(message, code, details);
}

/**
 * Check if an error is a pipeline error
 */
export function isPipelineError(error: any): error is PipelineError {
  return error instanceof PipelineError;
}