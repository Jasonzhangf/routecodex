import { convertResponsesRequestToChatNative } from '../modules/llmswitch/bridge/responses-to-chat-host.js';

export function normalizeResponsesToChatBody(body: Record<string, unknown>): void {
  const hasInput = Array.isArray(body.input);
  const hasMessages = Array.isArray(body.messages) && body.messages.length > 0;
  const rawInstructions =
    typeof body.instructions === 'string' && body.instructions.trim().length > 0
      ? body.instructions.trim()
      : undefined;

  if (!hasInput && !rawInstructions) {
    return;
  }

  if (!hasInput && hasMessages) {
    if (rawInstructions) {
      const messages = body.messages as Array<Record<string, unknown>>;
      const hasSystemInstruction = messages.some(
        (message) => message && typeof message === 'object' && String((message as Record<string, unknown>).role).toLowerCase() === 'system'
      );
      if (!hasSystemInstruction) {
        body.messages = [
          { role: 'system', content: rawInstructions },
          ...messages
        ];
      }
    }
    delete body.instructions;
    delete body.previous_response_id;
    delete body.include;
    return;
  }

  const native = convertResponsesRequestToChatNative(body, {
    requestId: typeof body.id === 'string' ? body.id : undefined
  });
  const request = native.request && typeof native.request === 'object' && !Array.isArray(native.request)
    ? (native.request as Record<string, unknown>)
    : {};
  let messages = Array.isArray(request.messages) ? request.messages : undefined;
  if (messages && rawInstructions) {
    const hasSystemInstruction = messages.some(
      (message) => message && typeof message === 'object' && String((message as Record<string, unknown>).role).toLowerCase() === 'system'
    );
    if (!hasSystemInstruction) {
      messages = [
        { role: 'system', content: rawInstructions },
        ...messages
      ];
    }
  }
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
