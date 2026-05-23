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
  detectInboundProtocol: (req: { path?: string; headers?: Record<string, string | string[] | undefined> }) => ProviderProtocol;
  preparePayload?: (
    payload: Record<string, unknown>,
    context: { port: number; providerKey: string; protocol: ProviderProtocol; actualBehavior: 'direct' | 'relay' },
  ) => void;
  onSnapshotBefore?: (payload: Record<string, unknown>, context: { port: number; providerKey: string; protocol: ProviderProtocol }) => void;
  onSnapshotAfter?: (result: unknown, context: { port: number; providerKey: string; protocol: ProviderProtocol }) => void;
}

export interface ProviderDirectPipelineResult {
  response: unknown;
  providerHandle: ProviderHandle;
  actualBehavior: 'direct' | 'relay';
  inboundProtocol: ProviderProtocol;
  providerProtocol: ProviderProtocol;
}

export async function executeProviderDirectPipeline(
  requestPayload: Record<string, unknown>,
  requestInfo: { path?: string; headers?: Record<string, string | string[] | undefined> },
  options: ProviderDirectPipelineOptions,
): Promise<ProviderDirectPipelineResult> {
  const { portConfig, resolveProvider, detectInboundProtocol } = options;
  const { providerBinding, protocolBehavior } = portConfig;

  if (!providerBinding) {
    throw new Error('Provider mode port missing providerBinding');
  }

  const providerHandle = resolveProvider(providerBinding);
  if (!providerHandle) {
    throw new Error(`Provider not found for binding: ${providerBinding}`);
  }

  const inboundProtocol = detectInboundProtocol(requestInfo);
  const behavior = protocolBehavior ?? 'auto';
  const actualBehavior = resolveActualBehavior(behavior, inboundProtocol, providerHandle.providerProtocol);

  if (behavior === 'direct') {
    const mismatch = checkDirectProtocolMatch(inboundProtocol, providerHandle.providerProtocol);
    if (mismatch) {
      throw new Error(mismatch);
    }
  }

  options.onSnapshotBefore?.(requestPayload, {
    port: portConfig.port,
    providerKey: providerBinding,
    protocol: inboundProtocol,
  });

  if (actualBehavior === 'relay') {
    throw new Error(
      `Provider mode relay must run through Hub Pipeline/chat process, not provider-direct: inbound=${inboundProtocol}, provider=${providerHandle.providerProtocol}`,
    );
  }

  const payloadToSend = requestPayload;
  options.preparePayload?.(payloadToSend, {
    port: portConfig.port,
    providerKey: providerBinding,
    protocol: inboundProtocol,
    actualBehavior,
  });

  const response = actualBehavior === 'direct' && typeof providerHandle.instance.processIncomingDirect === 'function'
    ? await providerHandle.instance.processIncomingDirect(payloadToSend)
    : await providerHandle.instance.processIncoming(payloadToSend);

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
  };
}

export function detectInboundProtocolFromRequest(
  req: { path?: string; headers?: Record<string, string | string[] | undefined> },
): ProviderProtocol {
  const path = (req.path ?? '').toLowerCase();
  if (path.startsWith('/v1/messages') || path.startsWith('/v1/anthropic')) {
    return 'anthropic-messages';
  }
  if (path.includes('/responses')) {
    return 'openai-responses';
  }
  if (path.includes('/gemini') || path.includes('/v1beta')) {
    return 'gemini-chat';
  }
  return 'openai-chat';
}
