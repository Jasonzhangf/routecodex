import type { AdapterContext } from '../conversion/hub/types/chat-envelope.js';
import { ensureRuntimeMetadata, readRuntimeMetadata } from '../conversion/runtime-metadata.js';
import { inspectStopGatewaySignalWithNative, type StopGatewayContext } from '../router/virtual-router/engine-selection/native-servertool-core-semantics.js';

// ── Main ────────────────────────────────────────────────────────────────────

const HARVESTABLE_TOOL_MARKER_PATTERN =
  /<\|\s*tool_calls_section_begin\s*\|>|<\|\s*tool_call_begin\s*\|>|<\|\s*tool_call_argument_begin\s*\|>/i;

function hasHarvestableToolMarkers(value: unknown): boolean {
  if (typeof value === 'string') return HARVESTABLE_TOOL_MARKER_PATTERN.test(value);
  if (Array.isArray(value)) return value.some((item) => hasHarvestableToolMarkers(item));
  if (!value || typeof value !== 'object') return false;
  return Object.values(value as Record<string, unknown>).some((item) => hasHarvestableToolMarkers(item));
}

function hasEmbeddedToolCallMarkersInChatMessage(message: Record<string, unknown> | null): boolean {
  if (!message) return false;
  const reasoning = message.reasoning;
  return hasHarvestableToolMarkers([
    message.content, message.reasoning_content, message.thinking, reasoning,
    reasoning && typeof reasoning === 'object' && !Array.isArray(reasoning)
      ? (reasoning as Record<string, unknown>).content : undefined,
    reasoning && typeof reasoning === 'object' && !Array.isArray(reasoning)
      ? (reasoning as Record<string, unknown>).text : undefined,
  ]);
}

function hasVisibleAssistantText(value: unknown): boolean {
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.some((item) => hasVisibleAssistantText(item));
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (typeof record.text === 'string' && record.text.trim().length > 0) return true;
  if (typeof record.content === 'string' && record.content.trim().length > 0) return true;
  if (Array.isArray(record.content) && record.content.some((item) => hasVisibleAssistantText(item))) return true;
  if (Array.isArray(record.parts) && record.parts.some((item) => hasVisibleAssistantText(item))) return true;
  return false;
}

function isReasoningOnlyEmptyAssistantMessage(message: Record<string, unknown> | null): boolean {
  if (!message) return false;
  const hasToolCalls = Array.isArray(message.tool_calls) && message.tool_calls.length > 0;
  if (hasToolCalls) return false;
  const hasVisibleContent = hasVisibleAssistantText(message.content);
  if (hasVisibleContent) return false;
  return hasVisibleAssistantText([message.reasoning_content, message.thinking, message.reasoning, message.reasoning_text]);
}

function tsFallbackInspect(base: unknown): StopGatewayContext {
  if (!base || typeof base !== 'object' || Array.isArray(base)) {
    return { observed: false, eligible: false, source: 'none', reason: 'invalid_payload' };
  }
  const payload = base as Record<string, unknown>;
  const choicesRaw = payload.choices;
  if (Array.isArray(choicesRaw) && choicesRaw.length) {
    for (let idx = choicesRaw.length - 1; idx >= 0; idx -= 1) {
      const choice = choicesRaw[idx];
      if (!choice || typeof choice !== 'object' || Array.isArray(choice)) continue;
      const finishReason = String((choice as Record<string, unknown>).finish_reason ?? '').trim().toLowerCase();
      if (!finishReason) continue;
      if (finishReason === 'tool_calls')
        return { observed: true, eligible: false, source: 'chat', reason: 'finish_reason_tool_calls', choiceIndex: idx, hasToolCalls: true };
      if (finishReason !== 'stop')
        return { observed: true, eligible: false, source: 'chat', reason: `finish_reason_${finishReason}`, choiceIndex: idx, hasToolCalls: false };
      const message = (choice as Record<string, unknown>).message as Record<string, unknown> | undefined ?? null;
      if (hasEmbeddedToolCallMarkersInChatMessage(message))
        return { observed: true, eligible: false, source: 'chat', reason: `finish_reason_${finishReason}_with_embedded_tool_markers`, choiceIndex: idx, hasToolCalls: false };
      const toolCalls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
      const hasTC = toolCalls.length > 0;
      if (isReasoningOnlyEmptyAssistantMessage(message))
        return { observed: true, eligible: false, source: 'chat', reason: `finish_reason_${finishReason}_reasoning_only_empty_assistant`, choiceIndex: idx, hasToolCalls: hasTC };
      return { observed: true, eligible: !hasTC, source: 'chat', reason: `finish_reason_${finishReason}`, choiceIndex: idx, hasToolCalls: hasTC };
    }
    return { observed: false, eligible: false, source: 'chat', reason: 'no_stop_finish_reason' };
  }
  const statusRaw = typeof payload.status === 'string' ? payload.status.trim().toLowerCase() : '';
  if (statusRaw && statusRaw !== 'completed')
    return { observed: false, eligible: false, source: 'responses', reason: `status_${statusRaw}` };
  const hasRequiredAction = Boolean(payload.required_action && typeof payload.required_action === 'object');
  const outputRaw = Array.isArray(payload.output) ? payload.output as unknown[] : [];
  if (!statusRaw && outputRaw.length === 0)
    return { observed: false, eligible: false, source: 'responses', reason: 'no_status_or_output' };
  if (outputRaw.some((item) => {
    const type = String((item as Record<string, unknown>)?.type ?? '').trim().toLowerCase();
    return ['tool_call', 'tool_use', 'function_call'].includes(type) || type.includes('tool');
  }))
    return { observed: true, eligible: false, source: 'responses', reason: 'responses_tool_like_output' };
  if (hasRequiredAction)
    return { observed: true, eligible: false, source: 'responses', reason: 'responses_required_action' };
  return { observed: true, eligible: true, source: 'responses', reason: statusRaw ? `status_${statusRaw}` : 'responses_output_completed' };
}

// ── Public API ──────────────────────────────────────────────────────────────

function tryNativeInspect(base: unknown): StopGatewayContext | undefined {
  try { return inspectStopGatewaySignalWithNative(base); } catch { return undefined; }
}

export function inspectStopGatewaySignal(base: unknown): StopGatewayContext {
  return tryNativeInspect(base) ?? tsFallbackInspect(base);
}

export function attachStopGatewayContext(adapterContext: AdapterContext, context: StopGatewayContext): void {
  try {
    const rt = ensureRuntimeMetadata(adapterContext as unknown as Record<string, unknown>);
    (rt as Record<string, unknown>).stopGatewayContext = {
      observed: context.observed,
      eligible: context.eligible,
      source: context.source,
      reason: context.reason,
      ...(typeof context.choiceIndex === 'number' ? { choiceIndex: context.choiceIndex } : {}),
      ...(typeof context.hasToolCalls === 'boolean' ? { hasToolCalls: context.hasToolCalls } : {})
    };
  } catch {
    // ignore metadata write failures
  }
}

export function readStopGatewayContext(adapterContext: unknown): StopGatewayContext | undefined {
  if (!adapterContext || typeof adapterContext !== 'object' || Array.isArray(adapterContext)) {
    return undefined;
  }
  const rt = readRuntimeMetadata(adapterContext as Record<string, unknown>);
  const raw = rt && typeof rt === 'object' ? (rt as Record<string, unknown>).stopGatewayContext : undefined;
  return normalizeStopGatewayContext(raw);
}

export function resolveStopGatewayContext(base: unknown, adapterContext?: unknown): StopGatewayContext {
  const fromMetadata = readStopGatewayContext(adapterContext);
  if (fromMetadata) {
    return fromMetadata;
  }
  return inspectStopGatewaySignal(base);
}

export function isStopEligibleForServerTool(base: unknown, adapterContext?: unknown): boolean {
  return resolveStopGatewayContext(base, adapterContext).eligible;
}

function normalizeStopGatewayContext(raw: unknown): StopGatewayContext | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  if (typeof record.observed !== 'boolean' || typeof record.eligible !== 'boolean') {
    return undefined;
  }
  const sourceRaw = typeof record.source === 'string' ? record.source.trim().toLowerCase() : '';
  const source: StopGatewayContext['source'] =
    sourceRaw === 'chat' || sourceRaw === 'responses' || sourceRaw === 'none'
      ? (sourceRaw as StopGatewayContext['source'])
      : 'none';
  const reason = typeof record.reason === 'string' && record.reason.trim() ? record.reason.trim() : 'unknown';
  const choiceIndex =
    typeof record.choiceIndex === 'number' && Number.isFinite(record.choiceIndex)
      ? Math.floor(record.choiceIndex)
      : undefined;
  const hasToolCalls = typeof record.hasToolCalls === 'boolean' ? record.hasToolCalls : undefined;
  return {
    observed: record.observed,
    eligible: record.eligible,
    source,
    reason,
    ...(typeof choiceIndex === 'number' ? { choiceIndex } : {}),
    ...(typeof hasToolCalls === 'boolean' ? { hasToolCalls } : {})
  };
}

function hasToolLikeOutput(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const typeRaw = (value as { type?: unknown }).type;
  const type = typeof typeRaw === 'string' ? typeRaw.trim().toLowerCase() : '';
  if (!type) {
    return false;
  }
  return (
    type === 'tool_call' ||
    type === 'tool_use' ||
    type === 'function_call' ||
    type.includes('tool')
  );
}
