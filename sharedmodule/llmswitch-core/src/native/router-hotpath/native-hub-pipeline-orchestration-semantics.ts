export interface NativeHubPipelineOrchestrationInput {
  requestId: string;
  endpoint: string;
  entryEndpoint: string;
  providerProtocol: string;
  payload: Record<string, unknown>;
  metadata: Record<string, unknown>;
  stream: boolean;
  processMode: 'chat';
  direction: 'request' | 'response';
  stage: 'inbound' | 'outbound';
}

export interface NativeHubPipelineOrchestrationOutput {
  requestId: string;
  success: boolean;
  payload?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  standardizedRequest?: Record<string, unknown>;
  entryOriginRequest?: Record<string, unknown>;
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export interface NativeStopMessageRouterMetadataOutput {
  stopMessageClientInjectSessionScope?: string;
  stopMessageClientInjectScope?: string;
  clientTmuxSessionId?: string;
  client_tmux_session_id?: string;
  tmuxSessionId?: string;
  tmux_session_id?: string;
}

export interface NativeRouterMetadataInputBuildInput {
  requestId: string;
  entryEndpoint: string;
  processMode: 'chat';
  stream: boolean;
  direction: 'request' | 'response';
  providerProtocol: string;
  routeHint?: string;
  stage?: 'inbound' | 'outbound';
  responsesResume?: unknown;
  requestSemantics?: unknown;
  includeEstimatedInputTokens?: boolean;
  serverToolRequired?: boolean;
  sessionId?: string;
  conversationId?: string;
  metadata?: Record<string, unknown>;
}

export interface NativeCoerceStandardizedRequestInput {
  payload: Record<string, unknown>;
  normalized: {
    id: string;
    entryEndpoint: string;
    stream: boolean;
    processMode: 'chat';
    routeHint?: string;
  };
}

export interface NativeCoerceStandardizedRequestOutput {
  standardizedRequest: Record<string, unknown>;
  rawPayload: Record<string, unknown>;
}

export {
  extractModelHintFromMetadataWithNative,
  normalizeHubEndpointWithNative,
  resolveSseProtocolWithNative,
  planProviderResponseServertoolRuntimeActionsWithNative,
  runHubPipelineOrchestrationWithNative
} from './native-hub-pipeline-orchestration-semantics-protocol.js';

export {
  resolveStopMessageRouterMetadataWithNative
} from './native-hub-pipeline-orchestration-semantics-metadata-policy.js';

export {
  buildRouterMetadataInputWithNative,
  coerceStandardizedRequestFromPayloadWithNative
} from './native-hub-pipeline-orchestration-semantics-builders.js';
