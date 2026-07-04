// feature_id: responses.direct_tool_shape_contract

export function requireDirectPassthroughPayloadObject(
  body: unknown,
): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('provider-runtime-error: direct passthrough payload must be an object');
  }
  return body as Record<string, unknown>;
}

export function findResponsesDirectFunctionCallOutputContentViolation(
  payload: Record<string, unknown>,
): string | undefined {
  const input = Array.isArray(payload.input) ? payload.input : undefined;
  if (!input) {
    return undefined;
  }
  for (let index = 0; index < input.length; index += 1) {
    const item = input[index];
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      continue;
    }
    const row = item as Record<string, unknown>;
    if (row.type === 'function_call_output' && Object.prototype.hasOwnProperty.call(row, 'content')) {
      return `openai-responses provider wire input[${index}] function_call_output must not include content; use output only`;
    }
  }
  return undefined;
}
