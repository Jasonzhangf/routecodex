import type { InternalDebugErrorEnvelope } from './envelope.js';
import type { ExternalErrorLink } from './external-link.js';
import { linkExternalError } from './external-link.js';
import { preserveInternalErrorClientBoundary } from './guards.js';

export interface InternalDebugErrorArtifactProjection {
  internalError: InternalDebugErrorEnvelope;
  externalError?: ExternalErrorLink;
}

export function projectInternalDebugErrorToDebugArtifact(
  envelope: InternalDebugErrorEnvelope,
): InternalDebugErrorArtifactProjection {
  const preserved = preserveInternalErrorClientBoundary(envelope);
  return {
    internalError: preserved,
    ...(preserved.externalLink ? { externalError: linkExternalError(preserved.externalLink) } : {}),
  };
}
