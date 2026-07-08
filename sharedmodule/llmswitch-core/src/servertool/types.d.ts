export type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;

export interface JsonObject {
  [key: string]: JsonValue | undefined;
}

export interface AdapterContext {
  requestId: string;
  entryEndpoint: string;
  providerProtocol: string;
  providerId?: string;
  providerKey?: string;
  targetProviderKey?: string;
  routeId?: string;
  profileId?: string;
  streamingHint?: 'auto' | 'force' | 'disable';
  originalModelId?: string;
  clientModelId?: string;
  toolCallIdStyle?: 'fc' | 'preserve';
  responsesResume?: JsonObject;
  [key: string]: unknown;
}

export interface StageRecorder {
  record(stage: string, payload: object): void;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface ServerToolAutoHookTraceEvent {
  hookId: string;
  phase: string;
  priority: number;
  queue: 'A_optional' | 'B_mandatory';
  queueIndex: number;
  queueTotal: number;
  result: 'miss' | 'match' | 'error';
  reason: string;
  flowId?: string;
}

export interface ServerSideToolEngineOptions {
  chatResponse: JsonObject;
  adapterContext: AdapterContext;
  entryEndpoint: string;
  requestId: string;
  disableToolCallHandlers?: boolean;
  primaryAutoHookAttempt?: boolean;
  includeAutoHookIds?: string[];
  excludeAutoHookIds?: string[];
  includeToolCallHandlerNames?: string[];
  excludeToolCallHandlerNames?: string[];
  onAutoHookTrace?: (event: ServerToolAutoHookTraceEvent) => void;
}

export interface ServerToolHandlerPlan {
  flowId: string;
  finalize: () => Promise<ServerToolHandlerResult | null>;
}

export interface ServerToolExecution {
  flowId: string;
  stopMessageReservation?: {
    stickyKey: string;
    previousState: Record<string, unknown> | null;
  };
}

export interface ServerToolHandlerEntry {
  name: string;
  trigger: 'tool_call' | 'auto';
  execution: {
    kind: 'builtin';
    builtinName: string;
  };
  registration: import('../native/router-hotpath/native-followup-mainline-semantics.js').ServerToolHandlerRegistrationSpec;
  autoHook?: {
    id: string;
    phase: 'pre' | 'default' | 'post';
    priority: number;
    order: number;
  };
}

export interface ServerToolAutoHookDescriptor {
  id: string;
  phase: 'pre' | 'default' | 'post';
  priority: number;
  order: number;
  registration: import('../native/router-hotpath/native-followup-mainline-semantics.js').ServerToolHandlerRegistrationSpec;
  execution: {
    kind: 'builtin';
    builtinName: string;
  };
}

export interface ServerSideToolEngineResult {
  mode: 'passthrough' | 'tool_flow';
  finalChatResponse: JsonObject;
  execution?: ServerToolExecution;
  metadataWritePlan?: JsonObject;
}

export interface ServerToolHandlerContext {
  base: JsonObject;
  toolCall?: ToolCall;
  toolCalls: ToolCall[];
  adapterContext: AdapterContext;
  requestId: string;
  entryEndpoint: string;
  runtimeMetadata?: JsonObject;
}

export interface ServerToolHandlerResult {
  chatResponse: JsonObject;
  execution: ServerToolExecution;
  metadataWritePlan?: JsonObject;
}
