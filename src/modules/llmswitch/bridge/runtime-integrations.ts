/**
 * Runtime Integrations Bridge
 *
 * Snapshot hooks, responses conversation helpers, SSE converter, and
 * provider runtime ingress hooks.
 */

import type { ProviderErrorEvent, ProviderSuccessEvent } from '../../../types/llmswitch-local-types.js';
import { importCoreDist } from './module-loader.js';
import type { AnyRecord } from './module-loader.js';

type SnapshotHooksModule = {
  writeSnapshotViaHooks?: (options: AnyRecord) => Promise<void> | void;
};

let cachedSnapshotHooksModule: SnapshotHooksModule | null = null;

async function getSnapshotHooksModule(): Promise<SnapshotHooksModule> {
  if (!cachedSnapshotHooksModule) {
    cachedSnapshotHooksModule = await importCoreDist<SnapshotHooksModule>('conversion/snapshot-utils');
  }
  return cachedSnapshotHooksModule;
}

export async function writeSnapshotViaHooks(channelOrOptions: string | AnyRecord, payload?: AnyRecord): Promise<void> {
  const hooksModule = await getSnapshotHooksModule();
  const writer = hooksModule?.writeSnapshotViaHooks;
  if (typeof writer !== 'function') {
    throw new Error('[llmswitch-bridge] writeSnapshotViaHooks not available');
  }

  let options: AnyRecord | undefined;
  if (payload && typeof channelOrOptions === 'string') {
    const channelValue =
      typeof payload.channel === 'string' && payload.channel ? payload.channel : channelOrOptions;
    options = { ...payload, channel: channelValue };
  } else if (channelOrOptions && typeof channelOrOptions === 'object') {
    options = channelOrOptions;
  }

  if (!options) {
    return;
  }

  await writer(options);
}

type ResponsesConversationModule = {
  resumeResponsesConversation?: (
    responseId: string,
    submitPayload: AnyRecord,
    options?: { requestId?: string }
  ) => Promise<{ payload: AnyRecord; meta: AnyRecord }>;
  resumeLatestResponsesContinuationByScope?: (args: {
    payload: AnyRecord;
    sessionId?: string;
    conversationId?: string;
    requestId?: string;
  }) => { payload: AnyRecord; meta: AnyRecord } | null;
  rebindResponsesConversationRequestId?: (oldId: string, newId: string) => void;
  clearResponsesConversationByRequestId?: (requestId?: string) => void;
};

let cachedResponsesConversationModule: ResponsesConversationModule | null = null;

async function getResponsesConversationModule(): Promise<ResponsesConversationModule> {
  if (!cachedResponsesConversationModule) {
    cachedResponsesConversationModule = await importCoreDist<ResponsesConversationModule>(
      'conversion/shared/responses-conversation-store'
    );
  }
  return cachedResponsesConversationModule;
}

export async function resumeResponsesConversation(
  responseId: string,
  submitPayload: AnyRecord,
  options?: { requestId?: string }
): Promise<{ payload: AnyRecord; meta: AnyRecord }> {
  const mod = await getResponsesConversationModule();
  const fn = mod.resumeResponsesConversation;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] resumeResponsesConversation not available');
  }
  return await fn(responseId, submitPayload, options);
}

export async function rebindResponsesConversationRequestId(oldId?: string, newId?: string): Promise<void> {
  if (!oldId || !newId || oldId === newId) {
    return;
  }
  const mod = await getResponsesConversationModule();
  const fn = mod.rebindResponsesConversationRequestId;
  if (typeof fn === 'function') {
    fn(oldId, newId);
  }
}

export async function clearResponsesConversationByRequestId(requestId?: string): Promise<void> {
  if (!requestId) {
    return;
  }
  const mod = await getResponsesConversationModule();
  const fn = mod.clearResponsesConversationByRequestId;
  if (typeof fn === 'function') {
    fn(requestId);
  }
}

export async function resumeLatestResponsesContinuationByScope(args: {
  payload: AnyRecord;
  sessionId?: string;
  conversationId?: string;
  requestId?: string;
}): Promise<{ payload: AnyRecord; meta: AnyRecord } | null> {
  const mod = await getResponsesConversationModule();
  const fn = mod.resumeLatestResponsesContinuationByScope;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] resumeLatestResponsesContinuationByScope not available');
  }
  return fn(args);
}

type ResponsesSseModule = {
  ResponsesSseToJsonConverter?: new () => {
    convertSseToJson(stream: unknown, options: AnyRecord): Promise<unknown>;
  };
};

let cachedResponsesSseConverterFactory:
  | (() => { convertSseToJson(stream: unknown, options: AnyRecord): Promise<unknown> })
  | null = null;

export async function createResponsesSseToJsonConverter(): Promise<{
  convertSseToJson(stream: unknown, options: AnyRecord): Promise<unknown>;
}> {
  if (!cachedResponsesSseConverterFactory) {
    const mod = await importCoreDist<ResponsesSseModule>('sse/sse-to-json/index');
    const Ctor = mod.ResponsesSseToJsonConverter;
    if (typeof Ctor !== 'function') {
      throw new Error('[llmswitch-bridge] ResponsesSseToJsonConverter not available');
    }
    cachedResponsesSseConverterFactory = () => new Ctor();
  }
  return cachedResponsesSseConverterFactory();
}

type ProviderRuntimeIngressExports = {
  reportProviderErrorToRouterPolicy?: (event: ProviderErrorEvent) => ProviderErrorEvent;
  reportProviderSuccessToRouterPolicy?: (event: ProviderSuccessEvent) => ProviderSuccessEvent;
  setProviderRuntimeQuotaHooks?: (
    owner: unknown,
    hooks?: {
      onProviderError?: (event: ProviderErrorEvent) => void;
      onProviderSuccess?: (event: ProviderSuccessEvent) => void;
    }
  ) => void;
  setProviderRuntimeProviderQuotaHooks?: (
    owner: unknown,
    hooks?: {
      onProviderError?: (event: ProviderErrorEvent) => void;
    }
  ) => void;
};

let cachedProviderRuntimeIngress: ProviderRuntimeIngressExports | null = null;

async function getProviderRuntimeIngress(): Promise<ProviderRuntimeIngressExports> {
  if (!cachedProviderRuntimeIngress) {
    cachedProviderRuntimeIngress = await importCoreDist<ProviderRuntimeIngressExports>(
      'router/virtual-router/provider-runtime-ingress'
    );
  }
  return cachedProviderRuntimeIngress;
}

export async function preloadCriticalBridgeRuntimeModules(): Promise<{ loaded: string[] }> {
  const loaded: string[] = [];

  const snapshotHooksModule = await getSnapshotHooksModule();
  if (typeof snapshotHooksModule.writeSnapshotViaHooks !== 'function') {
    throw new Error('[llmswitch-bridge] preload failed: writeSnapshotViaHooks not available');
  }
  loaded.push('conversion/snapshot-utils');

  const responsesConversationModule = await getResponsesConversationModule();
  if (
    typeof responsesConversationModule.resumeResponsesConversation !== 'function'
    || typeof responsesConversationModule.resumeLatestResponsesContinuationByScope !== 'function'
  ) {
    throw new Error('[llmswitch-bridge] preload failed: responses conversation helpers not available');
  }
  loaded.push('conversion/shared/responses-conversation-store');

  const sseModule = await importCoreDist<ResponsesSseModule>('sse/sse-to-json/index');
  if (typeof sseModule.ResponsesSseToJsonConverter !== 'function') {
    throw new Error('[llmswitch-bridge] preload failed: ResponsesSseToJsonConverter not available');
  }
  loaded.push('sse/sse-to-json/index');

  const ingressModule = await getProviderRuntimeIngress();
  if (
    typeof ingressModule.reportProviderErrorToRouterPolicy !== 'function'
    || typeof ingressModule.reportProviderSuccessToRouterPolicy !== 'function'
  ) {
    throw new Error('[llmswitch-bridge] preload failed: provider runtime ingress hooks not available');
  }
  loaded.push('router/virtual-router/provider-runtime-ingress');

  return { loaded };
}

export async function reportProviderErrorToRouterPolicy(event: ProviderErrorEvent): Promise<ProviderErrorEvent> {
  const mod = await getProviderRuntimeIngress();
  const fn = mod.reportProviderErrorToRouterPolicy;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] reportProviderErrorToRouterPolicy not available');
  }
  return fn(event);
}

export async function reportProviderSuccessToRouterPolicy(event: ProviderSuccessEvent): Promise<ProviderSuccessEvent> {
  const mod = await getProviderRuntimeIngress();
  const fn = mod.reportProviderSuccessToRouterPolicy;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] reportProviderSuccessToRouterPolicy not available');
  }
  return fn(event);
}

export async function setProviderRuntimeQuotaHooks(
  owner: unknown,
  hooks?: {
    onProviderError?: (event: ProviderErrorEvent) => void;
    onProviderSuccess?: (event: ProviderSuccessEvent) => void;
  }
): Promise<boolean> {
  const mod = await getProviderRuntimeIngress();
  const fn = mod.setProviderRuntimeQuotaHooks;
  if (typeof fn !== 'function') {
    return false;
  }
  fn(owner, hooks);
  return true;
}

export async function setProviderRuntimeProviderQuotaHooks(
  owner: unknown,
  hooks?: {
    onProviderError?: (event: ProviderErrorEvent) => void;
  }
): Promise<boolean> {
  const mod = await getProviderRuntimeIngress();
  const fn = mod.setProviderRuntimeProviderQuotaHooks;
  if (typeof fn !== 'function') {
    return false;
  }
  fn(owner, hooks);
  return true;
}
