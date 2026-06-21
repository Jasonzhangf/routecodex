/**
 * Provider Direct Pipeline — Bypass virtual router for provider-mode ports.
 *
 * Contract: this path is same-protocol direct passthrough only. Cross-protocol
 * relay is owned by the Hub Pipeline / chat process; do not add protocol or
 * tool-shape rewrites here.
 */

import type { PortConfig } from './port-config-types.js';
import { checkDirectProtocolMatch, resolveActualBehavior } from './port-config-validator.js';
import type { ProviderHandle, ProviderProtocol } from './types.js';

export interface ProviderDirectPipelineOptions {
  portConfig: PortConfig;
  resolveProvider: (bindingKey: string) => ProviderHandle | undefined;
  resolveInboundProtocol: (entryPath: string | undefined) => ProviderProtocol;
  preparePayload?: (
    payload: Record<string, unknown>,
    context: { port: number; providerKey: string; protocol: ProviderProtocol; actualBehavior: 'direct' | 'relay' },
  ) => void;
  onSnapshotBefore?: (payload: Record<string, unknown>, context: { port: number; providerKey: string; protocol: ProviderProtocol }) => void;
  onSnapshotAfter?: (result: unknown, context: { port: number; providerKey: string; protocol: ProviderProtocol }) => void;
  /** Called when provider-mode direct transport fails; caller must report through ErrorErr01-06. */
  onProviderError?: (error: unknown, context: ProviderDirectAuditContext) => Promise<void> | void;
}

export interface ProviderDirectAuditContext {
  payload: Record<string, unknown>;
  port: number;
  providerKey: string;
  inboundProtocol: ProviderProtocol;
  providerProtocol: ProviderProtocol;
  actualBehavior: 'direct' | 'relay';
}

export interface ProviderDirectPipelineResult {
  response: unknown;
  providerHandle: ProviderHandle;
  actualBehavior: 'direct' | 'relay';
  inboundProtocol: ProviderProtocol;
  providerProtocol: ProviderProtocol;
  externalLatencyStartedAtMs: number;
  externalLatencyMs: number;
}

export async function executeProviderDirectPipeline(
  requestPayload: Record<string, unknown>,
  entryPath: string | undefined,
  options: ProviderDirectPipelineOptions,
): Promise<ProviderDirectPipelineResult> {
  const { portConfig, resolveProvider, resolveInboundProtocol } = options;
  const { providerBinding, protocolBehavior } = portConfig;

  if (!providerBinding) {
    throw new Error('Provider mode port missing providerBinding');
  }

  const providerHandle = resolveProvider(providerBinding);
  if (!providerHandle) {
    throw new Error(`Provider not found for binding: ${providerBinding}`);
  }

  const inboundProtocol = resolveInboundProtocol(entryPath);
  const behavior = protocolBehavior ?? 'auto';
  const actualBehavior = resolveActualBehavior(behavior, inboundProtocol, providerHandle.providerProtocol);

  if (behavior === 'direct') {
    const mismatch = checkDirectProtocolMatch(inboundProtocol, providerHandle.providerProtocol);
    if (mismatch) {
      throw new Error(mismatch);
    }
  }

  const payloadToSend = requestPayload;

  options.onSnapshotBefore?.(payloadToSend, {
    port: portConfig.port,
    providerKey: providerBinding,
    protocol: inboundProtocol,
  });

  if (actualBehavior === 'relay') {
    throw new Error(
      `Provider mode relay must run through Hub Pipeline/chat process, not provider-direct: inbound=${inboundProtocol}, provider=${providerHandle.providerProtocol}`,
    );
  }

  options.preparePayload?.(payloadToSend, {
    port: portConfig.port,
    providerKey: providerBinding,
    protocol: inboundProtocol,
    actualBehavior,
  });

  const auditContext: ProviderDirectAuditContext = {
    payload: payloadToSend,
    port: portConfig.port,
    providerKey: providerBinding,
    inboundProtocol,
    providerProtocol: providerHandle.providerProtocol,
    actualBehavior,
  };

  const providerStartedAtMs = Date.now();
  let response: unknown;
  try {
    response = actualBehavior === 'direct' && typeof providerHandle.instance.processIncomingDirect === 'function'
      ? await providerHandle.instance.processIncomingDirect(payloadToSend)
      : await providerHandle.instance.processIncoming(payloadToSend);
  } catch (error) {
    await options.onProviderError?.(error, auditContext);
    throw error;
  }
  const externalLatencyMs = Math.max(0, Date.now() - providerStartedAtMs);

  options.onSnapshotAfter?.(response, {
    port: portConfig.port,
    providerKey: providerBinding,
    protocol: inboundProtocol,
  });

  return {
    response,
    providerHandle,
    actualBehavior,
    inboundProtocol,
    providerProtocol: providerHandle.providerProtocol,
    externalLatencyStartedAtMs: providerStartedAtMs,
    externalLatencyMs,
  };
}

export function resolveInboundProtocolFromEntryPath(
  entryPath: string | undefined
): ProviderProtocol {
  const path = (entryPath ?? '').toLowerCase();
  if (path.startsWith('/v1/messages') || path.startsWith('/v1/anthropic')) {
    return 'anthropic-messages';
  }
  if (path.includes('/responses')) {
    return 'openai-responses';
  }
  if (path.includes('/gemini') || path.includes('/v1beta')) {
    return 'gemini-chat';
  }
  if (path.startsWith('/v1/chat/completions') || path.startsWith('/chat/completions')) {
    return 'openai-chat';
  }
  throw new Error(`Unsupported inbound protocol entry path: ${entryPath ?? ''}`);
}
