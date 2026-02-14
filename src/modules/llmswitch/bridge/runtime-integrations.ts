/**
 * Runtime Integrations Bridge
 *
 * Snapshot hooks, responses conversation helpers, SSE converter, and
 * provider error/success centers.
 */

import type { ProviderErrorEvent, ProviderSuccessEvent } from '@jsonstudio/llms/dist/router/virtual-router/types.js';
import { importCoreDist } from './module-loader.js';
import type { AnyRecord } from './module-loader.js';

type SnapshotHooksModule = {
  writeSnapshotViaHooks?: (options: AnyRecord) => Promise<void> | void;
};

export async function writeSnapshotViaHooks(channelOrOptions: string | AnyRecord, payload?: AnyRecord): Promise<void> {
  let hooksModule: SnapshotHooksModule | null = null;
  try {
    hooksModule = await importCoreDist<SnapshotHooksModule>('conversion/shared/snapshot-hooks');
  } catch {
    hooksModule = null;
  }
  const writer = hooksModule?.writeSnapshotViaHooks;
  if (typeof writer !== 'function') {
    return;
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
  rebindResponsesConversationRequestId?: (oldId: string, newId: string) => void;
};

export async function resumeResponsesConversation(
  responseId: string,
  submitPayload: AnyRecord,
  options?: { requestId?: string }
): Promise<{ payload: AnyRecord; meta: AnyRecord }> {
  const mod = await importCoreDist<ResponsesConversationModule>('conversion/shared/responses-conversation-store');
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
  const mod = await importCoreDist<ResponsesConversationModule>('conversion/shared/responses-conversation-store');
  const fn = mod.rebindResponsesConversationRequestId;
  if (typeof fn === 'function') {
    fn(oldId, newId);
  }
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

type ProviderErrorCenterExports = {
  providerErrorCenter?: {
    emit(event: ProviderErrorEvent): void;
    subscribe?(handler: (event: ProviderErrorEvent) => void): () => void;
  };
};

let cachedProviderErrorCenter: ProviderErrorCenterExports['providerErrorCenter'] | null = null;

export async function getProviderErrorCenter(): Promise<ProviderErrorCenterExports['providerErrorCenter']> {
  if (!cachedProviderErrorCenter) {
    const mod = await importCoreDist<ProviderErrorCenterExports>('router/virtual-router/error-center');
    const center = mod.providerErrorCenter;
    if (!center) {
      throw new Error('[llmswitch-bridge] providerErrorCenter not available');
    }
    cachedProviderErrorCenter = center;
  }
  return cachedProviderErrorCenter;
}

type ProviderSuccessCenterExports = {
  providerSuccessCenter?: {
    emit(event: ProviderSuccessEvent): void;
    subscribe?(handler: (event: ProviderSuccessEvent) => void): () => void;
  };
};

let cachedProviderSuccessCenter: ProviderSuccessCenterExports['providerSuccessCenter'] | null = null;

export async function getProviderSuccessCenter(): Promise<ProviderSuccessCenterExports['providerSuccessCenter']> {
  if (!cachedProviderSuccessCenter) {
    const mod = await importCoreDist<ProviderSuccessCenterExports>('router/virtual-router/success-center');
    const center = mod.providerSuccessCenter;
    if (!center) {
      throw new Error('[llmswitch-bridge] providerSuccessCenter not available');
    }
    cachedProviderSuccessCenter = center;
  }
  return cachedProviderSuccessCenter;
}
