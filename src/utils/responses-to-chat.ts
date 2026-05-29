/**
 * Normalize Responses API body to Chat Completions format.
 *
 * Responses API uses `input` (message items) and `instructions` (system prompt)
 * instead of `messages`. Chat completions API only understands `messages`.
 * Without conversion the upstream Chat API receives an empty `messages` array
 * with unrecognized Responses fields → HTTP 400.
 *
 * Shared between:
 *   - Vercel SDK transport  (VercelAiSdkOpenAiTransport)
 *   - Direct HTTP transport  (OpenAIChatProtocolClient)
 */
export function normalizeResponsesToChatBody(body: Record<string, unknown>): void {
  if (Array.isArray(body.messages) && body.messages.length > 0) return;

  const instructions = typeof body.instructions === 'string' && body.instructions.trim()
    ? body.instructions.trim()
    : '';
  const input = Array.isArray(body.input) ? body.input : [];

  if (input.length === 0 && !instructions) return;

  const messages: Record<string, unknown>[] = [];

  if (instructions) {
    messages.push({ role: 'system', content: instructions });
  }

  for (const item of input) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    const rowType = typeof row.type === 'string' ? row.type.trim().toLowerCase() : '';
    const role = typeof row.role === 'string' ? row.role.trim().toLowerCase() : '';

    const isChatRole = role === 'user' || role === 'assistant' || role === 'system';
    if (isChatRole || (rowType === 'message' && isChatRole)) {
      const msg: Record<string, unknown> = { role, content: row.content };
      if (Array.isArray(row.tool_calls)) msg.tool_calls = row.tool_calls;
      messages.push(msg);
    }
  }

  if (messages.length > 0) body.messages = messages;

  delete body.input;
  delete body.instructions;
  delete body.previous_response_id;
  delete body.include;
}
