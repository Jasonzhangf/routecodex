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
import {
  governRequestWithNative,
  governResponseWithNative
} from '../../../router/virtual-router/engine-selection/native-hub-pipeline-governance-semantics.js';

/**
 * Hybrid governance engine:
 * - request path: native-primary
 * - response path: native-primary
 *
 * Legacy-only snapshot retained at:
 * - src/conversion/hub/tool-governance/archive/engine.legacy.ts
 */

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
    let governed: { payload: Record<string, unknown>; summary: Record<string, unknown> };
    try {
      governed = governResponseWithNative({
        payload: payload as unknown as Record<string, unknown>,
        protocol,
        registry: this.registry as unknown as Record<string, unknown>
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error ?? 'unknown error');
      if (message.includes('Tool name exceeds max length')) {
        throw new ToolGovernanceError(
          message,
          protocol,
          'response',
          'tool.function.name'
        );
      }
      throw error;
    }
    return {
      payload: governed.payload as unknown as JsonObject,
      summary: governed.summary as unknown as ToolGovernanceSummary
    };
  }

  private resolveRules(protocol: ToolGovernanceProtocol, direction: 'request' | 'response'): ToolGovernanceRules | undefined {
    const resolved = normalizeProtocol(protocol);
    const entry = this.registry[resolved] ?? this.registry['openai-chat'];
    return entry?.[direction];
  }
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
