import type { InternalDebugErrorEnvelope } from './envelope.js';

function containsInternalDebugErrorEnvelope(value: unknown): boolean {
  if (!value || typeof value !== 'object') {
    return false;
  }
  if (Array.isArray(value)) {
    return value.some((item) => containsInternalDebugErrorEnvelope(item));
  }
  const record = value as Record<string, unknown>;
  if (typeof record.internalCode === 'string' && /^500-[123]\d{2}$/.test(record.internalCode)) {
    return true;
  }
  return Object.values(record).some((item) => containsInternalDebugErrorEnvelope(item));
}

export function assertInternalDebugErrorDoesNotLeakToClient(payload: unknown): void {
  if (containsInternalDebugErrorEnvelope(payload)) {
    throw new Error('internal debug error envelope leaked to client normal payload');
  }
}

export function assertInternalDebugErrorDoesNotLeakToProvider(payload: unknown): void {
  if (containsInternalDebugErrorEnvelope(payload)) {
    throw new Error('internal debug error envelope leaked to provider wire payload');
  }
}

export function preserveInternalErrorClientBoundary(envelope: InternalDebugErrorEnvelope): InternalDebugErrorEnvelope {
  if (!envelope || typeof envelope !== 'object' || !envelope.internalCode) {
    throw new Error('internal debug error client boundary requires an envelope');
  }
  return envelope;
}
