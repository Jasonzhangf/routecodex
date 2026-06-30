import type {
  InternalDebugErrorCode,
  InternalDebugErrorLane,
  InternalDebugErrorRegistry,
  InternalDebugErrorSeverity,
} from './registry.js';
import {
  assignInternalDebugErrorSubcode,
  resolveInternalDebugErrorCode,
} from './registry.js';
import type { ExternalErrorLink } from './external-link.js';
import { linkExternalError } from './external-link.js';

export interface InternalDebugErrorEnvelope {
  internalCode: InternalDebugErrorCode;
  moduleBlock: string;
  lane: InternalDebugErrorLane;
  nodeId: string;
  ownerFeatureId: string;
  stage: string;
  message: string;
  severity: InternalDebugErrorSeverity;
  requestId?: string;
  pipelineId?: string;
  port?: number;
  traceId?: string;
  externalLink?: ExternalErrorLink;
  details?: Record<string, unknown>;
}

export interface BuildInternalDebugErrorEnvelopeInput {
  code: InternalDebugErrorCode;
  stage: string;
  message: string;
  requestId?: string;
  pipelineId?: string;
  port?: number;
  traceId?: string;
  externalLink?: ExternalErrorLink;
  details?: Record<string, unknown>;
}

export function observeInternalDebugErrorSource(input: BuildInternalDebugErrorEnvelopeInput): BuildInternalDebugErrorEnvelopeInput {
  if (!input || typeof input !== 'object') {
    throw new Error('internal debug error source input must be an object');
  }
  if (!input.stage.trim()) {
    throw new Error('internal debug error source missing stage');
  }
  if (!input.message.trim()) {
    throw new Error('internal debug error source missing message');
  }
  return input;
}

export function buildInternalDebugErrorEnvelope(
  input: BuildInternalDebugErrorEnvelopeInput,
  registry?: InternalDebugErrorRegistry,
): InternalDebugErrorEnvelope {
  const observed = observeInternalDebugErrorSource(input);
  const entry = assignInternalDebugErrorSubcode(observed.code, registry);
  const resolved = resolveInternalDebugErrorCode(entry.code, registry);
  if (resolved.externalLinkPolicy === 'required' && !observed.externalLink) {
    throw new Error(`internal debug error code ${resolved.code} requires externalLink`);
  }
  if (resolved.externalLinkPolicy === 'none' && observed.externalLink) {
    throw new Error(`internal debug error code ${resolved.code} does not allow externalLink`);
  }
  return {
    internalCode: resolved.code,
    moduleBlock: resolved.moduleBlock,
    lane: resolved.lane,
    nodeId: resolved.nodeId,
    ownerFeatureId: resolved.ownerFeatureId,
    stage: observed.stage,
    message: observed.message,
    severity: resolved.severity,
    ...(observed.requestId ? { requestId: observed.requestId } : {}),
    ...(observed.pipelineId ? { pipelineId: observed.pipelineId } : {}),
    ...(typeof observed.port === 'number' ? { port: observed.port } : {}),
    ...(observed.traceId ? { traceId: observed.traceId } : {}),
    ...(observed.externalLink ? { externalLink: linkExternalError(observed.externalLink) } : {}),
    ...(observed.details ? { details: observed.details } : {}),
  };
}
