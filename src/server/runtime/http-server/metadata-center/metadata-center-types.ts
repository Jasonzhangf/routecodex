export type MetadataCenterFamily =
  | 'request_truth'
  | 'continuation_context'
  | 'runtime_control'
  | 'provider_observation'
  | 'response_observation'
  | 'closeout_status'
  | 'debug_snapshot';

export type MetadataCenterStatus =
  | 'active'
  | 'consumed'
  | 'finalized'
  | 'released';

export type MetadataCenterWritePolicy =
  | 'write_once'
  | 'replaceable_by_owner_only'
  | 'append_only'
  | 'finalize_only';

export type MetadataCenterWriter = {
  module: string;
  symbol: string;
  stage: string;
};

export type MetadataCenterHistoryEntry = {
  value: unknown;
  module: string;
  symbol: string;
  stage: string;
  at: number;
  reason?: string;
};

export type MetadataCenterSlot<T = unknown> = {
  value: T;
  family: MetadataCenterFamily;
  writtenBy: MetadataCenterWriter;
  status: MetadataCenterStatus;
  writePolicy: MetadataCenterWritePolicy;
  version: number;
  history: MetadataCenterHistoryEntry[];
};

export type MetadataCenterRequestTruth = {
  requestId?: string;
  pipelineId?: string;
  entryEndpoint?: string;
  sessionId?: string;
  conversationId?: string;
  clientRequestId?: string;
  portScope?: string;
};

export type MetadataCenterContinuationContext = {
  responsesResume?: Record<string, unknown>;
  previousResponseId?: string;
  responseId?: string;
  toolOutputs?: unknown[];
  continuationOwner?: string;
  resumeFrom?: Record<string, unknown>;
  chainId?: string;
  stickyScope?: string;
};

export type MetadataCenterStoplessRuntimeControl = {
  flowId?: string;
  repeatCount?: number;
  maxRepeats?: number;
  triggerHint?: string;
  continuationPrompt?: string;
  schemaFeedback?: Record<string, unknown>;
  active?: boolean;
  updatedAt?: number;
};

export type MetadataCenterStopMessageCompareContext = {
  armed?: boolean;
  mode?: 'off' | 'on' | 'auto' | string;
  allowModeOnly?: boolean;
  textLength?: number;
  maxRepeats?: number;
  used?: number;
  remaining?: number;
  active?: boolean;
  stopEligible?: boolean;
  hasCapturedRequest?: boolean;
  compactionRequest?: boolean;
  hasSeed?: boolean;
  decision?: 'trigger' | 'skip' | string;
  reason?: string;
  stage?: string;
  bdWorkState?: string;
  observationHash?: string;
  observationStableCount?: number;
  toolSignatureHash?: string;
};

export type MetadataCenterRuntimeControl = {
  routeHint?: string;
  routeName?: string;
  routeId?: string;
  providerProtocol?: string;
  retryProviderKey?: string;
  preselectedRoute?: Record<string, unknown>;
  responsesContinuationSavedAtChatProcessExit?: boolean;
  stopless?: MetadataCenterStoplessRuntimeControl;
  stopMessageCompareContext?: MetadataCenterStopMessageCompareContext;
  stopMessageEnabled?: boolean;
  stopMessageExcludeDirect?: boolean;
  streamIntent?: string;
  clientAbort?: boolean;
};

export type MetadataCenterProviderObservation = {
  target?: Record<string, unknown>;
  providerKey?: string;
  assignedModelId?: string;
  modelId?: string;
  clientModelId?: string;
  compatibilityProfile?: string;
  responseSemantics?: Record<string, unknown>;
  finishReason?: string;
};

export type MetadataCenterResponseObservation = {
  responseId?: string;
  status?: string;
  finishReason?: string;
  protocolKind?: string;
};

export type MetadataCenterCloseoutStatus = {
  finalized?: boolean;
  released?: boolean;
  releasedAt?: number;
  releaseReason?: string;
  releasedByStage?: string;
};

export type MetadataCenterDebugSnapshot = {
  snapshotId?: string;
  bridgeHistory?: unknown[];
  traceMarkers?: unknown[];
  hubStageTop?: Array<{
    stage: string;
    totalMs: number;
    count?: number;
    avgMs?: number;
    maxMs?: number;
  }>;
};

export type MetadataCenterState = {
  requestTruth: Partial<Record<keyof MetadataCenterRequestTruth, MetadataCenterSlot>>;
  continuationContext: Partial<Record<keyof MetadataCenterContinuationContext, MetadataCenterSlot>>;
  runtimeControl: Partial<Record<keyof MetadataCenterRuntimeControl, MetadataCenterSlot>>;
  providerObservation: Partial<Record<keyof MetadataCenterProviderObservation, MetadataCenterSlot>>;
  responseObservation: Partial<Record<keyof MetadataCenterResponseObservation, MetadataCenterSlot>>;
  closeoutStatus: Partial<Record<keyof MetadataCenterCloseoutStatus, MetadataCenterSlot>>;
  debugSnapshot: Partial<Record<keyof MetadataCenterDebugSnapshot, MetadataCenterSlot>>;
};
