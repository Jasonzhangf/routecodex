import { resolveHubProtocolAllowlistsWithNative } from '../native/router-hotpath/native-hub-bridge-policy-semantics.js';

const allowlists = resolveHubProtocolAllowlistsWithNative();

function stripForbiddenProviderOutboundFields(fields: readonly string[]): readonly string[] {
  return Object.freeze(fields.filter((field) => field !== 'metadata'));
}

export const OPENAI_CHAT_ALLOWED_FIELDS = stripForbiddenProviderOutboundFields([...allowlists.openaiChatAllowedFields]);

export const ANTHROPIC_ALLOWED_FIELDS = Object.freeze([...allowlists.anthropicAllowedFields]) as readonly string[];

export const OPENAI_RESPONSES_ALLOWED_FIELDS = stripForbiddenProviderOutboundFields([...allowlists.openaiResponsesAllowedFields]);

export const GEMINI_ALLOWED_FIELDS = Object.freeze([...allowlists.geminiAllowedFields]) as readonly string[];

export const OPENAI_RESPONSES_PARAMETERS_WRAPPER_ALLOW_KEYS =
  Object.freeze([...allowlists.openaiResponsesParametersWrapperAllowKeys]) as readonly string[];

export const OPENAI_CHAT_PARAMETERS_WRAPPER_ALLOW_KEYS =
  Object.freeze([...allowlists.openaiChatParametersWrapperAllowKeys]) as readonly string[];

export const ANTHROPIC_PARAMETERS_WRAPPER_ALLOW_KEYS =
  Object.freeze([...allowlists.anthropicParametersWrapperAllowKeys]) as readonly string[];
