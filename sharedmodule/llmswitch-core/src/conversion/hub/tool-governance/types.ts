import type { JsonObject } from '../types/json.js';
import type { StandardizedMessage, StandardizedRequest, StandardizedTool } from '../types/standardized.js';

export type ToolGovernanceProtocol =
  | 'openai-chat'
  | 'openai-responses'
  | 'anthropic'
  | 'gemini'
  | string;

export type ToolGovernanceViolationMode = 'truncate' | 'reject';

export interface ToolGovernanceRules {
  maxNameLength?: number;
  allowedCharacters?: RegExp;
  forceCase?: 'lower' | 'upper';
  defaultName?: string;
  trimWhitespace?: boolean;
  onViolation?: ToolGovernanceViolationMode;
}

export interface ToolGovernanceRegistryEntry {
  request?: ToolGovernanceRules;
  response?: ToolGovernanceRules;
}

export type ToolGovernanceRegistry = Record<ToolGovernanceProtocol, ToolGovernanceRegistryEntry>;

export interface ToolGovernanceSummary {
  protocol: ToolGovernanceProtocol;
  direction: 'request' | 'response';
  applied: boolean;
  sanitizedNames: number;
  truncatedNames: number;
  defaultedNames: number;
  timestamp: number;
}

export interface GovernedStandardizedRequest {
  request: StandardizedRequest;
  summary: ToolGovernanceSummary;
}

export interface GovernedChatCompletionPayload {
  payload: JsonObject;
  summary: ToolGovernanceSummary;
}

export type MutableStandardizedMessage = StandardizedMessage & {
  tool_calls?: StandardizedMessage['tool_calls'];
};

export type MutableStandardizedTool = StandardizedTool;
