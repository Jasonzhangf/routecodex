import { buildInfo } from '../build-info.js';

type ErrorExtras = {
  requestId?: string;
  endpoint?: string;
  providerKey?: string;
  model?: string;
};

const truthyFlags = new Set(['1', 'true', 'yes', 'on']);

function shouldStripStacks(): boolean {
  if (buildInfo.mode !== 'release') {
    return false;
  }
  const raw = String(process.env.ROUTECODEX_RELEASE_ERROR_VERBOSE || '').trim().toLowerCase();
  return !truthyFlags.has(raw);
}

function buildExtras(base: Record<string, unknown>, extras?: ErrorExtras): Record<string, unknown> {
  if (!extras) {
    return base;
  }
  const merged = { ...base };
  if (extras.requestId && !merged.requestId) {
    merged.requestId = extras.requestId;
  }
  if (extras.endpoint && !merged.endpoint) {
    merged.endpoint = extras.endpoint;
  }
  if (extras.providerKey && !merged.providerKey) {
    merged.providerKey = extras.providerKey;
  }
  if (extras.model && !merged.model) {
    merged.model = extras.model;
  }
  return merged;
}

function sanitizeErrorObject(error: Error & Record<string, unknown>, extras?: ErrorExtras): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    message: error.message,
    name: error.name
  };
  for (const key of ['code', 'status', 'statusCode', 'requestId', 'endpoint']) {
    if (error[key] !== undefined) {
      payload[key] = error[key];
    }
  }
  if (error.details && typeof error.details === 'object') {
    payload.details = error.details;
  }
  return buildExtras(payload, extras);
}

function sanitizeRecord(objectValue: Record<string, unknown>, extras?: ErrorExtras): Record<string, unknown> {
  const clone: Record<string, unknown> = { ...objectValue };
  if ('stack' in clone) {
    delete clone.stack;
  }
  return buildExtras(clone, extras);
}

function buildPrimitivePayload(message: string, extras?: ErrorExtras): Record<string, unknown> {
  return buildExtras({ message }, extras);
}

export function formatErrorForErrorCenter(error: unknown, extras?: ErrorExtras): unknown {
  if (!shouldStripStacks()) {
    return error;
  }
  if (error instanceof Error) {
    return sanitizeErrorObject(error as Error & Record<string, unknown>, extras);
  }
  if (error && typeof error === 'object') {
    return sanitizeRecord(error as Record<string, unknown>, extras);
  }
  const text = error === undefined ? 'Unknown error' : String(error);
  return buildPrimitivePayload(text, extras);
}
