import type { JsonObject } from '../types/json.js';
import type { StandardizedRequest } from '../types/standardized.js';
import { DEFAULT_TOOL_GOVERNANCE_RULES } from './rules.js';
import type {
  GovernedChatCompletionPayload,
  GovernedStandardizedRequest,
  ToolGovernanceProtocol,
  ToolGovernanceRegistry,
  ToolGovernanceRules,
  ToolGovernanceSummary
} from './types.js';
import { governRequestWithNative } from '../../../router/virtual-router/engine-selection/native-hub-pipeline-governance-semantics.js';

const ALLOW_ARCHIVE_IMPORTS =
  process.env.LLMSWITCH_ALLOW_ARCHIVE_IMPORTS === '1' ||
  process.env.ROUTECODEX_ALLOW_ARCHIVE_IMPORTS === '1';

if (!ALLOW_ARCHIVE_IMPORTS) {
  throw new Error(
    '[archive] tool-governance/archive/engine.legacy is fail-closed. Set LLMSWITCH_ALLOW_ARCHIVE_IMPORTS=1 only for explicit migration/parity work.'
  );
}

export class ToolGovernanceError extends Error {
  constructor(
    message: string,
    readonly protocol: ToolGovernanceProtocol,
    readonly direction: 'request' | 'response',
    readonly field: string
  ) {
    super(message);
    this.name = 'ToolGovernanceError';
  }
}

function normalizeProtocol(protocol: ToolGovernanceProtocol): ToolGovernanceProtocol {
  if (!protocol) return 'openai-chat';
  const normalized = String(protocol).toLowerCase();
  if (normalized === 'anthropic-messages') {
    return 'anthropic';
  }
  if (normalized === 'gemini-chat') {
    return 'gemini';
  }
  if (normalized === 'responses' || normalized === 'openai-responses') {
    return 'openai-responses';
  }
  if (normalized === 'openai-chat') {
    return 'openai-chat';
  }
  return protocol;
}

export class ToolGovernanceEngine {
  constructor(private readonly registry: ToolGovernanceRegistry = DEFAULT_TOOL_GOVERNANCE_RULES) {}

  governRequest(
    request: StandardizedRequest,
    protocol: ToolGovernanceProtocol
  ): GovernedStandardizedRequest {
    const rules = this.resolveRules(protocol, 'request');
    if (!rules) {
      return {
        request,
        summary: buildSummary(protocol, 'request', false)
      };
    }
    let governed: { request: Record<string, unknown>; summary: Record<string, unknown> };
    try {
      governed = governRequestWithNative({
        request: request as unknown as Record<string, unknown>,
        protocol,
        registry: this.registry as unknown as Record<string, unknown>
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error ?? 'unknown error');
      if (message.includes('Tool name exceeds max length')) {
        throw new ToolGovernanceError(
          message,
          protocol,
          'request',
          'tool.function.name'
        );
      }
      throw error;
    }
    return {
      request: governed.request as unknown as StandardizedRequest,
      summary: governed.summary as unknown as ToolGovernanceSummary
    };
  }

  governResponse(
    payload: JsonObject,
    protocol: ToolGovernanceProtocol
  ): GovernedChatCompletionPayload {
    const rules = this.resolveRules(protocol, 'response');
    if (!rules) {
      return {
        payload,
        summary: buildSummary(protocol, 'response', false)
      };
    }

    const stats = createStats(protocol, 'response');
    const cloned = JSON.parse(JSON.stringify(payload)) as JsonObject;
    const choices = Array.isArray(cloned?.choices) ? (cloned.choices as JsonObject[]) : [];
    for (const choice of choices) {
      sanitizeChatCompletionChoice(choice, rules, stats);
    }
    if (Array.isArray(cloned?.tool_calls)) {
      cloned.tool_calls = (cloned.tool_calls as JsonObject[]).map((tc) =>
        sanitizeChatCompletionToolCall(tc, rules, stats)
      );
    }

    return {
      payload: cloned,
      summary: finalizeSummary(stats)
    };
  }

  private resolveRules(protocol: ToolGovernanceProtocol, direction: 'request' | 'response'): ToolGovernanceRules | undefined {
    const resolved = normalizeProtocol(protocol);
    const entry = this.registry[resolved] ?? this.registry['openai-chat'];
    return entry?.[direction];
  }
}

function sanitizeChatCompletionChoice(
  choice: JsonObject,
  rules: NonNullable<ToolGovernanceRegistry['openai-chat']>['response'],
  stats: GovernanceStats
): void {
  const message = choice?.message;
  if (!message || typeof message !== 'object') {
    return;
  }
  const msg = message as JsonObject;
  if (Array.isArray(msg.tool_calls)) {
    msg.tool_calls = (msg.tool_calls as JsonObject[]).map((tc, index) =>
      sanitizeChatCompletionToolCall(tc, rules, stats, `choices[].message.tool_calls[${index}].function.name`)
    );
  }
  if (msg.function_call && typeof msg.function_call === 'object') {
    const orig = (msg.function_call as JsonObject).name;
    const sanitizedName = sanitizeName(orig, rules, stats, 'choices[].message.function_call.name');
    (msg.function_call as JsonObject).name = sanitizedName;
  }
  if (typeof msg.name === 'string' || msg.role === 'tool') {
    msg.name = sanitizeName(msg.name, rules, stats, 'choices[].message.name');
  }
}

function sanitizeChatCompletionToolCall(
  tc: JsonObject,
  rules: NonNullable<ToolGovernanceRegistry['openai-chat']>['response'],
  stats: GovernanceStats,
  context: string = 'choices[].message.tool_calls[].function.name'
): JsonObject {
  if (!tc || typeof tc !== 'object') {
    return tc;
  }
  const fn = tc.function;
  if (!fn || typeof fn !== 'object') {
    return tc;
  }
  const sanitizedName = sanitizeName((fn as JsonObject).name, rules, stats, context);
  if (sanitizedName === (fn as JsonObject).name) {
    return tc;
  }
  return {
    ...tc,
    function: {
      ...(fn as JsonObject),
      name: sanitizedName
    }
  };
}

interface GovernanceStats {
  protocol: ToolGovernanceProtocol;
  direction: 'request' | 'response';
  applied: boolean;
  sanitizedNames: number;
  truncatedNames: number;
  defaultedNames: number;
}

function createStats(protocol: ToolGovernanceProtocol, direction: 'request' | 'response'): GovernanceStats {
  return {
    protocol,
    direction,
    applied: false,
    sanitizedNames: 0,
    truncatedNames: 0,
    defaultedNames: 0
  };
}

function sanitizeName(
  rawName: unknown,
  rules: NonNullable<ToolGovernanceRegistry['openai-chat']>['response'],
  stats: GovernanceStats,
  field: string
): string {
  const defaultName = rules.defaultName ?? 'tool';
  let next = typeof rawName === 'string' ? rawName : '';
  let changed = false;
  if (rules.trimWhitespace !== false) {
    next = next.trim();
  }
  if (!next) {
    next = defaultName;
    stats.defaultedNames += 1;
    changed = true;
  }
  if (rules.forceCase === 'lower') {
    const forced = next.toLowerCase();
    if (forced !== next) {
      next = forced;
      changed = true;
    }
  } else if (rules.forceCase === 'upper') {
    const forced = next.toUpperCase();
    if (forced !== next) {
      next = forced;
      changed = true;
    }
  }
  if (rules.allowedCharacters) {
    const matcher = new RegExp(rules.allowedCharacters.source);
    const filtered = next
      .split('')
      .filter((ch) => matcher.test(ch))
      .join('');
    matcher.lastIndex = 0;
    if (filtered.length === 0) {
      next = defaultName;
      stats.defaultedNames += 1;
      changed = true;
    } else if (filtered !== next) {
      next = filtered;
      changed = true;
    }
  }
  if (rules.maxNameLength && next.length > rules.maxNameLength) {
    if (rules.onViolation === 'reject') {
      throw new ToolGovernanceError(
        `Tool name exceeds max length of ${rules.maxNameLength}`,
        stats.protocol,
        stats.direction,
        field
      );
    }
    next = next.slice(0, rules.maxNameLength);
    stats.truncatedNames += 1;
    changed = true;
  }
  if (changed || (typeof rawName === 'string' && rawName !== next)) {
    stats.sanitizedNames += 1;
  }
  stats.applied = true;
  return next || defaultName;
}

function finalizeSummary(stats: GovernanceStats): ToolGovernanceSummary {
  return {
    protocol: stats.protocol,
    direction: stats.direction,
    applied: stats.applied,
    sanitizedNames: stats.sanitizedNames,
    truncatedNames: stats.truncatedNames,
    defaultedNames: stats.defaultedNames,
    timestamp: Date.now()
  };
}

function buildSummary(
  protocol: ToolGovernanceProtocol,
  direction: 'request' | 'response',
  applied: boolean
): ToolGovernanceSummary {
  return {
    protocol,
    direction,
    applied,
    sanitizedNames: 0,
    truncatedNames: 0,
    defaultedNames: 0,
    timestamp: Date.now()
  };
}
