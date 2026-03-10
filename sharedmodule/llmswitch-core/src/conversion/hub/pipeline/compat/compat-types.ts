import type { JsonObject, JsonValue } from '../../types/json.js';
import type { NativeProviderProtocolToken } from '../../../../router/virtual-router/engine-selection/native-hub-pipeline-req-inbound-semantics.js';

type ShapeFilterConfig = Record<string, unknown>;
type ResponseBlacklistConfig = Record<string, unknown>;
type FieldMapping = Record<string, unknown>;
type RequestRulesConfig = Record<string, unknown>;
type AutoThinkingConfig = Record<string, unknown>;
type ResponseNormalizeConfig = Record<string, unknown>;
type ResponseValidateConfig = Record<string, unknown>;
type HarvestToolCallsFromTextConfig = Record<string, unknown>;
type ToolTextRequestGuidanceConfig = Record<string, unknown>;
type DeepSeekWebResponseConfig = Record<string, unknown>;

export type CompatDirection = 'request' | 'response';
export type CompatNativeProtocolToken = NativeProviderProtocolToken;

export interface CompatProfileConfig {
  id: string;
  protocol: CompatNativeProtocolToken;
  direction?: CompatDirection;
  mappings?: MappingInstruction[];
  filters?: FilterInstruction[];
  request?: CompatStageConfig;
  response?: CompatStageConfig;
}

export interface CompatStageConfig {
  mappings?: MappingInstruction[];
  filters?: FilterInstruction[];
}

export type MappingInstruction =
  | {
      action: 'remove';
      path: string;
    }
  | {
      action: 'shallow_pick';
      allowTopLevel: string[];
    }
  | {
      action: 'rename';
      from: string;
      to: string;
    }
  | {
      action: 'set';
      path: string;
      value: JsonValue;
    }
  | {
      action: 'stringify';
      path: string;
      fallback?: JsonValue;
    }
  | {
      action: 'set_default';
      path: string;
      value?: JsonValue;
      valueSource?: 'timestamp_seconds' | 'chat_completion_id';
    }
  | {
      action: 'normalize_tool_choice';
      path?: string;
      objectReplacement?: string;
    }
  | { action: 'normalize_tool_call_ids' }
  | { action: 'lmstudio_responses_fc_ids' }
  | { action: 'lmstudio_responses_input_stringify' }
  | { action: 'iflow_kimi_history_media_placeholder' }
  | { action: 'iflow_kimi_cli_defaults' }
  | { action: 'iflow_kimi_thinking_reasoning_fill' }
  | {
      action: 'inject_instruction';
      sourcePath: string;
      targetPath?: string;
      role?: string;
      contentType?: string;
      stripHtml?: boolean;
      maxLengthEnv?: string[];
    }
  | {
      action: 'parse_json';
      path: string;
      fallback?: JsonValue;
    }
  | {
      action: 'convert_responses_output_to_choices';
    }
  | {
      action: 'extract_glm_tool_markup';
    }
  | {
      action: 'harvest_tool_calls_from_text';
      config?: HarvestToolCallsFromTextConfig;
    }
  | {
      action: 'tool_text_request_guidance';
      config?: ToolTextRequestGuidanceConfig;
    }
  | { action: 'strip_orphan_function_calls_tag' }
  | { action: 'dto_unwrap' }
  | { action: 'dto_rewrap' }
  | {
      action: 'shape_filter';
      config: ShapeFilterConfig;
      target?: CompatDirection;
    }
  | {
      action: 'field_map';
      direction?: 'incoming' | 'outgoing';
      config: FieldMapping[];
    }
  | {
      action: 'tool_schema_sanitize';
      mode?: 'glm_shell';
    }
  | {
      action: 'apply_rules';
      config: RequestRulesConfig;
    }
  | {
      action: 'auto_thinking';
      config: AutoThinkingConfig;
    }
  | {
      action: 'snapshot';
      phase: 'compat-pre' | 'compat-post';
      channel?: string;
    }
  | {
      action: 'resp_blacklist';
      config: ResponseBlacklistConfig;
    }
  | {
      action: 'response_normalize';
      config?: ResponseNormalizeConfig;
    }
  | {
      action: 'response_validate';
      config?: ResponseValidateConfig;
    }
  | {
      action: 'qwen_request_transform';
    }
  | {
      action: 'qwen_response_transform';
    }
  | {
      action: 'glm_web_search_request';
    }
  | {
      action: 'glm_image_content';
    }
  | {
      action: 'glm_vision_prompt';
    }
  | {
      action: 'gemini_web_search_request';
    }
  | {
      action: 'iflow_web_search_request';
    }
  | {
      action: 'iflow_tool_text_fallback';
      models?: string[];
    }
  | {
      action: 'iflow_response_body_unwrap';
    }
  | {
      action: 'deepseek_web_request';
    }
  | {
      action: 'deepseek_web_response';
      config?: DeepSeekWebResponseConfig;
    }
  | {
      action: 'claude_thinking_tool_schema';
    }
  | {
      action: 'anthropic_claude_code_system_prompt';
      config?: AnthropicClaudeCodeSystemPromptConfig;
    };

export type AnthropicClaudeCodeSystemPromptConfig = {
  /**
   * Force the Anthropic `system` prompt to match Claude Code official format.
   * Defaults to "You are Claude Code, Anthropic's official CLI for Claude."
   */
  systemText?: string;
  /**
   * When replacing an existing system prompt, optionally move the previous
   * system text into the beginning of the user message history.
   */
  preserveExistingSystemAsUserMessage?: boolean;
};

export type FilterInstruction = {
  action: 'rate_limit_text';
  needle: string;
};

export interface CompatApplicationResult {
  payload: JsonObject;
  appliedProfile?: string;
}
