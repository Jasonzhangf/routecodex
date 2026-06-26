/**
 * Router Direct Pipeline — Same-Protocol Bypass for Router-Mode Ports
 *
 * When a router-mode port has sameProtocolBehavior='direct' (default), and the
 * Virtual Router selects a provider with the same protocol as the inbound request,
 * this pipeline bypasses the full executor pipeline and forwards the request directly
 * to the provider.
 *
 * Hooks applied:
 * - Model override: if VR selected a target modelId different from the inbound
 *   model, override payload.model → targetModelId. Original client model is
 *   written to metadata center for response restoration.
 * - Thinking effort override: if route params specify a thinking level, override
 *   reasoning_effort and reasoning.effort.
 * - Response restore: after provider returns, restore response.body.model back to
 *   original client model via metadata center clientModelId.
 *
 * Contract: payload passthrough is preserved for all other fields, but error
 * policy passthrough is explicitly NOT preserved. All router-direct failures
 * must surface as normal ErrorErr05 plan and go through the unified decision
 * consumer (decideDirectRouterRetry in ./direct-decision.ts) before any client
 * projection.
 */

import type { PortConfig } from './port-config-types.js';
import type { ProviderHandle, ProviderProtocol } from './types.js';
import { resolveInboundProtocolFromEntryPath } from './provider-direct-pipeline.js';
import { extractResponseStatus } from './executor/provider-response-utils.js';
import { MetadataCenter } from './metadata-center/metadata-center.js';
import type { MetadataCenterWriter } from './metadata-center/metadata-center-types.js';

const HTTP_DIRECT_MODEL_OVERRIDE_WRITER: MetadataCenterWriter = {
  module: 'src/server/runtime/http-server/router-direct-pipeline.ts',
  symbol: 'executeRouterDirectPipeline:modelOverride',
  stage: 'HubReqOutbound05ProviderSemantic',
};
const HTTP_DIRECT_MODEL_RESTORE_WRITER: MetadataCenterWriter = {
  module: 'src/server/runtime/http-server/router-direct-pipeline.ts',
  symbol: 'executeRouterDirectPipeline:modelRestore',
  stage: 'HubRespOutbound04ClientSemantic',
};

/** Context snapshot for a single router-direct request — feeds snapshot hooks and logs. */
export interface RouterDirectAuditContext {
  /** Current request payload object used for direct send. This is not cloned. */
  payload: Record<string, unknown>;
  /** Observable fields recorded for traceability */
  observedFields: Array<{
    field: string;
    value: unknown;
  }>;
  providerKey: string;
  inboundProtocol: ProviderProtocol;
  providerProtocol: ProviderProtocol;
  routingDecision?: { routeName?: string; pool?: string[] };
  /** The original client model before direct-route model override, if overridden. */
  originalClientModel?: string;
}

export interface RouterDirectInput {
  portConfig: PortConfig;
  providerPayload: Record<string, unknown>;
  requestPayload: Record<string, unknown>;
  target: {
    providerKey: string;
    providerType: string;
    runtimeKey?: string;
    routeParams?: Record<string, unknown>;
    /** The provider modelId selected by the Virtual Router. Used to override payload.model. */
    modelId?: string;
  };
  routingDecision?: { routeName?: string; pool?: string[] };
  requestId?: string;
  requestInfo: { path?: string; headers?: Record<string, string | string[] | undefined> };
  pipelineMetadata?: Record<string, unknown>;
  resolveProviderByRuntimeKey: (runtimeKey?: string) => ProviderHandle | undefined;
  /** Called immediately before provider.processIncoming, with the payload about to be sent. */
  onSnapshotBefore?: (payload: Record<string, unknown>, context: RouterDirectAuditContext) => void;
  /** Called with the raw provider response before any further processing. */
  onSnapshotAfter?: (response: unknown, context: RouterDirectAuditContext) => void;
  /** Called when direct provider transport fails; caller must classify/report through the unified ErrorErr chain. */
  onProviderError?: (error: unknown, context: RouterDirectAuditContext) => Promise<void> | void;
}

export interface RouterDirectResult {
  used: true;
  response: unknown;
  providerHandle: ProviderHandle;
  auditContext: RouterDirectAuditContext;
  externalLatencyStartedAtMs: number;
  externalLatencyMs: number;
  capturedUsage?: Record<string, unknown>;
  providerPayload?: Record<string, unknown>;
  standardizedRequest?: Record<string, unknown>;
  processedRequest?: Record<string, unknown>;
  requestSemantics?: Record<string, unknown>;
  pipelineMetadata?: Record<string, unknown>;
}

export interface RouterDirectSkipped {
  used: false;
  reason: string;
  preselectedRoute?: {
    target: Record<string, unknown>;
    decision?: Record<string, unknown>;
    diagnostics?: Record<string, unknown>;
  };
}

export type RouterDirectOutcome = RouterDirectResult | RouterDirectSkipped;

function isRouterDirectRecoverableResponseStatus(status: number | undefined): status is number {
  if (typeof status !== 'number' || !Number.isFinite(status)) {
    return false;
  }
  return status === 429 || status >= 500;
}

function buildRouterDirectResponseError(response: unknown, status: number): Error {
  const message = `router-direct provider returned recoverable HTTP ${status}`;
  const error = new Error(message) as Error & {
    status: number;
    statusCode: number;
    code: string;
    response: unknown;
  };
  error.status = status;
  error.statusCode = status;
  error.code = `HTTP_${status}`;
  error.response = response;
  return error;
}

/**
 * Execute the same-protocol direct path for a router-mode port.
 *
 * Returns RouterDirectResult iff all of the following hold:
 *   1. portConfig.mode === 'router'
 *   2. sameProtocolBehavior === 'direct' (explicit or defaulted)
 *   3. inbound protocol === provider protocol
 *
 * Otherwise returns RouterDirectSkipped with a reason string.
 */
export async function executeRouterDirectPipeline(
  input: RouterDirectInput,
): Promise<RouterDirectOutcome> {
  const { portConfig, target, requestInfo, resolveProviderByRuntimeKey } = input;

  if (portConfig.mode !== 'router') {
    return { used: false, reason: 'not a router-mode port' };
  }

  const sameProtocolBehavior = portConfig.sameProtocolBehavior ?? 'direct';
  if (sameProtocolBehavior !== 'direct') {
    return { used: false, reason: `sameProtocolBehavior is '${sameProtocolBehavior}', not 'direct'` };
  }

  const runtimeKey = target.runtimeKey ?? target.providerKey;
  const providerHandle = resolveProviderByRuntimeKey(runtimeKey);
  if (!providerHandle) {
    return { used: false, reason: `provider not found for runtimeKey: ${runtimeKey}` };
  }

  const inboundProtocol = resolveInboundProtocolFromEntryPath(requestInfo.path);
  const providerProtocol = providerHandle.providerProtocol;
  if (inboundProtocol !== providerProtocol) {
    return {
      used: false,
      reason: `protocol mismatch: inbound=${inboundProtocol}, provider=${providerProtocol}`,
    };
  }

  const auditContext: RouterDirectAuditContext = {
    payload: input.requestPayload,
    observedFields: [],
    providerKey: target.providerKey,
    inboundProtocol,
    providerProtocol,
    routingDecision: input.routingDecision,
  };

  // Apply hooks: model override + thinking effort override
  const hookResult = applyDirectRouteHooks(
    input.requestPayload,
    target.modelId,
    target.routeParams,
  );

  // Write model override info to metadata center (on the metadata carrier)
  const metadataCenterAttached = MetadataCenter.attach(input.requestPayload);
  const pipelineMetadataCenter =
    input.pipelineMetadata && typeof input.pipelineMetadata === 'object' && !Array.isArray(input.pipelineMetadata)
      ? MetadataCenter.attach(input.pipelineMetadata)
      : undefined;
  if (hookResult.originalClientModel) {
    auditContext.originalClientModel = hookResult.originalClientModel;
    // Write both on the request payload's metadata center for request-side consumption
    metadataCenterAttached.writeProviderObservation(
      'clientModelId',
      hookResult.originalClientModel,
      HTTP_DIRECT_MODEL_OVERRIDE_WRITER,
      'direct route: original client model before model override'
    );
    metadataCenterAttached.writeProviderObservation(
      'assignedModelId',
      hookResult.payload.model as string,
      HTTP_DIRECT_MODEL_OVERRIDE_WRITER,
      'direct route: provider-assigned model after override'
    );
    pipelineMetadataCenter?.writeProviderObservation(
      'clientModelId',
      hookResult.originalClientModel,
      HTTP_DIRECT_MODEL_OVERRIDE_WRITER,
      'direct route: original client model before model override'
    );
    pipelineMetadataCenter?.writeProviderObservation(
      'assignedModelId',
      hookResult.payload.model as string,
      HTTP_DIRECT_MODEL_OVERRIDE_WRITER,
      'direct route: provider-assigned model after override'
    );
  }

  const payloadToSend = recordPayloadAudit(hookResult.payload, auditContext);

  input.onSnapshotBefore?.(payloadToSend, auditContext);

  let response: unknown;
  const providerStartedAtMs = Date.now();
  try {
    response =
      typeof providerHandle.instance.processIncomingDirect === 'function'
        ? await providerHandle.instance.processIncomingDirect(payloadToSend)
        : await providerHandle.instance.processIncoming(payloadToSend);
  } catch (error) {
    await input.onProviderError?.(error, auditContext);
    throw error;
  }
  const responseStatus = extractResponseStatus(response);
  if (isRouterDirectRecoverableResponseStatus(responseStatus)) {
    const responseError = buildRouterDirectResponseError(response, responseStatus);
    await input.onProviderError?.(responseError, auditContext);
    throw responseError;
  }
  const externalLatencyMs = Math.max(0, Date.now() - providerStartedAtMs);

  // Restore response model to original client model (non-SSE body only; SSE chunks restored by postprocessor)
  if (auditContext.originalClientModel) {
    response = restoreResponseModel(response, auditContext.originalClientModel);
  }

  input.onSnapshotAfter?.(response, auditContext);

  return {
    used: true,
    response,
    providerHandle,
    auditContext,
    externalLatencyStartedAtMs: providerStartedAtMs,
    externalLatencyMs,
  };
}

// ---------------------------------------------------------------------------
// Hook: Model override + Thinking effort override
// ---------------------------------------------------------------------------

interface DirectRouteHookResult {
  payload: Record<string, unknown>;
  originalClientModel?: string;
}

/**
 * Apply direct-route hooks to the request payload.
 *
 * Model override: if target.modelId differs from inbound model, override
 * payload.model and return originalClientModel for metadata center recording.
 *
 * Thinking effort override: if route params specify a thinking level, override
 * reasoning_effort and reasoning.effort.
 */
function applyDirectRouteHooks(
  payload: Record<string, unknown>,
  targetModelId?: string,
  routeParams?: Record<string, unknown>,
): DirectRouteHookResult {
  let result = { ...payload } as Record<string, unknown>;
  let originalClientModel: string | undefined;

  // Model override hook
  const inboundModel = typeof result.model === 'string' ? result.model.trim() : '';
  const effectiveModelId = typeof targetModelId === 'string' ? targetModelId.trim() : '';
  if (effectiveModelId && effectiveModelId !== inboundModel) {
    if (inboundModel) {
      originalClientModel = inboundModel;
    }
    result.model = effectiveModelId;
  }

  // Thinking effort override hook
  const level = resolveRouteThinkingLevel(routeParams);
  if (level) {
    const reasoning =
      result.reasoning && typeof result.reasoning === 'object' && !Array.isArray(result.reasoning)
        ? { ...(result.reasoning as Record<string, unknown>), effort: level }
        : { effort: level };
    result = {
      ...result,
      reasoning_effort: level,
      reasoning,
    };
  }

  return { payload: result, originalClientModel };
}

// ---------------------------------------------------------------------------
// Response: Model restore (non-SSE body)
// ---------------------------------------------------------------------------

/**
 * Restore the model field in the provider response body back to the original
 * client model. Only applies to non-streaming (non-SSE) response bodies.
 * SSE stream chunk model restoration is handled by the SSE stream postprocessor
 * which reads originalClientModel from the auditContext.
 */
function restoreResponseModel(response: unknown, originalClientModel: string): unknown {
  if (!response || typeof response !== 'object') {
    return response;
  }
  const record = response as Record<string, unknown>;
  // Provider response shape: { body, headers, status, sseStream? }
  if (record.body && typeof record.body === 'object' && !Array.isArray(record.body)) {
    const body = record.body as Record<string, unknown>;
    if (typeof body.model === 'string') {
      body.model = originalClientModel;
    }
  }
  // Raw response passthrough (if provider returns body directly without wrapper)
  if (typeof record.model === 'string' && record.body === undefined) {
    record.model = originalClientModel;
  }
  return response;
}

// ---------------------------------------------------------------------------
// Audit: Observable fields
// ---------------------------------------------------------------------------

/**
 * Record observable fields from the payload into auditContext.observedFields.
 * This is an audit pass only — the payload itself is returned unchanged.
 */
function recordPayloadAudit(
  payload: Record<string, unknown>,
  ctx: RouterDirectAuditContext,
): Record<string, unknown> {
  for (const field of OBSERVABLE_FIELDS) {
    if (field in payload) {
      ctx.observedFields.push({ field, value: payload[field] });
    }
  }
  return payload;
}

// ---------------------------------------------------------------------------
// Thinking effort helpers
// ---------------------------------------------------------------------------

function readThinkingLevel(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (normalized === 'max') {
    return 'xhigh';
  }
  if (['xhigh', 'high', 'medium', 'low'].includes(normalized)) {
    return normalized;
  }
  return undefined;
}

function resolveRouteThinkingLevel(routeParams?: Record<string, unknown>): string | undefined {
  if (!routeParams) {
    return undefined;
  }
  return (
    readThinkingLevel(routeParams.thinking) ??
    readThinkingLevel(routeParams.reasoning_effort) ??
    readThinkingLevel(routeParams.reasoningEffort)
  );
}

/** Fields surfaced in audit logs/snapshots for traceability. */
const OBSERVABLE_FIELDS = ['model', 'reasoning', 'thinking', 'max_tokens'] as const;

// ---------------------------------------------------------------------------
// Public helpers
// ---------------------------------------------------------------------------

export function isRouterDirectEligible(portConfig: PortConfig): boolean {
  if (portConfig.mode !== 'router') return false;
  return (portConfig.sameProtocolBehavior ?? 'direct') === 'direct';
}

export function resolveRouterSameProtocolBehavior(portConfig: PortConfig): 'direct' | 'relay' {
  if (portConfig.mode !== 'router') return 'relay';
  return portConfig.sameProtocolBehavior ?? 'direct';
}

/**
 * Read the original client model from a direct-route audit context.
 * Used by SSE stream postprocessor to restore model per-chunk.
 */
export function readOriginalClientModel(auditContext: RouterDirectAuditContext): string | undefined {
  return auditContext.originalClientModel;
}
