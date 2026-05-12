import type { PipelineExecutionResult } from '../../../handlers/types.js';
import {
  REASONING_STOP_FINALIZED_FLAG_KEY,
  STREAM_CONTRACT_PROBE_BODY_KEY,
} from './servertool-response-normalizer.js';
import { readString } from './request-executor-error-shared.js';
import { deriveFinishReason, STREAM_LOG_FINISH_REASON_KEY } from '../../../utils/finish-reason.js';
import {
  bodyContainsReasoningStopFinalizedMarker,
  valueContainsReasoningStopFinalizedMarker
} from './reasoning-stop-finalization-visibility.js';
export { bodyContainsReasoningStopFinalizedMarker } from './reasoning-stop-finalization-visibility.js';


type StoplessLogMode = 'on' | 'off' | 'endless';
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
import { formatUnknownError, isRecord } from '../../../../utils/common-utils.js';
export { hasRequestedToolsInSemantics, isRequiredToolCallTurn, isToolResultFollowupTurn };

export type PayloadContractSignal = {
  reason: string;
  marker: string;
};

const EMPTY_ASSISTANT_SANITIZED_PLACEHOLDER =
  '[RouteCodex] assistant response became empty after response sanitization.';

function unwrapStreamContractProbeBody(body: Record<string, unknown>): Record<string, unknown> | null {
  if (!Object.prototype.hasOwnProperty.call(body, '__sse_responses')) {
    return body;
  }
  const probe = body[STREAM_CONTRACT_PROBE_BODY_KEY];
  if (!isRecord(probe)) {
    return null;
  }
  return probe;
}

function valueHasVisibleAssistantText(value: unknown): boolean {
  if (typeof value === 'string') {
    return value.trim().length > 0;
  }
  if (Array.isArray(value)) {
    return value.some((entry) => valueHasVisibleAssistantText(entry));
  }
  if (!isRecord(value)) {
    return false;
  }
  const entryType = readString(value.type)?.toLowerCase();
  if (
    entryType === 'refusal'
    || entryType === 'tool_result'
    || entryType === 'function_call_output'
    || entryType === 'reasoning'
  ) {
    return false;
  }
  return (
    valueHasVisibleAssistantText(value.text)
    || valueHasVisibleAssistantText(value.output_text)
    || valueHasVisibleAssistantText(value.content)
  );
}

function valueHasReasoningOnlyContent(value: unknown): boolean {
  if (typeof value === 'string') {
    return false;
  }
  if (Array.isArray(value)) {
    return value.some((entry) => valueHasReasoningOnlyContent(entry));
  }
  if (!isRecord(value)) {
    return false;
  }
  const entryType = readString(value.type)?.toLowerCase();
  if (entryType === 'reasoning') {
    return true;
  }
  return (
    valueHasReasoningOnlyContent(value.reasoning)
    || valueHasReasoningOnlyContent(value.content)
    || valueHasReasoningOnlyContent(value.output)
  );
}

function hasNonEmptyToolCalls(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0;
}

function hasOutputFunctionCalls(value: unknown): boolean {
  if (!Array.isArray(value)) {
    return false;
  }
  return value.some((entry) => {
    if (!isRecord(entry)) {
      return false;
    }
    const entryType = readString(entry.type)?.toLowerCase() ?? '';
    return entryType === 'function_call' || entryType === 'tool_call';
  });
}

function containsToolRegistryMissingText(value: unknown): boolean {
  if (typeof value === 'string') {
    const normalized = value.toLowerCase();
    return (
      normalized.includes('tool not found')
      || normalized.includes('tool registry missing')
      || normalized.includes('unknown tool')
      || normalized.includes('missing tool')
    );
  }
  if (Array.isArray(value)) {
    return value.some((entry) => containsToolRegistryMissingText(entry));
  }
  if (!isRecord(value)) {
    return false;
  }
  return Object.values(value).some((entry) => containsToolRegistryMissingText(entry));
}


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

export function detectRetryableEmptyAssistantResponse(
  body: unknown,
  requestSemantics?: Record<string, unknown>
): PayloadContractSignal | null {
  if (!isRecord(body)) {
    return null;
  }
  const effectiveBody = unwrapStreamContractProbeBody(body);
  if (!effectiveBody) {
    return null;
  }

  const choices = Array.isArray(effectiveBody.choices) ? effectiveBody.choices : [];
  if (choices.length > 0) {
    const firstChoice = isRecord(choices[0]) ? choices[0] : undefined;
    if (!firstChoice) {
      return null;
    }
    const finishReason = readString(firstChoice.finish_reason)?.toLowerCase() ?? '';
    const message = isRecord(firstChoice.message) ? firstChoice.message : undefined;
    const hasToolCalls = hasNonEmptyToolCalls(message?.tool_calls);
    const hasText =
      valueHasVisibleAssistantText(message?.content)
      || valueHasVisibleAssistantText(firstChoice.content);
    const combinedText = [message?.content, firstChoice.content]
      .filter((item) => valueHasVisibleAssistantText(item))
      .map((item) => String(item))
      .join('\n');
    if ((finishReason === 'stop' || finishReason === 'tool_calls' || !finishReason) && !hasToolCalls && !hasText) {
      return {
        reason: `finish_reason=${finishReason || 'unknown'} but assistant text/tool_calls are empty`,
        marker: 'chat_empty_assistant'
      };
    }
    if (
      (finishReason === 'stop' || !finishReason)
      && !hasToolCalls
      && isRequiredToolCallTurn(requestSemantics)
      && !isToolResultFollowupTurn(requestSemantics)
    ) {
      return {
        reason: `finish_reason=${finishReason || 'unknown'} with declared request tools but no structured tool_calls`,
        marker: 'chat_missing_required_tool_call'
      };
    }
    if ((finishReason === 'stop' || finishReason === 'tool_calls' || !finishReason) && !hasToolCalls && containsToolRegistryMissingText(combinedText)) {
      return {
        reason: 'assistant emitted textual tool-not-found complaint without structured tool_calls',
        marker: 'chat_textual_tool_registry_missing'
      };
    }
  }

  const status = readString(effectiveBody.status)?.toLowerCase() ?? '';
  if (status === 'completed' || status === 'stop') {
    const requiredAction = isRecord(effectiveBody.required_action) ? effectiveBody.required_action : undefined;
    const submitToolOutputs =
      requiredAction && isRecord(requiredAction.submit_tool_outputs)
        ? requiredAction.submit_tool_outputs
        : undefined;
    const hasRequiredActionToolCalls = hasNonEmptyToolCalls(submitToolOutputs?.tool_calls);
    const hasFunctionCalls = hasOutputFunctionCalls(effectiveBody.output);
    const hasText =
      valueHasVisibleAssistantText(effectiveBody.output_text)
      || valueHasVisibleAssistantText(effectiveBody.output);
    const hasReasoningOnly =
      valueHasReasoningOnlyContent(effectiveBody.output)
      || valueHasReasoningOnlyContent(effectiveBody.reasoning);
    if (!hasRequiredActionToolCalls && !hasFunctionCalls && !hasText && !hasReasoningOnly) {
      return {
        reason: `responses status=${status} but output text/tool_calls are empty${hasReasoningOnly ? ' (reasoning-only payload)' : ''}`,
        marker: 'responses_empty_output'
      };
    }
    if (
      !hasRequiredActionToolCalls &&
      !hasFunctionCalls &&
      isRequiredToolCallTurn(requestSemantics) &&
      !isToolResultFollowupTurn(requestSemantics) &&
      !containsReasoningStopFinalizedMarker(effectiveBody.output) &&
      !containsReasoningStopFinalizedMarker(effectiveBody.output_text)
    ) {
      return {
        reason: `responses status=${status} with declared request tools but no function_call output`,
        marker: 'responses_missing_required_tool_call'
      };
    }
    if (!hasRequiredActionToolCalls && !hasFunctionCalls && containsToolRegistryMissingText(effectiveBody.output_text)) {
      return {
        reason: 'responses completed with textual tool-not-found complaint but no function_call output',
        marker: 'responses_textual_tool_registry_missing'
      };
    }
  }

  return null;
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

function containsReasoningStopFinalizedMarker(value: unknown): boolean {
  return valueContainsReasoningStopFinalizedMarker(value);
}

function hasAnthropicToolUseSuccess(body: Record<string, unknown>): boolean {
  const data = isRecord(body.data) ? body.data : body;
  const stopReason = readString(data.stop_reason)?.toLowerCase() ?? '';
  const content = Array.isArray(data.content) ? data.content : [];
  const hasToolUseBlock = content.some((item) => isRecord(item) && readString(item.type) === 'tool_use');
  return stopReason === 'tool_use' || hasToolUseBlock;
}

export function detectStoplessTerminationWithoutFinalization(
  body: unknown,
  stoplessMode?: StoplessLogMode
): PayloadContractSignal | null {
  if ((stoplessMode !== 'on' && stoplessMode !== 'endless') || !isRecord(body)) {
    return null;
  }
  if (Object.prototype.hasOwnProperty.call(body, '__sse_responses')) {
    return null;
  }
  if (bodyContainsReasoningStopFinalizedMarker(body)) {
    return null;
  }
  if (hasAnthropicToolUseSuccess(body)) {
    return null;
  }
  const derivedFinishReason = deriveFinishReason(body)?.trim().toLowerCase() ?? '';

  const choices = Array.isArray(body.choices) ? body.choices : [];
  if (choices.length > 0) {
    const firstChoice = isRecord(choices[0]) ? choices[0] : undefined;
    if (!firstChoice) {
      return null;
    }
    const finishReason = readString(firstChoice.finish_reason)?.toLowerCase() ?? '';
    const message = isRecord(firstChoice.message) ? firstChoice.message : undefined;
    const hasToolCalls = hasNonEmptyToolCalls(message?.tool_calls);
    if (finishReason === 'stop' && !hasToolCalls) {
      return {
        reason: `stopless=${stoplessMode} but chat completion stopped without reasoning.stop finalized marker`,
        marker: 'chat_stopless_missing_reasoning_stop_finalization'
      };
    }
  }

  if (derivedFinishReason === 'stop') {
    return {
      reason: `stopless=${stoplessMode} but response resolved to finish_reason=stop without reasoning.stop finalized marker`,
      marker: 'derived_stopless_missing_reasoning_stop_finalization'
    };
  }

  const status = readString(body.status)?.toLowerCase() ?? '';
  if (status === 'completed' || status === 'stop') {
    const requiredAction = isRecord(body.required_action) ? body.required_action : undefined;
    const submitToolOutputs =
      requiredAction && isRecord(requiredAction.submit_tool_outputs)
        ? requiredAction.submit_tool_outputs
        : undefined;
    const hasRequiredActionToolCalls = hasNonEmptyToolCalls(submitToolOutputs?.tool_calls);
    const hasFunctionCalls = hasOutputFunctionCalls(body.output);
    if (!hasRequiredActionToolCalls && !hasFunctionCalls) {
      return {
        reason: `stopless=${stoplessMode} but responses output completed without reasoning.stop finalized marker`,
        marker: 'responses_stopless_missing_reasoning_stop_finalization'
      };
    }
  }

  return null;
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
