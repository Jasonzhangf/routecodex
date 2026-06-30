import type { InternalDebugErrorCode } from './registry.js';
import { resolveInternalDebugErrorCodeForNodeId } from './registry.js';

export interface InternalDebugErrorLogFields {
  internalCode?: InternalDebugErrorCode;
}

function readTrimmedString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function readErrorRecord(error: unknown): Record<string, unknown> | undefined {
  return error && typeof error === 'object' && !Array.isArray(error)
    ? error as Record<string, unknown>
    : undefined;
}

export function resolveInternalDebugErrorLogFields(input: {
  error: unknown;
  summary: string;
}): InternalDebugErrorLogFields {
  const record = readErrorRecord(input.error);
  const nestedInternalError = readErrorRecord(record?.internalError);
  const directInternalCode =
    readTrimmedString(record?.internalCode)
    ?? readTrimmedString(nestedInternalError?.internalCode);
  if (directInternalCode && /^500-[123]\d{2}$/.test(directInternalCode)) {
    return { internalCode: directInternalCode as InternalDebugErrorCode };
  }

  const code =
    readTrimmedString(record?.code)
    ?? readTrimmedString(record?.errorCode)
    ?? input.summary.match(/\bcode=([A-Za-z0-9_.-]+)/i)?.[1];
  if (
    code === 'hub_pipeline_virtual_router_retry_route_failed'
    || input.summary.includes('VIRTUAL_ROUTER_ERROR:PROVIDER_NOT_AVAILABLE')
  ) {
    return {
      internalCode: resolveInternalDebugErrorCodeForNodeId('VrRoute04SelectedTarget'),
    };
  }

  return {};
}
