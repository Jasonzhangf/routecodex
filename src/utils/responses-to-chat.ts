import { convertResponsesRequestToChatNative } from '../modules/llmswitch/bridge.js';

export function normalizeResponsesToChatBody(body: Record<string, unknown>): void {
  if (!Array.isArray(body.input) && typeof body.instructions !== 'string') {
    return;
  }

  const native = convertResponsesRequestToChatNative(body, {
    requestId: typeof body.id === 'string' ? body.id : undefined
  });
  const request = native.request && typeof native.request === 'object' && !Array.isArray(native.request)
    ? (native.request as Record<string, unknown>)
    : {};
  const messages = Array.isArray(request.messages) ? request.messages : undefined;
  if (messages && messages.length > 0) {
    body.messages = messages;
  }
  for (const key of [
    'tools',
    'tool_choice',
    'parallel_tool_calls',
    'user',
    'logit_bias',
    'seed',
    'response_format',
    'max_output_tokens',
    'max_tokens'
  ]) {
    if (Object.prototype.hasOwnProperty.call(request, key)) {
      body[key] = request[key];
    }
  }

  delete body.input;
  delete body.instructions;
  delete body.previous_response_id;
  delete body.include;
}
