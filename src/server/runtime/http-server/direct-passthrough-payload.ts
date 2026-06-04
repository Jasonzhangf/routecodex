function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function cloneRecord<T extends Record<string, unknown>>(value: T): T {
  return structuredClone(value);
}

function cloneWirePayload(value: Record<string, unknown>): Record<string, unknown> {
  if (Object.prototype.hasOwnProperty.call(value, 'metadata')) {
    throw new Error('provider-runtime-error: metadata is not allowed in direct passthrough provider body');
  }
  const next = cloneRecord(value);
  return next;
}

function makeDirectPayloadContractError(message: string, details?: Record<string, unknown>): Error {
  const error = new Error(message) as Error & { code?: string; status?: number; statusCode?: number; details?: unknown };
  error.code = 'DIRECT_PAYLOAD_CONTRACT_ERROR';
  error.status = 400;
  error.statusCode = 400;
  if (details) {
    error.details = details;
  }
  return error;
}

function validateOpenAIResponsesDirectTools(payload: Record<string, unknown>): void {
  if (Array.isArray(payload.messages)) {
    throw makeDirectPayloadContractError('Invalid direct Responses payload: chat-style messages are not provider wire', {
      reason: 'chat_messages',
    });
  }
  if (!Array.isArray(payload.tools)) {
    return;
  }
  payload.tools.forEach((tool, index) => {
    if (!isRecord(tool)) {
      throw makeDirectPayloadContractError(`Invalid direct Responses tool at tools[${index}]`, { index, reason: 'not_object' });
    }
    const type = typeof tool.type === 'string' ? tool.type.trim() : '';
    if (type === 'function') {
      const name = typeof tool.name === 'string' ? tool.name.trim() : '';
      if (!name) {
        throw makeDirectPayloadContractError(`Invalid direct Responses function tool at tools[${index}]: missing name`, { index, reason: 'missing_name' });
      }
      return;
    }
    if (!type) {
      throw makeDirectPayloadContractError(`Invalid direct Responses tool at tools[${index}]: missing type`, { index, reason: 'missing_type' });
    }
  });
}

export function assertDirectPayloadContract(args: {
  payload: Record<string, unknown>;
  inboundProtocol: string;
}): void {
  const result = checkDirectPayloadContract(args);
  if (!result.ok) {
    throw makeDirectPayloadContractError(result.message, { reason: result.reason });
  }
}

export function checkDirectPayloadContract(args: {
  payload: Record<string, unknown>;
  inboundProtocol: string;
}): { ok: true } | { ok: false; reason: string; message: string } {
  try {
    if (args.inboundProtocol === 'openai-responses') {
      validateOpenAIResponsesDirectTools(args.payload);
    }
    return { ok: true };
  } catch (error) {
    const reason = error && typeof error === 'object' && typeof (error as { details?: { reason?: unknown } }).details?.reason === 'string'
      ? (error as { details: { reason: string } }).details.reason
      : 'invalid_direct_payload';
    const message = error instanceof Error ? error.message : String(error ?? 'invalid direct payload');
    return { ok: false, reason, message };
  }
}

export function resolveRawPayloadForDirect(
  body: unknown,
  metadata?: Record<string, unknown>,
): Record<string, unknown> {
  const raw = metadata?.__raw_request_body;
  if (isRecord(raw)) {
    const next = cloneWirePayload(raw);
    if ((isRecord(body) && body.stream === true || metadata?.stream === true || metadata?.outboundStream === true) && next.stream !== true) {
      next.stream = true;
    }
    return next;
  }
  if (isRecord(body)) {
    return cloneWirePayload(body);
  }
  return {};
}

export function applyMinimalDirectOverrides(
  payload: Record<string, unknown>,
  options?: {
    routeParams?: Record<string, unknown>;
  }
): Record<string, unknown> {
  const next = cloneRecord(payload);
  const routeModel = typeof options?.routeParams?.model === 'string' ? options.routeParams.model.trim() : '';
  if (routeModel) {
    next.model = routeModel;
  }
  return next;
}
