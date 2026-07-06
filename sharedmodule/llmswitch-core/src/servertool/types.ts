import type { AdapterContext } from '../conversion/hub/types/chat-envelope.js';
import type { JsonObject, JsonValue } from '../conversion/hub/types/json.js';

/**
 * ToolCall：对齐 OpenAI style 的工具调用表示。
 */
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

/**
 * ServerSideToolEngineOptions：ServerTool 引擎入参（ChatCompletion 视角）。
 */
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

/**
 * ServerSideToolEngineResult：ServerTool 引擎出参。
 */
export interface ServerSideToolEngineResult {
  mode: 'passthrough' | 'tool_flow';
  finalChatResponse: JsonObject;
  execution?: ServerToolExecution;
  metadataWritePlan?: JsonObject;
}

/**
 * ServerToolHandlerContext：单个工具 handler 的上下文入参。
 */
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

// 方便其它模块使用的公共别名
export type { JsonObject, JsonValue } from '../conversion/hub/types/json.js';
