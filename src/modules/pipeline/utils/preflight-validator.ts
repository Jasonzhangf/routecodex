import type { UnknownObject } from '../../../types/common-types.js';

export interface PreflightIssue {
  code: string;
  level: 'error' | 'warn';
  message?: string;
}

export interface PreflightResult {
  sanitizedRequest: UnknownObject;
  payload: UnknownObject;
  warnings: string[];
  issues: PreflightIssue[];
}

export function sanitizeAndValidateOpenAIChat(request: UnknownObject, _options?: UnknownObject): PreflightResult {
  const sanitized = typeof request === 'object' && request !== null ? { ...request } : {};
  return {
    sanitizedRequest: sanitized,
    payload: sanitized,
    warnings: [],
    issues: []
  };
}
