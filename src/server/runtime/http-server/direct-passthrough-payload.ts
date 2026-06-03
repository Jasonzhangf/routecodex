import type { UnknownObject } from '../../../types/common-types.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function cloneRecord<T extends Record<string, unknown>>(value: T): T {
  return structuredClone(value);
}

function cloneWirePayload(value: Record<string, unknown>): Record<string, unknown> {
  if (Object.prototype.hasOwnProperty.call(value, 'metadata')) {
    throw new Error('provider-runtime-error: metadata is not allowed in direct passthrough provider body');
  }
  const next = cloneRecord(value);
  return next;
}

export function resolveRawPayloadForDirect(
  body: unknown,
  metadata?: Record<string, unknown>,
): Record<string, unknown> {
  const raw = metadata?.__raw_request_body;
  if (isRecord(raw)) {
    const next = cloneWirePayload(raw);
    if ((isRecord(body) && body.stream === true || metadata?.stream === true || metadata?.outboundStream === true) && next.stream !== true) {
      next.stream = true;
    }
    return next;
  }
  if (isRecord(body)) {
    return cloneWirePayload(body);
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
  const next = cloneRecord(payload);
  const providerPayload =
    options?.providerPayload && isRecord(options.providerPayload)
      ? (options.providerPayload as Record<string, unknown>)
      : undefined;
  if (providerPayload && typeof providerPayload.model === 'string' && providerPayload.model.trim()) {
    next.model = providerPayload.model.trim();
  }
  if (providerPayload && isRecord(providerPayload.reasoning)) {
    next.reasoning = cloneRecord(providerPayload.reasoning);
  }
  if (providerPayload && isRecord(providerPayload.thinking)) {
    next.thinking = cloneRecord(providerPayload.thinking);
  }
  const routeModel = typeof options?.routeParams?.model === 'string' ? options.routeParams.model.trim() : '';
  if (routeModel) {
    next.model = routeModel;
  }
  return next;
}
