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
  providerProtocol: string;
  disableToolCallHandlers?: boolean;
  primaryAutoHookAttempt?: boolean;
  includeAutoHookIds?: string[];
  excludeAutoHookIds?: string[];
  includeToolCallHandlerNames?: string[];
  excludeToolCallHandlerNames?: string[];
  onAutoHookTrace?: (event: ServerToolAutoHookTraceEvent) => void;
}

export type ServerToolFollowupInjectionOp =
  | { op: 'append_assistant_message'; required?: boolean }
  | { op: 'append_tool_messages_from_tool_outputs'; required?: boolean }
  | { op: 'inject_system_text'; text: string }
  | { op: 'append_user_text'; text: string }
  | { op: 'inject_vision_summary'; summary: string }
  | { op: 'rebuild_vision_followup'; summary: string; originalPrompt?: string }
  | { op: 'trim_openai_messages'; maxNonSystemMessages: number }
  | { op: 'compact_tool_content'; maxChars: number };

export type ServerToolFollowupInjectionPlan = {
  ops: ServerToolFollowupInjectionOp[];
};

export type ServerToolFollowupPlan =
  | {
    requestIdSuffix: string;
    payload: JsonObject;
    metadata?: JsonObject;
    entryEndpoint?: string;
  }
  | {
    requestIdSuffix: string;
    injection: ServerToolFollowupInjectionPlan;
    metadata?: JsonObject;
    entryEndpoint?: string;
  }
  | {
    requestIdSuffix: string;
    metadata?: JsonObject;
  };

export type ServerToolBackendPlan =
  | {
    kind: 'vision_analysis';
    requestIdSuffix: string;
    entryEndpoint: string;
    payload: JsonObject;
  }
  | {
    kind: 'web_search';
    requestIdSuffix: string;
    query: string;
    recency?: string;
    resultCount: number;
    engines: {
      id: string;
      providerKey: string;
      description?: string;
      default?: boolean;
      executionMode?: 'servertool' | 'direct';
      directActivation?: 'route' | 'builtin';
      modelId?: string;
      maxUses?: number;
      serverToolsDisabled?: boolean;
      searchEngineList?: string[];
    }[];
  };

export type ServerToolBackendResult =
  | { kind: 'vision_analysis'; response: { body?: JsonObject; sseStream?: unknown; format?: string } }
  | {
    kind: 'web_search';
    chosenEngine?: { id: string; providerKey: string };
    result: {
      ok: boolean;
      summary: string;
      hits: {
        title?: string;
        link: string;
        media?: string;
        publish_date?: string;
        content?: string;
        refer?: string;
      }[];
    };
  };

export interface ServerToolHandlerPlan {
  flowId: string;
  backend?: ServerToolBackendPlan;
  finalize: (args: { backendResult?: ServerToolBackendResult }) => Promise<ServerToolHandlerResult | null>;
}

export interface ServerToolExecution {
  flowId: string;
  followup?: ServerToolFollowupPlan;
  stopMessageReservation?: {
    stickyKey: string;
    previousState: Record<string, unknown> | null;
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
  /**
   * When present, indicates a "mixed tools" flow:
   * - servertools were executed and their tool results are persisted
   * - remaining (non-servertool) tool_calls must be returned to client
   * - on next request, servertool results will be injected after client tool results
   */
  pendingInjection?: {
    sessionId: string;
    aliasSessionIds?: string[];
    afterToolCallIds: string[];
    messages: JsonObject[];
  };
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
  providerProtocol: string;
  runtimeMetadata?: JsonObject;
}

export interface ServerToolHandlerResult {
  chatResponse: JsonObject;
  execution: ServerToolExecution;
  metadataWritePlan?: JsonObject;
}

/**
 * ServerToolHandler：统一的 ServerTool handler 接口。
 * 后续 web_search / vision / 其它工具都会以 handler 形式挂载到注册表。
 */
export type ServerToolHandler = (
  ctx: ServerToolHandlerContext
) => Promise<ServerToolHandlerPlan | null>;

// 方便其它模块使用的公共别名
export type { JsonObject, JsonValue } from '../conversion/hub/types/json.js';
