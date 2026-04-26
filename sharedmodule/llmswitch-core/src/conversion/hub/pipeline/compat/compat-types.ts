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

export interface AnthropicClaudeCodeSystemPromptConfig {
  systemText?: string;
  preserveExistingSystemAsUserMessage?: boolean;
}

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

export interface MappingInstruction {
  action: string;
  config?: JsonValue;
  phase?: string;
  [key: string]: JsonValue | undefined;
}

export interface FilterInstruction {
  action: string;
  [key: string]: JsonValue | undefined;
}

export interface CompatApplicationResult {
  payload: JsonObject;
  appliedProfile?: string;
}
