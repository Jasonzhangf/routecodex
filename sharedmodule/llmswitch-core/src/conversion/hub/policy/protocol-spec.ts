export type HubProviderProtocol = 'openai-chat' | 'openai-responses' | 'anthropic-messages' | 'gemini-chat';

import {
  ANTHROPIC_ALLOWED_FIELDS,
  ANTHROPIC_PARAMETERS_WRAPPER_ALLOW_KEYS,
  GEMINI_ALLOWED_FIELDS,
  OPENAI_CHAT_ALLOWED_FIELDS,
  OPENAI_CHAT_PARAMETERS_WRAPPER_ALLOW_KEYS,
  OPENAI_RESPONSES_ALLOWED_FIELDS,
  OPENAI_RESPONSES_PARAMETERS_WRAPPER_ALLOW_KEYS
} from '../../protocol-field-allowlists.js';
import { resolveHubProtocolSpecWithNative } from '../../../router/virtual-router/engine-selection/native-hub-bridge-policy-semantics.js';

export interface ProviderOutboundLayoutRule {
  code: 'forbid_wrapper';
  path: string;
  detail: string;
}

export interface ProviderOutboundWrapperFlattenRule {
  wrapperKey: string;
  /**
   * When provided, only these keys from the wrapper are merged into top-level.
   * When omitted, all keys are eligible.
   */
  allowKeys?: string[];
  /**
   * Key remap inside wrapper prior to merging (e.g. max_tokens -> max_output_tokens).
   */
  aliasKeys?: Record<string, string>;
  /**
   * Merge strategy: only write to target when top-level key is undefined.
   */
  onlyIfTargetMissing?: boolean;
}

export interface ProviderOutboundPolicySpec {
  /**
   * Whether provider outbound enforcement is enabled for this protocol.
   * Keep this false for protocols not yet migrated, to avoid behavior changes.
   */
  enforceEnabled: boolean;
  /**
   * Provider outbound payload allowlist (top-level keys), used for observation
   * to detect drift.
   */
  allowedTopLevelKeys?: readonly string[];
  /**
   * When enabled, provider outbound payload will drop any top-level keys not
   * present in allowedTopLevelKeys (after wrapper flatten).
   *
   * Keep this configurable for progressive rollout, but Phase 1 completion
   * requires enabling it for all protocols.
   */
  enforceAllowedTopLevelKeys?: boolean;
  /**
   * Reserved/private key prefixes that must not be sent upstream.
   * (Enforced only when enforceEnabled=true.)
   */
  reservedKeyPrefixes: string[];
  /**
   * Wrappers that should not exist in provider outbound payload.
   * observe: treat as violations; enforce: flatten/remove when configured.
   */
  forbidWrappers: ProviderOutboundLayoutRule[];
  /**
   * Best-effort fix for known wrapper anti-patterns by flattening into top-level.
   * (Applied only when enforceEnabled=true.)
   */
  flattenWrappers: ProviderOutboundWrapperFlattenRule[];
}

export type ToolDefinitionFormat = 'openai' | 'anthropic' | 'gemini';
export type ProviderOutboundHistoryCarrier = 'messages' | 'input';

export interface ToolSurfaceSpec {
  expectedToolFormat: ToolDefinitionFormat;
  /**
   * For OpenAI protocols, tool call/result history may be carried in either
   * chat `messages[]` or responses `input[]`. This spec describes the expected
   * carrier so toolSurface can normalize or at least record diffs.
   */
  expectedHistoryCarrier?: ProviderOutboundHistoryCarrier;
}

export interface ProtocolSpec {
  id: HubProviderProtocol;
  providerOutbound: ProviderOutboundPolicySpec;
  toolSurface: ToolSurfaceSpec;
}

const ALLOWLISTS = {
  openaiChatAllowedFields: OPENAI_CHAT_ALLOWED_FIELDS,
  openaiChatParametersWrapperAllowKeys: OPENAI_CHAT_PARAMETERS_WRAPPER_ALLOW_KEYS,
  openaiResponsesAllowedFields: OPENAI_RESPONSES_ALLOWED_FIELDS,
  openaiResponsesParametersWrapperAllowKeys: OPENAI_RESPONSES_PARAMETERS_WRAPPER_ALLOW_KEYS,
  anthropicAllowedFields: ANTHROPIC_ALLOWED_FIELDS,
  anthropicParametersWrapperAllowKeys: ANTHROPIC_PARAMETERS_WRAPPER_ALLOW_KEYS,
  geminiAllowedFields: GEMINI_ALLOWED_FIELDS
};

function buildSpec(protocol: HubProviderProtocol): ProtocolSpec {
  return resolveHubProtocolSpecWithNative({
    protocol,
    allowlists: ALLOWLISTS
  }) as ProtocolSpec;
}

export const HUB_PROTOCOL_SPECS: Record<HubProviderProtocol, ProtocolSpec> = {
  'openai-chat': buildSpec('openai-chat'),
  'openai-responses': buildSpec('openai-responses'),
  'anthropic-messages': buildSpec('anthropic-messages'),
  'gemini-chat': buildSpec('gemini-chat')
};

export function resolveHubProtocolSpec(protocol: string): ProtocolSpec {
  const normalized = (protocol || '').trim().toLowerCase() as HubProviderProtocol;
  return HUB_PROTOCOL_SPECS[normalized] ?? HUB_PROTOCOL_SPECS['openai-chat'];
}
