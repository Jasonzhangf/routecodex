import type { JsonObject } from '../conversion/hub/types/json.js';
import {
  resolveFollowupFlowDecision,
  type FollowupFlowDecision
} from './backend-route-flow-policy.js';

function cloneJsonObject<T extends JsonObject>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function decorateContinueExecutionSummary(chat: JsonObject, execution: { context?: JsonObject }): JsonObject {
  const ctx = execution.context as { continue_execution?: { visibleSummary?: unknown } };
  const ce = ctx.continue_execution;
  const visibleSummary =
    ce && typeof ce.visibleSummary === 'string' && ce.visibleSummary.trim().length
      ? ce.visibleSummary.trim()
      : '';
  if (!visibleSummary) {
    return chat;
  }

  const cloned = cloneJsonObject(chat);
  const choices = Array.isArray((cloned as any).choices) ? (cloned as any).choices : [];
  if (!choices.length) {
    return cloned;
  }
  const first = choices[0] && typeof choices[0] === 'object' ? (choices[0] as Record<string, unknown>) : null;
  if (!first || !first.message || typeof first.message !== 'object') {
    return cloned;
  }
  const message = first.message as Record<string, unknown>;
  const baseContent = typeof message.content === 'string' ? message.content : '';
  message.content =
    baseContent && baseContent.trim().length
      ? `${visibleSummary}\n\n${baseContent}`
      : visibleSummary;
  return cloned;
}

function decorateWebSearchSummary(chat: JsonObject, execution: { context?: JsonObject }): JsonObject {
  const ctx = execution.context as { web_search?: { engineId?: unknown; summary?: unknown } };
  const web = ctx.web_search;
  const summary =
    web && typeof web.summary === 'string' && web.summary.trim().length
      ? web.summary.trim()
      : '';
  if (!summary) {
    return chat;
  }
  const engineId =
    web && typeof web.engineId === 'string' && web.engineId.trim().length
      ? web.engineId.trim()
      : undefined;
  const label = engineId
    ? `【web_search 原文 | engine: ${engineId}】`
    : '【web_search 原文】';

  const cloned = cloneJsonObject(chat);
  const choices = Array.isArray((cloned as any).choices) ? (cloned as any).choices : [];
  if (!choices.length) {
    return cloned;
  }
  const first = choices[0] && typeof choices[0] === 'object' ? (choices[0] as Record<string, unknown>) : null;
  if (!first || !first.message || typeof first.message !== 'object') {
    return cloned;
  }
  const message = first.message as Record<string, unknown>;
  const baseContent = typeof message.content === 'string' ? message.content : '';
  const suffix = `${label}\n${summary}`;
  message.content =
    baseContent && baseContent.trim().length
      ? `${baseContent}\n\n${suffix}`
      : suffix;
  return cloned;
}

export function shouldShortCircuitRequiresActionFollowup(args: {
  flowId: string | undefined;
  decision?: FollowupFlowDecision;
  followupBody?: JsonObject;
  hasRequiresActionShape: (payload: JsonObject) => boolean;
}): boolean {
  const decision = args.decision ?? resolveFollowupFlowDecision(args.flowId);
  return Boolean(decision.ignoreRequiresActionFollowup && args.followupBody && args.hasRequiresActionShape(args.followupBody));
}

export function decorateFinalChatWithServerToolContext(
  chat: JsonObject,
  execution: { flowId: string; context?: JsonObject } | undefined,
  decision?: FollowupFlowDecision
): JsonObject {
  if (!execution || !execution.context) {
    return chat;
  }
  const resolvedDecision = decision ?? resolveFollowupFlowDecision(execution.flowId);
  const mode = resolvedDecision.contextDecorationMode;
  if (mode === 'continue_execution_summary') {
    return decorateContinueExecutionSummary(chat, execution);
  }
  if (mode === 'web_search_summary') {
    return decorateWebSearchSummary(chat, execution);
  }
  return chat;
}
