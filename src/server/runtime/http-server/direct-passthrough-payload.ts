import type { UnknownObject } from '../../../types/common-types.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function cloneRecord<T extends Record<string, unknown>>(value: T): T {
  return structuredClone(value);
}

export function resolveRawPayloadForDirect(
  body: unknown,
  metadata?: Record<string, unknown>,
): Record<string, unknown> {
  const raw = metadata?.__raw_request_body;
  if (isRecord(raw)) {
    return cloneRecord(raw);
  }
  if (isRecord(body)) {
    return cloneRecord(body);
  }
  return {};
}

export function applyMinimalDirectOverrides(
  payload: Record<string, unknown>,
  options?: {
    providerPayload?: UnknownObject;
    routeParams?: Record<string, unknown>;
  }
): Record<string, unknown> {
  const providerPayload =
    options?.providerPayload && isRecord(options.providerPayload)
      ? (options.providerPayload as Record<string, unknown>)
      : undefined;
  if (providerPayload) {
    return cloneRecord(providerPayload);
  }
  return cloneRecord(payload);
}
