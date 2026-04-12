import type { AdapterContext } from '../conversion/hub/types/chat-envelope.js';
import type { JsonObject, JsonValue } from '../conversion/hub/types/json.js';

/**
 * ProviderInvoker 由 Host 注入，用于在 llmswitch-core 内部发起二次 provider 请求。
 * 该接口对 ServerTool 框架是抽象的，不关心 HTTP 细节。
 */
export type ProviderInvoker = (options: {
  providerKey: string;
  providerType?: string;
  modelId?: string;
  providerProtocol: string;
  payload: JsonObject;
  entryEndpoint: string;
  requestId: string;
  /**
   * 可选的路由提示，用于在 Host 侧强制通过虚拟路由命中特定 route
   *（例如 web_search），保持所有二次请求仍然走标准 HubPipeline。
   */
  routeHint?: string;
}) => Promise<{
  providerResponse: JsonObject;
}>;

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
  includeAutoHookIds?: string[];
  excludeAutoHookIds?: string[];
  includeToolCallHandlerNames?: string[];
  excludeToolCallHandlerNames?: string[];
  providerInvoker?: ProviderInvoker;
  reenterPipeline?: (options: {
    entryEndpoint: string;
    requestId: string;
    body: JsonObject;
    metadata?: JsonObject;
  }) => Promise<{
    body?: JsonObject;
    __sse_responses?: unknown;
    format?: string;
  }>;
  clientInjectDispatch?: (options: {
    entryEndpoint: string;
    requestId: string;
    body?: JsonObject;
    metadata?: JsonObject;
  }) => Promise<{
    ok: boolean;
    reason?: string;
  }>;
  onAutoHookTrace?: (event: ServerToolAutoHookTraceEvent) => void;
}

export type ServerToolFollowupInjectionOp =
  | { op: 'preserve_tools' }
  | { op: 'ensure_standard_tools' }
  | { op: 'append_assistant_message'; required?: boolean }
  | { op: 'append_tool_messages_from_tool_outputs'; required?: boolean }
  | { op: 'inject_system_text'; text: string }
  | { op: 'append_user_text'; text: string }
  | { op: 'drop_tool_by_name'; name: string }
  | { op: 'inject_vision_summary'; summary: string }
  | { op: 'trim_openai_messages'; maxNonSystemMessages: number }
  | { op: 'append_tool_if_missing'; toolName: string; toolDefinition: JsonObject }
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
  | { kind: 'vision_analysis'; response: { body?: JsonObject; __sse_responses?: unknown; format?: string } }
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
  /**
   * Optional tool-specific context for the execution result.
   * For example, web_search handler may attach { web_search: { engineId, providerKey, summary } }
   * so that orchestration layer can decorate final Chat response without touching host code.
   */
  context?: JsonObject;
}

/**
 * ServerSideToolEngineResult：ServerTool 引擎出参。
 */
export interface ServerSideToolEngineResult {
  mode: 'passthrough' | 'tool_flow';
  finalChatResponse: JsonObject;
  execution?: ServerToolExecution;
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
  capabilities: {
    reenterPipeline: boolean;
    providerInvoker: boolean;
  };
}

export interface ServerToolHandlerResult {
  chatResponse: JsonObject;
  execution: ServerToolExecution;
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
