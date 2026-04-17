import { deriveFinishReason, STREAM_LOG_FINISH_REASON_KEY } from '../../../utils/finish-reason.js';

export const REASONING_STOP_FINALIZED_MARKER = '[app.finished:reasoning.stop]';
export const REASONING_STOP_FINALIZED_FLAG_KEY = '__routecodex_reasoning_stop_finalized';

export function bodyContainsReasoningStopFinalizedMarker(body: unknown): boolean {
  if (!body || typeof body !== 'object') {
    return false;
  }
  try {
    return JSON.stringify(body).includes(REASONING_STOP_FINALIZED_MARKER);
  } catch {
    return false;
  }
}

export function buildServerToolSseWrapperBody(args: {
  sseResponses: unknown;
  convertedBody?: unknown;
  usage?: unknown;
}): Record<string, unknown> {
  const wrapperBody: Record<string, unknown> = {
    __sse_responses: args.sseResponses
  };
  if (args.usage !== undefined) {
    wrapperBody.usage = args.usage;
  }
  const finishReason = deriveFinishReason(args.convertedBody);
  if (finishReason) {
    wrapperBody[STREAM_LOG_FINISH_REASON_KEY] = finishReason;
  }
  if (bodyContainsReasoningStopFinalizedMarker(args.convertedBody)) {
    wrapperBody[REASONING_STOP_FINALIZED_FLAG_KEY] = true;
  }
  return wrapperBody;
}
