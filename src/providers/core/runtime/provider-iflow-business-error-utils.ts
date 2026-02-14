type IflowBusinessErrorEnvelope = {
  code?: string;
  message: string;
};

export function readIflowBusinessErrorEnvelope(data: unknown): IflowBusinessErrorEnvelope | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return null;
  }
  const record = data as Record<string, unknown>;
  const codeRaw = record.error_code ?? record.errorCode ?? record.code;
  const messageRaw =
    (typeof record.msg === 'string' && record.msg.trim().length
      ? record.msg
      : typeof record.message === 'string' && record.message.trim().length
        ? record.message
        : typeof record.error_message === 'string' && record.error_message.trim().length
          ? record.error_message
          : '') || '';

  const code =
    typeof codeRaw === 'string' && codeRaw.trim().length
      ? codeRaw.trim()
      : typeof codeRaw === 'number' && Number.isFinite(codeRaw)
        ? String(codeRaw)
        : '';

  const hasCode = code.length > 0 && code !== '0';
  const hasMessage = messageRaw.trim().length > 0;
  if (!hasCode && !hasMessage) {
    return null;
  }

  return {
    ...(hasCode ? { code } : {}),
    message: hasMessage ? messageRaw.trim() : 'iFlow upstream business error'
  };
}

export function buildIflowBusinessEnvelopeError(
  envelope: IflowBusinessErrorEnvelope,
  data: Record<string, unknown>
): Error & {
  statusCode: number;
  status: number;
  code: string;
  response: { status: number; data: Record<string, unknown> };
} {
  const upstreamCode = envelope.code && envelope.code.trim().length ? envelope.code.trim() : 'iflow_business_error';
  const upstreamMessage = envelope.message;
  const errorMessage =
    'HTTP 400: iFlow business error (' + upstreamCode + ')' + (upstreamMessage ? ': ' + upstreamMessage : '');
  const error = new Error(errorMessage) as Error & {
    statusCode: number;
    status: number;
    code: string;
    response: { status: number; data: Record<string, unknown> };
  };

  error.statusCode = 400;
  error.status = 400;
  error.code = 'HTTP_400';
  error.response = {
    status: 400,
    data: {
      error: {
        code: upstreamCode,
        message: upstreamMessage
      },
      upstream: data
    }
  };
  return error;
}
