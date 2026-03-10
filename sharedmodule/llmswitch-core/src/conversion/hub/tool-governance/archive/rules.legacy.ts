import type { ToolGovernanceRegistry } from './types.js';
import {
  resolveDefaultToolGovernanceRulesWithNative,
  type NativeToolGovernanceRegistry,
  type NativeToolGovernanceRuleNode,
  type NativeToolGovernanceRules
} from '../../../router/virtual-router/engine-selection/native-hub-pipeline-governance-semantics.js';

const ALPHA_NUMERIC = /[A-Za-z0-9_-]/;
const LOWER_SNAKE = /[a-z0-9_-]/;

function clonePattern(pattern: RegExp): RegExp {
  const flags = pattern.flags.replace(/g/g, '');
  return new RegExp(pattern.source, flags);
}

function mapAllowedCharacters(token: unknown, fallback: RegExp): RegExp {
  const normalized = String(token || '').trim().toLowerCase();
  if (normalized === 'lower_snake') {
    return clonePattern(LOWER_SNAKE);
  }
  return clonePattern(fallback);
}

function mapNativeRules(
  nativeRules: NativeToolGovernanceRules | undefined,
  fallback: { allowedCharacters: RegExp; defaultName: string; maxNameLength: number }
): NonNullable<ToolGovernanceRegistry['openai-chat']>['request'] | undefined {
  if (!nativeRules || typeof nativeRules !== 'object') {
    return undefined;
  }
  return {
    maxNameLength:
      typeof nativeRules.maxNameLength === 'number' && Number.isFinite(nativeRules.maxNameLength)
        ? Math.max(1, Math.floor(nativeRules.maxNameLength))
        : fallback.maxNameLength,
    allowedCharacters: mapAllowedCharacters(nativeRules.allowedCharacters, fallback.allowedCharacters),
    defaultName:
      typeof nativeRules.defaultName === 'string' && nativeRules.defaultName.trim().length
        ? nativeRules.defaultName.trim()
        : fallback.defaultName,
    trimWhitespace: nativeRules.trimWhitespace !== false,
    ...(nativeRules.forceCase === 'lower' || nativeRules.forceCase === 'upper'
      ? { forceCase: nativeRules.forceCase }
      : {}),
    onViolation: nativeRules.onViolation === 'reject' ? 'reject' : 'truncate'
  };
}

function mapProtocolNode(
  nativeNode: NativeToolGovernanceRuleNode | undefined,
  options: { allowedCharacters: RegExp; forceCase?: 'lower' | 'upper' }
): NonNullable<ToolGovernanceRegistry['openai-chat']> {
  const defaultName = 'tool';
  const maxNameLength = 64;
  const fallbackBase = {
    allowedCharacters: options.allowedCharacters,
    defaultName,
    maxNameLength
  };
  const request = mapNativeRules(nativeNode?.request, fallbackBase) ?? {
    ...fallbackBase,
    trimWhitespace: true,
    onViolation: 'truncate',
    ...(options.forceCase ? { forceCase: options.forceCase } : {})
  };
  const response = mapNativeRules(nativeNode?.response, fallbackBase) ?? {
    ...fallbackBase,
    trimWhitespace: true,
    onViolation: 'truncate',
    ...(options.forceCase ? { forceCase: options.forceCase } : {})
  };
  if (options.forceCase) {
    request.forceCase = options.forceCase;
    response.forceCase = options.forceCase;
  }
  return {
    request,
    response
  };
}

function mapNativeRegistry(nativeRegistry: NativeToolGovernanceRegistry): ToolGovernanceRegistry {
  return {
    'openai-chat': mapProtocolNode(nativeRegistry['openai-chat'], {
      allowedCharacters: ALPHA_NUMERIC
    }),
    'openai-responses': mapProtocolNode(nativeRegistry['openai-responses'], {
      allowedCharacters: ALPHA_NUMERIC
    }),
    anthropic: mapProtocolNode(nativeRegistry.anthropic, {
      allowedCharacters: LOWER_SNAKE,
      forceCase: 'lower'
    }),
    gemini: mapProtocolNode(nativeRegistry.gemini, {
      allowedCharacters: ALPHA_NUMERIC
    })
  };
}

export const DEFAULT_TOOL_GOVERNANCE_RULES: ToolGovernanceRegistry =
  mapNativeRegistry(resolveDefaultToolGovernanceRulesWithNative());
