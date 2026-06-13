import type { PipelineExecutionResult } from '../../../handlers/types.js';
import { STREAM_LOG_FINISH_REASON_KEY } from '../../../utils/finish-reason.js';
import { importCoreDist } from '../../../../modules/llmswitch/bridge/module-loader.js';

type NativeChatProcessNodeResultSemanticsModule = {
  detectRetryableEmptyAssistantResponseWithNative?: (body: unknown, requestSemantics?: Record<string, unknown>) => PayloadContractSignal | null;
};

let cachedNativeSemanticsPromise: Promise<NativeChatProcessNodeResultSemanticsModule> | null = null;

async function getNativeSemantics(): Promise<NativeChatProcessNodeResultSemanticsModule> {
  if (!cachedNativeSemanticsPromise) {
    cachedNativeSemanticsPromise = importCoreDist<NativeChatProcessNodeResultSemanticsModule>(
      'native/router-hotpath/native-chat-process-node-result-semantics'
    );
  }
  return cachedNativeSemanticsPromise;
}

type ProviderSnapshotWriteArgs = {
  phase:
    | 'provider-request'
    | 'provider-response'
    | 'provider-request-contract'
    | 'provider-response-contract';
  requestId: string;
  data: unknown;
  headers?: Record<string, unknown>;
  url?: string;
  entryEndpoint?: string;
  clientRequestId?: string;
  providerKey?: string;
  providerId?: string;
  forceLocalDiskWriteWhenDisabled?: boolean;
};

import {
  hasRequestedToolsInSemantics,
  isRequiredToolCallTurn,
  isToolResultFollowupTurn
} from './request-executor-request-semantics.js';
import { formatUnknownError } from '../../../../utils/common-utils.js';
export { hasRequestedToolsInSemantics, isRequiredToolCallTurn, isToolResultFollowupTurn };

export type PayloadContractSignal = {
  reason: string;
  marker: string;
};

const EMPTY_ASSISTANT_SANITIZED_PLACEHOLDER =
  '[RouteCodex] assistant response became empty after response sanitization.';

function containsEmptyAssistantSanitizedPlaceholder(value: unknown): boolean {
  if (typeof value === 'string') {
    return value.includes(EMPTY_ASSISTANT_SANITIZED_PLACEHOLDER);
  }
  if (Array.isArray(value)) {
    return value.some((entry) => containsEmptyAssistantSanitizedPlaceholder(entry));
  }
  if (!value || typeof value !== 'object') {
    return false;
  }
  return Object.values(value as Record<string, unknown>).some((entry) => containsEmptyAssistantSanitizedPlaceholder(entry));
}

function bodyHasVisibleAssistantPayload(body: unknown): boolean {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return false;
  }
  const record = body as Record<string, unknown>;
  const choices = Array.isArray(record.choices) ? record.choices : [];
  for (const choice of choices) {
    if (!choice || typeof choice !== 'object' || Array.isArray(choice)) {
      continue;
    }
    const message = (choice as Record<string, unknown>).message;
    if (message && typeof message === 'object' && !Array.isArray(message)) {
      const content = (message as Record<string, unknown>).content;
      if (typeof content === 'string' && content.trim()) {
        return true;
      }
      if (Array.isArray(content) && content.some((part) => valueHasNonEmptyPayloadContent(part))) {
        return true;
      }
    }
  }
  const outputText = record.output_text;
  if (typeof outputText === 'string' && outputText.trim()) {
    return true;
  }
  const content = record.content;
  if (typeof content === 'string' && content.trim()) {
    return true;
  }
  return false;
}

export async function detectRetryableEmptyAssistantResponse(
  body: unknown,
  requestSemantics?: Record<string, unknown>
): Promise<PayloadContractSignal | null> {
  if (bodyHasVisibleAssistantPayload(body)) {
    return null;
  }
  const fn = (await getNativeSemantics()).detectRetryableEmptyAssistantResponseWithNative;
  if (typeof fn !== 'function') throw new Error('[response-contract] detectRetryableEmptyAssistantResponseWithNative unavailable');
  return fn(body, requestSemantics);
}

function valueHasNonEmptyPayloadContent(value: unknown): boolean {
  if (typeof value === 'string') {
    return value.trim().length > 0;
  }
  if (Array.isArray(value)) {
    return value.some((entry) => valueHasNonEmptyPayloadContent(entry));
  }
  if (!value || typeof value !== 'object') {
    return false;
  }
  const record = value as Record<string, unknown>;
  return [
    record.content,
    record.text,
    record.prompt,
    record.input_text,
    record.query,
    record.instructions,
    record.instruction,
    record.message,
    record.messages,
    record.input,
    record.contents,
    record.parts
  ].some((entry) => valueHasNonEmptyPayloadContent(entry));
}

function unwrapProviderRequestPayloadBody(payload: unknown): Record<string, unknown> | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return null;
  }
  const root = payload as Record<string, unknown>;
  if (root.data && typeof root.data === 'object' && !Array.isArray(root.data)) {
    return root.data as Record<string, unknown>;
  }
  return root;
}

export function detectEmptyProviderRequestPayload(providerPayload: unknown): PayloadContractSignal | null {
  const body = unwrapProviderRequestPayloadBody(providerPayload);
  if (!body) {
    return null;
  }
  const hasPromptLikeContentOutsideMessages =
    valueHasNonEmptyPayloadContent(body.input)
    || valueHasNonEmptyPayloadContent(body.prompt)
    || valueHasNonEmptyPayloadContent(body.contents)
    || valueHasNonEmptyPayloadContent(body.content)
    || valueHasNonEmptyPayloadContent(body.text)
    || valueHasNonEmptyPayloadContent(body.query)
    || valueHasNonEmptyPayloadContent(body.instructions)
    || valueHasNonEmptyPayloadContent(body.instruction);
  if (Array.isArray(body.messages) && body.messages.length === 0 && !hasPromptLikeContentOutsideMessages) {
    return {
      reason: 'provider request messages[] is empty and no other prompt/input content exists',
      marker: 'provider_request_empty_messages'
    };
  }
  const hasPromptLikeContentOutsideInput =
    valueHasNonEmptyPayloadContent(body.messages)
    || valueHasNonEmptyPayloadContent(body.prompt)
    || valueHasNonEmptyPayloadContent(body.contents)
    || valueHasNonEmptyPayloadContent(body.content)
    || valueHasNonEmptyPayloadContent(body.text)
    || valueHasNonEmptyPayloadContent(body.query)
    || valueHasNonEmptyPayloadContent(body.instructions)
    || valueHasNonEmptyPayloadContent(body.instruction);
  if (Array.isArray(body.input) && body.input.length === 0 && !hasPromptLikeContentOutsideInput) {
    return {
      reason: 'provider request input[] is empty and no other prompt/message content exists',
      marker: 'provider_request_empty_input'
    };
  }
  return null;
}

export function detectAssistantSanitizationPlaceholder(body: unknown): PayloadContractSignal | null {
  if (!body || typeof body !== 'object') {
    return null;
  }
  if (!containsEmptyAssistantSanitizedPlaceholder(body)) {
    return null;
  }
  return {
    reason: 'assistant response was repaired with the empty-after-sanitization placeholder',
    marker: 'assistant_sanitized_empty_placeholder'
  };
}

export async function persistPayloadContractProviderSnapshots(args: {
  requestId: string;
  entryEndpoint?: string;
  providerKey?: string;
  providerId?: string;
  providerRequestPayload: unknown;
  providerRequestHeaders?: Record<string, unknown>;
  providerRequestUrl?: string;
  normalizedResponse: PipelineExecutionResult;
  convertedResponse: PipelineExecutionResult;
  payloadContractSignal: PayloadContractSignal;
  writeProviderSnapshot: (args: ProviderSnapshotWriteArgs) => Promise<void>;
}): Promise<void> {
  const requestPayload =
    args.providerRequestPayload && typeof args.providerRequestPayload === 'object'
      ? args.providerRequestPayload
      : { payload: args.providerRequestPayload };
  await args.writeProviderSnapshot({
    phase: 'provider-request-contract',
    requestId: args.requestId,
    clientRequestId: args.requestId,
    entryEndpoint: args.entryEndpoint,
    providerKey: args.providerKey,
    providerId: args.providerId,
    headers: args.providerRequestHeaders,
    url: args.providerRequestUrl,
    data: requestPayload,
    forceLocalDiskWriteWhenDisabled: true
  });
  await args.writeProviderSnapshot({
    phase: 'provider-response-contract',
    requestId: args.requestId,
    clientRequestId: args.requestId,
    entryEndpoint: args.entryEndpoint,
    providerKey: args.providerKey,
    providerId: args.providerId,
    headers:
      args.normalizedResponse.headers && typeof args.normalizedResponse.headers === 'object'
        ? args.normalizedResponse.headers
        : undefined,
    url:
      typeof (args.normalizedResponse as { url?: unknown }).url === 'string'
        ? String((args.normalizedResponse as { url?: unknown }).url)
        : args.providerRequestUrl,
    data: {
      payloadContractSignal: args.payloadContractSignal,
      normalizedResponse: {
        status: args.normalizedResponse.status ?? null,
        headers: args.normalizedResponse.headers ?? null,
        body: args.normalizedResponse.body ?? null
      },
      convertedResponse: {
        status: args.convertedResponse.status ?? null,
        headers: args.convertedResponse.headers ?? null,
        body: args.convertedResponse.body ?? null
      }
    },
    forceLocalDiskWriteWhenDisabled: true
  });
}


export function bodyContainsReasoningStopFinalizedMarker(_body: unknown): boolean {
  return false;
}
