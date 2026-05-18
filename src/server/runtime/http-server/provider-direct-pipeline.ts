/**
 * Provider Direct Pipeline — Bypass virtual router for provider-mode ports
 *
 * Handles requests on ports with mode="provider":
 * - Direct:  same protocol, pass-through with snapshot hooks
 * - Relay:   different protocol, convert then forward
 * - Auto:    automatic resolution based on protocol match
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

  let payloadToSend = requestPayload;
  if (actualBehavior === 'relay') {
    payloadToSend = await convertProtocolForRelay(
      requestPayload,
      inboundProtocol,
      providerHandle.providerProtocol,
    );
  }
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

async function convertProtocolForRelay(
  payload: Record<string, unknown>,
  inboundProtocol: ProviderProtocol,
  providerProtocol: ProviderProtocol,
): Promise<Record<string, unknown>> {
  if (inboundProtocol === providerProtocol) {
    return payload;
  }
  if (!isSupportedRelayPair(inboundProtocol, providerProtocol)) {
    throw new Error(
      `Provider mode relay only supports openai-chat <-> anthropic-messages today: inbound=${inboundProtocol}, provider=${providerProtocol}`,
    );
  }
  return remapPayloadFields(payload, inboundProtocol, providerProtocol);
}

/**
 * Supported relay pairs for provider-direct pipeline.
 * Covers all 4 major protocol families. Unsupported pairs must fail-fast.
 */
function isSupportedRelayPair(from: ProviderProtocol, to: ProviderProtocol): boolean {
  if (from === to) return true;
  const pairs: [ProviderProtocol, ProviderProtocol][] = [
    ['openai-chat', 'anthropic-messages'],
    ['anthropic-messages', 'openai-chat'],
    ['openai-chat', 'openai-responses'],
    ['openai-responses', 'openai-chat'],
    ['anthropic-messages', 'openai-responses'],
    ['openai-responses', 'anthropic-messages'],
    ['openai-chat', 'gemini-chat'],
    ['gemini-chat', 'openai-chat'],
    ['anthropic-messages', 'gemini-chat'],
    ['gemini-chat', 'anthropic-messages'],
    ['openai-responses', 'gemini-chat'],
    ['gemini-chat', 'openai-responses'],
  ];
  return pairs.some(([a, b]) => a === from && b === to);
}

function remapPayloadFields(
  payload: Record<string, unknown>,
  from: ProviderProtocol,
  to: ProviderProtocol,
): Record<string, unknown> {
  const result = { ...payload };

  if (from === 'openai-chat' && to === 'anthropic-messages') {
    if (result.messages) {
      const messages = result.messages as Array<Record<string, unknown>>;
      const systemMsgs = messages.filter((m) => m.role === 'system');
      if (systemMsgs.length > 0) {
        result.system = systemMsgs.map((m) => m.content).join('\n\n');
        result.messages = messages.filter((m) => m.role !== 'system');
      }
    }
    if (result.max_tokens === undefined) {
      result.max_tokens = 4096;
    }
    result.stream = result.stream ?? false;
  } else if (from === 'anthropic-messages' && to === 'openai-chat') {
    if (result.system && typeof result.system === 'string') {
      const messages = (result.messages as Array<Record<string, unknown>>) ?? [];
      messages.unshift({ role: 'system', content: result.system });
      result.messages = messages;
      delete result.system;
    }
    result.stream = result.stream ?? false;
  }

  return result;
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
