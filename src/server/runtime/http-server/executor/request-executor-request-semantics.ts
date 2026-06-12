import { importCoreDist } from '../../../../modules/llmswitch/bridge/module-loader.js';

type NativeChatProcessNodeResultSemanticsModule = {
  hasRequestedToolsInSemanticsWithNative?: (requestSemantics?: Record<string, unknown>) => boolean;
  isRequiredToolCallTurnWithNative?: (requestSemantics?: Record<string, unknown>) => boolean;
  isToolResultFollowupTurnWithNative?: (requestSemantics?: Record<string, unknown>) => boolean;
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

export async function hasRequestedToolsInSemantics(requestSemantics?: Record<string, unknown>): Promise<boolean> {
  const fn = (await getNativeSemantics()).hasRequestedToolsInSemanticsWithNative;
  if (typeof fn !== 'function') throw new Error('[request-semantics] hasRequestedToolsInSemanticsWithNative unavailable');
  return fn(requestSemantics);
}

export async function isRequiredToolCallTurn(requestSemantics?: Record<string, unknown>): Promise<boolean> {
  const fn = (await getNativeSemantics()).isRequiredToolCallTurnWithNative;
  if (typeof fn !== 'function') throw new Error('[request-semantics] isRequiredToolCallTurnWithNative unavailable');
  return fn(requestSemantics);
}

export async function isToolResultFollowupTurn(requestSemantics?: Record<string, unknown>): Promise<boolean> {
  const fn = (await getNativeSemantics()).isToolResultFollowupTurnWithNative;
  if (typeof fn !== 'function') throw new Error('[request-semantics] isToolResultFollowupTurnWithNative unavailable');
  return fn(requestSemantics);
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function isProviderNativeResumeContinuation(requestSemantics?: Record<string, unknown>): boolean {
  const continuation = readRecord(requestSemantics?.continuation);
  if (!continuation) {
    return false;
  }
  const resumeFrom = readRecord(continuation.resumeFrom ?? continuation.resume_from);
  if (
    readNonEmptyString(resumeFrom?.previousResponseId)
    || readNonEmptyString(resumeFrom?.previous_response_id)
    || readNonEmptyString(continuation.previousResponseId)
    || readNonEmptyString(continuation.previous_response_id)
  ) {
    return true;
  }
  const mode = readNonEmptyString(continuation.mode);
  return mode === 'submit_tool_outputs' && Boolean(
    readNonEmptyString(continuation.responseId)
    || readNonEmptyString(continuation.response_id)
  );
}
