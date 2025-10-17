/**
 * Error Builder Utility
 * Centralized error response construction for protocol handlers
 */

import { RouteCodexError } from '../types.js';

export interface ErrorDetails {
  code?: string;
  type?: string;
  message?: string;
  status?: number;
  details?: Record<string, unknown>;
  cause?: Error;
}

export interface ErrorResponse {
  status: number;
  body: {
    error: {
      message: string;
      type: string;
      code: string;
      param?: string | null;
      details?: Record<string, unknown>;
    };
  };
}

/**
 * Centralized error response builder
 */
export class ErrorBuilder {
  /**
   * Build standardized error response
   */
  static buildError(error: unknown, requestId: string): ErrorResponse {
    const e = error as Record<string, unknown>;

    // Determine status code with precedence
    const statusFromObj = this.extractStatus(e);
    const routeCodexStatus = error instanceof RouteCodexError ? error.status : undefined;
    let status = statusFromObj ?? routeCodexStatus ?? 500;

    // Extract best-effort message from common shapes
    const message = this.extractMessage(error, e);

    // Derive type and code from error information
    const { type, code } = this.deriveTypeAndCode(e, status, error);

    // Build details object
    const details = this.buildErrorDetails(error, e, requestId);

    return {
      status,
      body: {
        error: {
          message,
          type,
          code,
          param: null,
          details: Object.keys(details).length ? details : undefined,
        },
      },
    };
  }

  /**
   * Extract status code from error object
   */
  private static extractStatus(e: Record<string, unknown>): number | undefined {
    if (typeof e?.status === 'number') {
      return e.status as number;
    }
    if (typeof e?.statusCode === 'number') {
      return e.statusCode as number;
    }
    if (e?.response && typeof e.response === 'object' && e.response !== null && 'status' in e.response) {
      const status = (e.response as Record<string, unknown>).status;
      if (typeof status === 'number') {
        return status;
      }
    }
    return undefined;
  }

  /**
   * Extract meaningful error message
   */
  private static extractMessage(error: unknown, e: Record<string, unknown>): string {
    const response = e?.response as any;
    const data = e?.data as any;
    const upstreamMsg = response?.data?.error?.message
      || response?.data?.message
      || data?.error?.message
      || data?.message
      || (typeof e?.message === 'string' ? e.message : undefined);

    let message = upstreamMsg ? String(upstreamMsg) : (error instanceof Error ? error.message : String(error));

    // Guard against unhelpful stringification of objects
    if (message && /^\[object\s+Object\]$/.test(message)) {
      const serializable = e?.response && typeof e.response === 'object' && e.response !== null && 'data' in e.response && (e.response as Record<string, unknown>).data && typeof (e.response as Record<string, unknown>).data === 'object' && (e.response as Record<string, unknown>).data !== null ? (e.response as Record<string, unknown>).data
        : e?.error ? e.error
        : e?.data ? e.data
        : e?.details ? e.details
        : e;
      try {
        message = JSON.stringify(serializable);
      } catch {
        message = 'Unknown error';
      }
    }

    return message;
  }

  /**
   * Derive error type and code from various sources
   */
  private static deriveTypeAndCode(e: Record<string, unknown>, status: number, originalError: unknown): { type: string; code: string } {
    const providerKind = typeof e?.type === 'string' ? e.type : undefined;
    const cause = (e && typeof e === 'object' && e !== null && 'cause' in e) ? (e as any).cause : undefined;
    const causeCode: string | undefined = cause && typeof cause === 'object' && cause !== null && 'code' in cause && typeof (cause as any).code === 'string' ? (cause as any).code : undefined;

    // Adjust status for known network cause codes
    let finalStatus = status;
    if (!this.extractStatus(e) && causeCode) {
      const cc = causeCode.toUpperCase();
      if (cc === 'ETIMEDOUT' || cc === 'UND_ERR_CONNECT_TIMEOUT') {
        finalStatus = 504;
      } else if (cc === 'ENOTFOUND' || cc === 'EAI_AGAIN') {
        finalStatus = 502;
      } else if (cc === 'ECONNREFUSED' || cc === 'ECONNRESET') {
        finalStatus = 502;
      } else if (cc.startsWith('CERT_') || cc.includes('TLS')) {
        finalStatus = 502;
      }
    }

    const rcxCode = originalError instanceof RouteCodexError ? originalError.code : undefined;
    const upstreamCode = (e?.response as any)?.data?.error?.code || (typeof e?.code === 'string' ? e.code : undefined);

    const mapStatusToType = (s: number): string => {
      if (s === 400) return 'bad_request';
      if (s === 401) return 'unauthorized';
      if (s === 403) return 'forbidden';
      if (s === 404) return 'not_found';
      if (s === 408) return 'request_timeout';
      if (s === 409) return 'conflict';
      if (s === 422) return 'unprocessable_entity';
      if (s === 429) return 'rate_limit_exceeded';
      if (s >= 500) return 'server_error';
      return 'internal_error';
    };

    const mapKindToType = (k?: string): string | undefined => {
      if (!k) return undefined;
      const m: Record<string, string> = {
        network: 'network_error',
        server: 'server_error',
        timeout: 'request_timeout',
        rate_limit: 'rate_limit_exceeded',
      };
      return m[k] || undefined;
    };

    const type = rcxCode || mapKindToType(providerKind) || (causeCode ? 'network_error' : mapStatusToType(finalStatus));
    const code = (causeCode || upstreamCode || type);

    return { type, code };
  }

  /**
   * Build detailed error information for debugging
   */
  private static buildErrorDetails(error: unknown, e: Record<string, unknown>, requestId: string): Record<string, unknown> {
    const details: Record<string, unknown> = {};

    // Add retryable flag if present
    if (typeof e?.retryable === 'boolean') {
      details.retryable = e.retryable;
    }

    // Add upstream status if available
    const statusFromObj = this.extractStatus(e);
    if (typeof statusFromObj === 'number') {
      details.upstreamStatus = statusFromObj;
    }

    // Add provider/upstream details
    if (e?.details && typeof e.details === 'object' && e.details !== null) {
      const d = e.details as Record<string, unknown>;
      if ('provider' in d) details.provider = d.provider;
      if ('upstream' in d) details.upstream = d.upstream;
    } else if (e?.response && typeof e.response === 'object' && e.response !== null && 'data' in e.response) {
      details.upstream = (e.response as Record<string, unknown>).data;
    }

    // Add network information if available
    const rawCause = (e && typeof e === 'object' && e !== null && 'cause' in e) ? (e as any).cause : undefined;
    const normalizedCauseCode: string | undefined = rawCause && typeof rawCause === 'object' && rawCause !== null && 'code' in rawCause && typeof rawCause.code === 'string' ? rawCause.code : undefined;

    if (normalizedCauseCode || rawCause) {
      details.network = {
        code: normalizedCauseCode,
        message: rawCause && typeof rawCause === 'object' && rawCause !== null && 'message' in rawCause ? (rawCause as Record<string, unknown>).message : undefined,
        errno: rawCause && typeof rawCause === 'object' && rawCause !== null && 'errno' in rawCause ? (rawCause as Record<string, unknown>).errno : undefined,
        syscall: rawCause && typeof rawCause === 'object' && rawCause !== null && 'syscall' in rawCause ? (rawCause as Record<string, unknown>).syscall : undefined,
        hostname: rawCause && typeof rawCause === 'object' && rawCause !== null && 'hostname' in rawCause ? (rawCause as Record<string, unknown>).hostname : undefined,
      };
    }

    // Add request ID for tracing
    details.requestId = requestId;

    return details;
  }

  /**
   * Check for sandbox permission errors and normalize them
   */
  static checkSandboxPermissionError(error: unknown): ErrorResponse | null {
    try {
      // Import here to avoid circular dependencies
      const { ErrorHandlingUtils } = require('../../utils/error-handling-utils.js');
      const det = ErrorHandlingUtils.detectSandboxPermissionError(error);

      if (det.isSandbox) {
        const requestId = 'unknown';
        const details: Record<string, unknown> = {
          category: 'sandbox',
          retryable: false,
        };

        if (det.reason) {
          details.sandbox = { reason: det.reason };
        }

        return {
          status: 500,
          body: {
            error: {
              message: typeof (error as any)?.message === 'string' ? (error as any).message : 'Operation denied by sandbox or permission policy',
              type: 'server_error',
              code: 'sandbox_denied',
              param: null,
              details,
            },
          },
        };
      }
    } catch {
      // Ignore detection errors
    }

    return null;
  }
}
