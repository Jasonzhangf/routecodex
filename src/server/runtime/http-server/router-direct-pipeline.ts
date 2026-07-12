/**
 * Router Direct Pipeline — Same-Protocol Bypass for Router-Mode Ports
 *
 * When a router-mode port has sameProtocolBehavior='direct' (default), and the
 * Virtual Router selects a provider with the same protocol as the inbound request,
 * this pipeline bypasses the full executor pipeline and forwards the request directly
 * to the provider.
 *
 * Hooks applied (request / response symmetric):
 * - Request model override: if VR selected a target modelId different from the
 *   inbound model, override payload.model → targetModelId. Original client model
 *   is written to metadata center for observation.
 * - Request thinking effort override: if route params specify a thinking level,
 *   override reasoning_effort and reasoning.effort.
 * - Response model restore: rewrite provider wire model back to original client
 *   model on JSON body and SSE frames so the client sees a transparent proxy.
 * - Response SSE headers: ensure client-facing stream headers are present.
 *
 * Contract: payload passthrough is preserved for all other fields, but error
 * policy passthrough is explicitly NOT preserved. All router-direct failures
 * must surface as normal ErrorErr05 plan and go through the unified decision
 * consumer (decideDirectRouterRetry in ./direct-decision.ts) before any client
 * projection.
 */

import { Readable, Transform, type TransformCallback } from 'node:stream';
import type { PortConfig } from './port-config-types.js';
import type { ProviderHandle, ProviderProtocol } from './types.js';
import { resolveInboundProtocolFromEntryPath } from './provider-direct-pipeline.js';
import { extractResponseStatus } from './executor/provider-response-utils.js';
import type { MetadataCenterWriter } from './metadata-center/metadata-center-types.js';
import { writeMetadataCenterSlot } from './metadata-center/dualwrite-api.js';
import {
  attachProviderRuntimeMetadata,
  extractProviderRuntimeMetadata
} from '../../../providers/core/runtime/provider-runtime-metadata.js';
import {
  isProviderRequestDryRunResponse,
  propagatePipelineDryRunControl
} from '../../../debug/pipeline-dry-run.js';
import {
  planDirectRouteRequestHooksNative,
  planDirectRouteModelObservationEffectsNative,
  projectDirectRouteSseHeadersNative,
  rewriteDirectRouteResponseModelNative,
  rewriteDirectRouteSseFrameNative,
} from '../../../modules/llmswitch/bridge/direct-route-model-hooks-host.js';
import { planDirectRouteResponseErrorNative } from '../../../modules/llmswitch/bridge/direct-route-response-error-host.js';
import { planDirectRouteEligibilityNative } from '../../../modules/llmswitch/bridge/direct-route-eligibility-host.js';
import { projectDirectRouteAuditFieldsNative } from '../../../modules/llmswitch/bridge/direct-route-audit-projection-host.js';
import { planDirectRouteResponseActionNative } from '../../../modules/llmswitch/bridge/direct-route-response-action-host.js';

const HTTP_DIRECT_MODEL_OVERRIDE_WRITER: MetadataCenterWriter = {
  module: 'src/server/runtime/http-server/router-direct-pipeline.ts',
  symbol: 'executeRouterDirectPipeline:modelOverride',
  stage: 'router_direct_model_override',
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
  /** The provider model actually sent after direct-route hooks. */
  providerModelId?: string;
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

function buildRouterDirectResponseErrorFromNativePlan(
  response: unknown,
  plan: ReturnType<typeof planDirectRouteResponseErrorNative>,
): Error {
  const error = new Error(plan.message) as Error & {
    status: number;
    statusCode: number;
    code: string;
    response: unknown;
  };
  error.status = plan.status as number;
  error.statusCode = plan.statusCode as number;
  error.code = plan.code as string;
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

  const preflightPlan = planDirectRouteEligibilityNative({
    mode: portConfig.mode,
    sameProtocolBehavior: portConfig.sameProtocolBehavior,
  });
  if (preflightPlan.action === 'skip') {
    return { used: false, reason: preflightPlan.reason as string };
  }

  const runtimeKey = target.runtimeKey ?? target.providerKey;
  const providerHandle = resolveProviderByRuntimeKey(runtimeKey);
  const inboundProtocol = resolveInboundProtocolFromEntryPath(requestInfo.path);
  const providerProtocol = providerHandle?.providerProtocol;
  const executionPlan = planDirectRouteEligibilityNative({
    mode: portConfig.mode,
    sameProtocolBehavior: portConfig.sameProtocolBehavior,
    runtimeKey,
    providerFound: Boolean(providerHandle),
    inboundProtocol,
    providerProtocol,
  });
  if (executionPlan.action === 'skip') {
    return { used: false, reason: executionPlan.reason as string };
  }
  if (!providerHandle || !providerProtocol || executionPlan.action !== 'execute_direct') {
    throw new Error(`invalid router-direct eligibility plan action: ${executionPlan.action}`);
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
  const hookResult = planDirectRouteRequestHooksNative({
    payload: input.requestPayload,
    targetModelId: target.modelId,
    routeParams: target.routeParams,
  });
  if (!hookResult.payloadChanged) {
    hookResult.payload = input.requestPayload;
  }
  auditContext.providerModelId = hookResult.providerModelId;

  const observationPlan = planDirectRouteModelObservationEffectsNative({
    originalClientModel: hookResult.originalClientModel,
    providerModelId: hookResult.providerModelId,
  });
  auditContext.originalClientModel = observationPlan.originalClientModel;
  if (input.pipelineMetadata && typeof input.pipelineMetadata === 'object' && !Array.isArray(input.pipelineMetadata)) {
    for (const write of observationPlan.writes) {
      writeMetadataCenterSlot({
        target: input.pipelineMetadata,
        family: write.family,
        key: write.key,
        value: write.value,
        writer: HTTP_DIRECT_MODEL_OVERRIDE_WRITER,
        reason: write.reason,
      });
    }
  }

  const payloadToSend = recordPayloadAudit(hookResult.payload, auditContext);
  const runtimeMetadata = extractProviderRuntimeMetadata(input.requestPayload);
  if (runtimeMetadata) {
    const runtimeMetadataRecord = (
      runtimeMetadata.metadata && typeof runtimeMetadata.metadata === 'object' && !Array.isArray(runtimeMetadata.metadata)
        ? runtimeMetadata.metadata as Record<string, unknown>
        : undefined
    ) ?? {};
    runtimeMetadata.metadata = runtimeMetadataRecord;
    propagatePipelineDryRunControl(input.pipelineMetadata, runtimeMetadataRecord);
    attachProviderRuntimeMetadata(payloadToSend, runtimeMetadata);
  }

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
  const responseErrorPlan = planDirectRouteResponseErrorNative(extractResponseStatus(response));
  if (responseErrorPlan.shouldRaise) {
    const responseError = buildRouterDirectResponseErrorFromNativePlan(response, responseErrorPlan);
    await input.onProviderError?.(responseError, auditContext);
    throw responseError;
  }
  const externalLatencyMs = Math.max(0, Date.now() - providerStartedAtMs);
  if (isProviderRequestDryRunResponse(response)) {
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

  // Symmetric response hook: restore client-visible model / stream headers.
  response = applyDirectRouteResponseHooks(response, {
    originalClientModel: auditContext.originalClientModel,
  });

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
// Hook: Response model restore + client-facing SSE headers (symmetric)
// ---------------------------------------------------------------------------

function createDirectClientModelRewriteStream(clientModel: string): Transform {
  let buffer = '';
  return new Transform({
    transform(chunk: unknown, _encoding: BufferEncoding, callback: TransformCallback) {
      buffer += typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk ?? '');
      const parts = buffer.split(/\r?\n\r?\n/);
      buffer = parts.pop() ?? '';
      for (const part of parts) {
        if (!part) {
          continue;
        }
        this.push(`${rewriteDirectRouteSseFrameNative(part, clientModel)}\n\n`);
      }
      callback();
    },
    flush(callback: TransformCallback) {
      if (buffer) {
        this.push(rewriteDirectRouteSseFrameNative(buffer, clientModel));
        buffer = '';
      }
      callback();
    }
  });
}

function wrapDirectSseStreamWithClientModel(stream: unknown, clientModel: string): Readable {
  const transform = createDirectClientModelRewriteStream(clientModel);
  if (stream instanceof Readable || (stream && typeof (stream as Readable).pipe === 'function')) {
    const source = stream as Readable;
    source.on('error', (error) => transform.destroy(error));
    return source.pipe(transform);
  }
  throw new Error('router-direct response contains sseStream that is not a readable stream');
}

/**
 * Symmetric response hook for router-direct:
 * - restore client model over provider wire model (JSON + SSE)
 * - ensure client-facing SSE headers are present
 */
export function applyDirectRouteResponseHooks(
  response: unknown,
  options: { originalClientModel?: string }
): unknown {
  const responseIsRecord = Boolean(response) && typeof response === 'object' && !Array.isArray(response);
  const sourceRecord = responseIsRecord ? response as Record<string, unknown> : undefined;
  const plan = planDirectRouteResponseActionNative({
    responseIsRecord,
    hasSseStream: sourceRecord?.sseStream !== undefined && sourceRecord?.sseStream !== null,
    clientModel: options.originalClientModel,
  });
  if (plan.action === 'passthrough') {
    return response;
  }
  if (!sourceRecord) {
    throw new Error(`invalid router-direct response action for non-record: ${plan.action}`);
  }
  if (plan.action === 'project_json_model') {
    return rewriteDirectRouteResponseModelNative(sourceRecord, plan.clientModel as string);
  }
  if (plan.action === 'project_sse_headers_only' || plan.action === 'project_sse_headers_and_model_stream') {
    const record = { ...sourceRecord };
    record.headers = projectDirectRouteSseHeadersNative(record.headers);
    if (plan.action === 'project_sse_headers_and_model_stream') {
      record.sseStream = wrapDirectSseStreamWithClientModel(record.sseStream, plan.clientModel as string);
    }
    return record;
  }
  throw new Error(`unknown router-direct response action: ${String((plan as { action?: unknown }).action)}`);
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
  ctx.payload = payload;
  ctx.observedFields = projectDirectRouteAuditFieldsNative(payload).observedFields;
  return payload;
}

// ---------------------------------------------------------------------------
// Public helpers
// ---------------------------------------------------------------------------

export function isRouterDirectEligible(portConfig: PortConfig): boolean {
  return planDirectRouteEligibilityNative({
    mode: portConfig.mode,
    sameProtocolBehavior: portConfig.sameProtocolBehavior,
  }).eligible;
}

export function resolveRouterSameProtocolBehavior(portConfig: PortConfig): 'direct' | 'relay' {
  return planDirectRouteEligibilityNative({
    mode: portConfig.mode,
    sameProtocolBehavior: portConfig.sameProtocolBehavior,
  }).effectiveBehavior as 'direct' | 'relay';
}

/**
 * Read the original client model from a direct-route audit context.
 * Used by observability code that needs both client model and provider model.
 */
export function readOriginalClientModel(auditContext: RouterDirectAuditContext): string | undefined {
  return auditContext.originalClientModel;
}
