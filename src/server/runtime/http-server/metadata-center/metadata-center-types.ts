export type MetadataCenterFamily =
  | 'request_truth'
  | 'continuation_context'
  | 'runtime_control'
  | 'provider_observation'
  | 'client_attachment_scope'
  | 'debug_snapshot';

export type MetadataCenterStatus =
  | 'active'
  | 'consumed'
  | 'finalized'
  | 'released';

export type MetadataCenterWritePolicy =
  | 'write_once'
  | 'replaceable'
  | 'append_only';

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
  responsesRequestContext?: Record<string, unknown>;
  responsesResume?: Record<string, unknown>;
  previousResponseId?: string;
  responseId?: string;
  toolOutputs?: unknown[];
  continuationOwner?: string;
  resumeFrom?: Record<string, unknown>;
  chainId?: string;
  stickyScope?: string;
};

export type MetadataCenterState = {
  requestTruth: Partial<Record<keyof MetadataCenterRequestTruth, MetadataCenterSlot>>;
  continuationContext: Partial<Record<keyof MetadataCenterContinuationContext, MetadataCenterSlot>>;
};
