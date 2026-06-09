import type { JsonObject } from '../../types/json.js';

export interface AnthropicClaudeCodeSystemPromptConfig {
  systemText?: string;
  preserveExistingSystemAsUserMessage?: boolean;
}

export interface CompatApplicationResult {
  payload: JsonObject;
  appliedProfile?: string;
}
