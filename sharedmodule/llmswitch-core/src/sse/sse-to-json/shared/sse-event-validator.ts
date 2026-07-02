/**
 * SSE event type validation.
 * Protocol-specific allowed event types moved here from transport parser.
 */
// feature_id: sse.event_type_validation

export const RESPONSES_SSE_EVENT_TYPES: readonly string[] = [
  'chunk', 'done', 'error', 'heartbeat', 'message',
  'response.created', 'response.in_progress', 'response.failed', 'response.incomplete',
  'response.output_item.added', 'response.content_part.added',
  'response.output_text.delta', 'response.output_text.done',
  'response.reasoning_text.delta', 'response.reasoning_text.done',
  'response.reasoning_signature.delta', 'response.reasoning_image.delta',
  'response.reasoning_summary_part.added', 'response.reasoning_summary_part.done',
  'response.reasoning_summary_text.delta', 'response.reasoning_summary_text.done',
  'response.content_part.done', 'response.output_item.done',
  'response.function_call_arguments.delta', 'response.function_call_arguments.done',
  'response.required_action', 'response.completed', 'response.done',
  'response.error', 'response.cancelled',
  'response.start', 'output_item.start', 'content_part.start',
  'content_part.delta', 'function_call.start', 'function_call.delta',
  'function_call.done', 'reasoning.start', 'reasoning.delta', 'reasoning.done',
  'required_action',
];

export const ANTHROPIC_SSE_EVENT_TYPES: readonly string[] = [
  'message_start', 'content_block_start', 'content_block_delta',
  'content_block_stop', 'message_delta', 'message_stop',
];

export const GEMINI_SSE_EVENT_TYPES: readonly string[] = [
  'gemini.data', 'gemini.done',
];

export const CHAT_SSE_EVENT_TYPES: readonly string[] = [
  'chunk', 'done', 'error', 'heartbeat', 'message',
];

export function isAllowedEventType(
  eventType: string,
  allowed: readonly string[],
  enableStrictValidation: boolean
): boolean {
  if (!enableStrictValidation) {
    return true;
  }
  return allowed.includes(eventType);
}
