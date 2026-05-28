/**
 * Router Direct Pipeline — Same-Protocol Bypass for Router-Mode Ports
 *
 * When a router-mode port has sameProtocolBehavior='direct' (default), and the
 * Virtual Router selects a provider with the same protocol as the inbound request,
 * this pipeline bypasses the full executor pipeline and forwards the request directly
 * to the provider.
 *
 * Design intent: transparent passthrough + audit trail.
 * - The payload from Hub Pipeline is passed through without transformation.
 * - All observable fields are recorded in appliedOverrides for snapshot/log traceability.
 * - Response is passed through without outbound rewriting.
 * - Fail-fast: no fallback, no silent compensation.
 */

import type { PortConfig } from './port-config-types.js';
import type { ProviderHandle, ProviderProtocol } from './types.js';
import { detectInboundProtocolFromRequest } from './provider-direct-pipeline.js';

/** Context snapshot for a single router-direct request — feeds snapshot hooks and logs. */
export interface RouterDirectAuditContext {
  /** Payload before audit recording (Hub Pipeline output, unchanged) */
  originalPayload: Record<string, unknown>;
  /** Observable fields recorded for traceability */
  observedFields: Array<{
    field: string;
    value: unknown;
  }>;
  providerKey: string;
  inboundProtocol: ProviderProtocol;
  providerProtocol: ProviderProtocol;
  routingDecision?: { routeName?: string; pool?: string[] };
  processMode?: string;
}

export interface RouterDirectInput {
  portConfig: PortConfig;
  providerPayload: Record<string, unknown>;
  requestPayload: Record<string, unknown>;
  target: {
    providerKey: string;
    providerType: string;
    runtimeKey?: string;
    processMode?: string;
  };
  routingDecision?: { routeName?: string; pool?: string[] };
  processMode: string;
  requestInfo: { path?: string; headers?: Record<string, string | string[] | undefined> };
  resolveProviderByRuntimeKey: (runtimeKey?: string) => ProviderHandle | undefined;
  /** Called immediately before provider.processIncoming, with the payload about to be sent. */
  onSnapshotBefore?: (payload: Record<string, unknown>, context: RouterDirectAuditContext) => void;
  /** Called with the raw provider response before any further processing. */
  onSnapshotAfter?: (response: unknown, context: RouterDirectAuditContext) => void;
}

export interface RouterDirectResult {
  used: true;
  response: unknown;
  providerHandle: ProviderHandle;
  auditContext: RouterDirectAuditContext;
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

  const inboundProtocol = detectInboundProtocolFromRequest(requestInfo);
  const providerProtocol = providerHandle.providerProtocol;
  if (inboundProtocol !== providerProtocol) {
    return {
      used: false,
      reason: `protocol mismatch: inbound=${inboundProtocol}, provider=${providerProtocol}`,
    };
  }

  const auditContext: RouterDirectAuditContext = {
    originalPayload: structuredClone(input.requestPayload),
    observedFields: [],
    providerKey: target.providerKey,
    inboundProtocol,
    providerProtocol,
    routingDecision: input.routingDecision,
    processMode: input.processMode,
  };

  const payloadToSend = recordPayloadAudit(input.requestPayload, auditContext);

  input.onSnapshotBefore?.(payloadToSend, auditContext);

  const response =
    typeof providerHandle.instance.processIncomingDirect === 'function'
      ? await providerHandle.instance.processIncomingDirect(payloadToSend)
      : await providerHandle.instance.processIncoming(payloadToSend);

  input.onSnapshotAfter?.(response, auditContext);

  return {
    used: true,
    response,
    providerHandle,
    auditContext,
  };
}

/**
 * Record observable fields from the payload into auditContext.observedFields.
 * This is an audit pass only — the payload itself is returned unchanged.
 *
 * Observable fields: model, reasoning, thinking, max_tokens.
 * (These are the fields surfaced in logs/snapshots for traceability purposes.)
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

/** Fields surfaced in audit logs/snapshots for traceability. */
const OBSERVABLE_FIELDS = ['model', 'reasoning', 'thinking', 'max_tokens'] as const;

export function isRouterDirectEligible(portConfig: PortConfig): boolean {
  if (portConfig.mode !== 'router') return false;
  return (portConfig.sameProtocolBehavior ?? 'direct') === 'direct';
}

export function resolveRouterSameProtocolBehavior(portConfig: PortConfig): 'direct' | 'relay' {
  if (portConfig.mode !== 'router') return 'relay';
  return portConfig.sameProtocolBehavior ?? 'direct';
}
