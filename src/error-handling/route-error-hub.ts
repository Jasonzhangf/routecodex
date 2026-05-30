import { ErrorHandlingCenter } from 'rcc-errorhandling';
import { ErrorHandlerRegistry } from '../utils/error-handler-registry.js';
import { mapErrorToHttp, type HttpErrorPayload } from '../server/utils/http-error-mapper.js';
import {
  formatErrorForErrorCenter,
  type ErrorExtras
} from '../utils/error-center-payload.js';
import { formatValueForConsole } from '../utils/logger.js';
import { buildInfo } from '../build-info.js';

export type RouteErrorScope = 'http' | 'provider' | 'server' | 'pipeline' | 'cli' | 'compat' | 'other';
export type RouteErrorSeverity = 'low' | 'medium' | 'high' | 'critical';

export interface RouteErrorPayload {
  code: string;
  message: string;
  source: string;
  scope: RouteErrorScope;
  severity?: RouteErrorSeverity;
  timestamp?: number;
  requestId?: string;
  endpoint?: string;
  providerKey?: string;
  providerType?: string;
  routeName?: string;
  model?: string;
  details?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  originalError?: unknown;
}

export interface RouteErrorReportOptions {
  includeHttpResult?: boolean;
}

export interface RouteErrorReportResult {
  http?: HttpErrorPayload;
}

export interface RouteErrorHubDeps {
  errorHandlingCenter: ErrorHandlingCenter;
}

export class RouteErrorHubNotInitializedError extends Error {
  public readonly code = 'ROUTE_ERROR_HUB_NOT_INITIALIZED';

  constructor() {
    super('RouteErrorHub has not been initialized');
    this.name = 'RouteErrorHubNotInitializedError';
  }
}

export class RouteErrorHub {
  private readonly registry = ErrorHandlerRegistry.getInstance();
  private initialized = false;

  constructor(private readonly deps: RouteErrorHubDeps) {
    this.registry.attachErrorHandlingCenter(this.deps.errorHandlingCenter);
  }

  public async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }
    await this.registry.initialize();
    this.initialized = true;
  }

  public async report(
    payload: RouteErrorPayload,
    options?: RouteErrorReportOptions
  ): Promise<RouteErrorReportResult> {
    await this.ensureInitialized();
    const normalized = this.normalizePayload(payload);
    const errorObject = this.buildErrorObject(normalized);
    const sanitizedError = this.prepareErrorForCenter(errorObject, normalized);
    const context = this.buildAdditionalContext(normalized);
    try {
      await this.registry.handleError(
        sanitizedError as Error,
        normalized.source,
        normalized.scope,
        context
      );
    } catch (registryError) {
      // 错误中心自身的异常必须始终暴露，禁止因 release 模式而静默吞掉。
      console.error(
        '[RouteErrorHub] Failed to dispatch error via registry:',
        registryError instanceof Error ? registryError.message : String(registryError ?? 'Unknown error')
      );
      // 为了避免在控制台中再次输出大体量 raw 内容，这里仅输出经过格式化的精简 payload。
      console.error(
        '[RouteErrorHub] Original payload:',
        formatValueForConsole(normalized)
      );
    }

    let http: HttpErrorPayload | undefined;
    if (options?.includeHttpResult) {
      http = mapErrorToHttp(this.buildHttpPayload(normalized));
    }

    return { http };
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }
  }

  private normalizePayload(payload: RouteErrorPayload): RouteErrorPayload & { timestamp: number; severity: RouteErrorSeverity } {
    return {
      ...payload,
      timestamp: payload.timestamp ?? Date.now(),
      severity: payload.severity ?? 'medium'
    };
  }

  private buildErrorObject(payload: RouteErrorPayload): Error & Record<string, unknown> {
    if (payload.originalError instanceof Error) {
      return payload.originalError as Error & Record<string, unknown>;
    }
    const err = new Error(payload.message);
    (err as Error & { code?: string }).code = payload.code;
    return err as Error & Record<string, unknown>;
  }

  private prepareErrorForCenter(
    error: Error & Record<string, unknown>,
    payload: RouteErrorPayload
  ): Error & Record<string, unknown> {
    const extras = this.buildErrorExtras(payload);
    const formatted = formatErrorForErrorCenter(error, extras);
    if (formatted && typeof formatted === 'object') {
      return formatted as Error & Record<string, unknown>;
    }
    return error;
  }

  private buildAdditionalContext(payload: RouteErrorPayload): Record<string, unknown> {
    return {
      requestId: payload.requestId,
      endpoint: payload.endpoint,
      providerKey: payload.providerKey,
      providerType: payload.providerType,
      routeName: payload.routeName,
      model: payload.model,
      severity: payload.severity,
      details: payload.details,
      metadata: payload.metadata,
      timestamp: payload.timestamp
    };
  }

  private buildErrorExtras(payload: RouteErrorPayload): ErrorExtras {
    return {
      requestId: payload.requestId,
      endpoint: payload.endpoint,
      providerKey: payload.providerKey,
      model: payload.model
    };
  }

  private buildHttpPayload(payload: RouteErrorPayload): Record<string, unknown> {
    const originalError =
      payload.originalError && typeof payload.originalError === 'object'
        ? (payload.originalError as Record<string, unknown>)
        : undefined;
    const nestedErrorDetails =
      payload.details?.details && typeof payload.details.details === 'object' && !Array.isArray(payload.details.details)
        ? (payload.details.details as Record<string, unknown>)
        : undefined;
    const status =
      typeof originalError?.status === 'number'
        ? originalError.status
        : typeof originalError?.statusCode === 'number'
          ? originalError.statusCode
          : typeof payload.details?.status === 'number'
            ? payload.details.status
            : typeof payload.details?.statusCode === 'number'
              ? payload.details.statusCode
              : typeof nestedErrorDetails?.status === 'number'
                ? nestedErrorDetails.status
                : typeof nestedErrorDetails?.statusCode === 'number'
                  ? nestedErrorDetails.statusCode
                  : undefined;
    return {
      message: payload.message,
      code: payload.code,
      ...(typeof status === 'number' ? { status, statusCode: status } : {}),
      requestId: payload.requestId,
      providerKey: payload.providerKey,
      providerType: payload.providerType,
      routeName: payload.routeName,
      details: {
        ...nestedErrorDetails,
        ...payload.details,
        ...(typeof status === 'number' ? { status, statusCode: status } : {}),
        requestId: payload.requestId,
        providerKey: payload.providerKey,
        providerType: payload.providerType,
        routeName: payload.routeName,
        model: payload.model
      }
    };
  }
}

let currentHub: RouteErrorHub | null = null;

export function initializeRouteErrorHub(deps: RouteErrorHubDeps): RouteErrorHub {
  currentHub = new RouteErrorHub(deps);
  return currentHub;
}

export function getRouteErrorHub(): RouteErrorHub | null {
  return currentHub;
}

export async function reportRouteError(
  payload: RouteErrorPayload,
  options?: RouteErrorReportOptions
): Promise<RouteErrorReportResult> {
  if (!currentHub) {
    throw new RouteErrorHubNotInitializedError();
  }
  const hub = currentHub;
  return hub.report(payload, options);
}
