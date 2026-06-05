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
