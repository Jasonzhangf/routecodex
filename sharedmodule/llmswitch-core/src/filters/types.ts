// Filter architecture: types and contracts (V2)
// This module defines a minimal, composable filter pipeline for request/response shaping.

export type JsonObject = Record<string, unknown>;

export type FilterStage =
  | 'request_pre'        // Before field-mapping
  | 'request_map'        // Field mapping (shaping)
  | 'request_post'       // After mapping sanity/patch
  | 'request_finalize'   // After normalizeChatRequest (final request shaping)
  | 'response_pre'       // Before field-mapping
  | 'response_map'       // Field mapping (shaping)
  | 'response_post'      // After mapping sanity/patch
  | 'response_finalize'; // Final response shaping

export interface FilterContext {
  requestId?: string;
  model?: string;
  endpoint?: string;      // e.g. '/v1/chat/completions'
  // 协议/Provider类型（由宿主注入）：例如 'openai' | 'responses' | 'anthropic' | 'gemini'
  provider?: string;
  profile?: string;       // e.g. 'openai-openai'
  stage: FilterStage;
  stream?: boolean;
  // Optional per-request tool filtering hints
  toolFilterHints?: ToolFilterHints;
  // Optional diagnostics sink
  debug?: {
    emit?: (event: string, data: unknown) => void;
  };
}

export interface FilterResult<T = JsonObject> {
  ok: boolean;
  data: T;
  warnings?: string[];
  metrics?: Record<string, unknown>;
}

export interface Filter<T = JsonObject> {
  readonly name: string;
  readonly stage: FilterStage;
  apply(input: T, ctx: FilterContext): Promise<FilterResult<T>> | FilterResult<T>;
}

// Tool filtering hints & decisions (used by tool-filter hooks)

export type ToolFilterAction = 'allow' | 'block' | 'rewrite';

export interface ToolFilterDecision {
  name: string;
  action: ToolFilterAction;
  reason?: string;
  category?: string;
}

export interface ToolFilterHints {
  // Upstream requested tool decisions (host/virtual-router may fill)
  requestedDecisions?: ToolFilterDecision[];
  // Detected tool categories in current request
  categories?: {
    vision?: boolean;
    mcp?: boolean;
    webSearch?: boolean;
    codeExecution?: boolean;
    fileSearch?: boolean;
    dataAnalysis?: boolean;
  };
  // Category-level overrides for this request
  categoryOverrides?: {
    vision?: 'allow' | 'block' | 'require_content';
    mcp?: 'allow' | 'block';
  };
  // Final decisions recorded by core filters (for diagnostics)
  decided?: ToolFilterDecision[];
}

// Minimal field map (shaping) rule
export interface FieldMapRule {
  sourcePath: string;  // JSONPath-like (subset)
  targetPath: string;  // JSONPath-like (subset)
  type?: 'string' | 'number' | 'boolean' | 'object' | 'array';
  transform?: string;  // Named transform (implementation provided by engine)
}

export interface FieldMapConfig {
  request?: FieldMapRule[];
  response?: FieldMapRule[];
}

// Built-in filter configs
export interface WhitelistConfig { allow: string[] }
export interface BlacklistConfig { deny: string[] }
export interface AddFieldsConfig { fields: Record<string, unknown> }
