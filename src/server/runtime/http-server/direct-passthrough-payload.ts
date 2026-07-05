// feature_id: responses.direct_tool_shape_contract

export function requireDirectPassthroughPayloadObject(
  body: unknown,
): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('provider-runtime-error: direct passthrough payload must be an object');
  }
  return body as Record<string, unknown>;
}
