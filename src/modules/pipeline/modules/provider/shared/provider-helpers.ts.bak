import type { AuthContext, ProviderError } from '../../../types/provider-types.js';

export function buildAuthHeaders(ctx: AuthContext | null, base: Record<string, string> = {}): Record<string, string> {
  const headers: Record<string, string> = { ...base };
  if (!ctx) {return headers;}
  switch (ctx.type) {
    case 'apikey': {
      const name = (ctx.credentials as { headerName?: string })?.headerName || 'Authorization';
      const prefix = (ctx.credentials as { prefix?: string })?.prefix || 'Bearer ';
      headers[name] = prefix + (ctx.token || '');
      break;
    }
    case 'bearer':
      headers['Authorization'] = `Bearer ${ctx.token || ''}`;
      break;
    case 'basic':
      headers['Authorization'] = `Basic ${ctx.token || ''}`;
      break;
    case 'oauth':
    case 'custom':
      // No standard header; rely on provider-specific credentials if present
      break;
  }
  return headers;
}

export function isRetryableError(error: unknown): boolean {
  const e = error as { statusCode?: number; code?: string };
  if (!e) {return false;}
  if (typeof e.statusCode === 'number') {
    if (e.statusCode >= 500 || e.statusCode === 429) {return true;}
  }
  return e.code === 'ECONNREFUSED' || e.code === 'ETIMEDOUT' || e.code === 'ECONNRESET';
}

export function createProviderError(error: unknown, type: ProviderError['type'] = 'network'): ProviderError {
  const errorObj = error instanceof Error ? error : new Error((error as { message?: string })?.message || String(error));
  const providerError: ProviderError = new Error(errorObj.message) as ProviderError;
  const errLike = error as { status?: number; statusCode?: number; details?: Record<string, unknown> };
  providerError.type = type;
  providerError.statusCode = (typeof errLike?.status === 'number' ? errLike.status : undefined) ?? errLike?.statusCode ?? 500;
  providerError.details = (errLike?.details as Record<string, unknown> | undefined) ?? {};
  providerError.retryable = isRetryableError(error);
  return providerError;
}
