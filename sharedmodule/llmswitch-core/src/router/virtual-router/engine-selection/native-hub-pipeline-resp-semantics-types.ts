export interface NativeRespInboundReasoningNormalizeInput {
  payload: Record<string, unknown>;
  protocol: string;
}

export interface AnthropicStopReasonResolution {
  normalized: string;
  finishReason: string;
  isContextOverflow: boolean;
}

export interface AnthropicChatCompletionOutcome extends AnthropicStopReasonResolution {
  shouldFailEmptyContextOverflow: boolean;
}

export interface ProviderResponseToolCallSummary {
  toolCallCount?: number;
  toolNames?: string[];
}

export interface ProviderResponseContextHelpersOutput {
  isServerToolFollowup: boolean;
  toolSurfaceShadowEnabled: boolean;
  clientProtocol: 'openai-chat' | 'openai-responses' | 'anthropic-messages';
  displayModel?: string;
  clientFacingRequestId?: string;
}

export interface ClockReservationFromContextOutput {
  reservationId: string;
  sessionId: string;
  taskIds: string[];
  reservedAtMs: number;
}

export interface ContextLengthDiagnosticsOutput {
  estimatedPromptTokens?: number;
  maxContextTokens?: number;
}

export interface RespInboundSseErrorDescriptor {
  code: 'SSE_DECODE_ERROR' | 'HTTP_502';
  protocol: string;
  providerType?: string;
  errorMessage: string;
  details: Record<string, unknown>;
  stageRecord: Record<string, unknown>;
  status?: number;
}

export interface ResponsesHostPolicyResult {
  shouldStripHostManagedFields: boolean;
  targetProtocol: string;
}
