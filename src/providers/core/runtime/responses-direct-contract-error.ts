export type ResponsesDirectContractDecision = {
  providerWireValid: boolean;
  reason?: string;
};

export function buildDirectPayloadContractError(
  message: string,
  details?: Record<string, unknown>,
): Error {
  const error = new Error(message) as Error & {
    code?: string;
    status?: number;
    statusCode?: number;
    details?: unknown;
  };
  error.code = 'DIRECT_PAYLOAD_CONTRACT_ERROR';
  error.status = 400;
  error.statusCode = 400;
  if (details) {
    error.details = details;
  }
  return error;
}

export function annotateAsHostPayloadContractError(error: unknown): Error {
  const contractError = error instanceof Error ? error : new Error(String(error ?? 'invalid direct payload'));
  const record = contractError as Error & {
    code?: string;
    status?: number;
    statusCode?: number;
    retryable?: boolean;
    details?: unknown;
    requestExecutorProviderErrorStage?: unknown;
  };
  record.code = typeof record.code === 'string' && record.code.trim() ? record.code : 'DIRECT_PAYLOAD_CONTRACT_ERROR';
  record.status = typeof record.status === 'number' ? record.status : 400;
  record.statusCode = typeof record.statusCode === 'number' ? record.statusCode : 400;
  record.retryable = false;
  record.requestExecutorProviderErrorStage = 'host.response_contract';
  const currentDetails =
    record.details && typeof record.details === 'object' && !Array.isArray(record.details)
      ? (record.details as Record<string, unknown>)
      : {};
  record.details = {
    ...currentDetails,
    requestExecutorProviderErrorStage: 'host.response_contract',
    source: 'host.response_contract',
  };
  return contractError;
}

export function projectResponsesDirectContractDecision(
  decision: ResponsesDirectContractDecision,
): void {
  if (decision.providerWireValid) {
    return;
  }
  throw buildDirectPayloadContractError(
    decision.reason ?? 'invalid direct payload',
    { reason: decision.reason ?? 'invalid_direct_payload' },
  );
}

export function assertNativeResponsesDirectContractAvailable(nativeResult: { ok: true } | null): void {
  if (!nativeResult?.ok) {
    throw new Error('provider-runtime-error: native responses direct tool-shape validator unavailable');
  }
}
