import type { AdapterContext } from '../conversion/hub/types/chat-envelope.js';
import { ensureRuntimeMetadata, readRuntimeMetadata } from '../conversion/runtime-metadata.js';

export interface StopGatewayContext {
  observed: boolean;
  eligible: boolean;
  source: 'chat' | 'responses' | 'none';
  reason: string;
  choiceIndex?: number;
  hasToolCalls?: boolean;
}

export function inspectStopGatewaySignal(base: unknown): StopGatewayContext {
  if (!base || typeof base !== 'object' || Array.isArray(base)) {
    return {
      observed: false,
      eligible: false,
      source: 'none',
      reason: 'invalid_payload'
    };
  }

  const payload = base as { [key: string]: unknown };
  const choicesRaw = payload.choices;
  if (Array.isArray(choicesRaw) && choicesRaw.length) {
    for (let idx = 0; idx < choicesRaw.length; idx += 1) {
      const choice = choicesRaw[idx];
      if (!choice || typeof choice !== 'object' || Array.isArray(choice)) {
        continue;
      }
      const finishReasonRaw = (choice as { finish_reason?: unknown }).finish_reason;
      const finishReason =
        typeof finishReasonRaw === 'string' && finishReasonRaw.trim()
          ? finishReasonRaw.trim().toLowerCase()
          : '';
      if (!finishReason || finishReason === 'tool_calls') {
        continue;
      }
      if (finishReason !== 'stop' && finishReason !== 'length') {
        continue;
      }

      const message =
        (choice as { message?: unknown }).message &&
        typeof (choice as { message?: unknown }).message === 'object' &&
        !Array.isArray((choice as { message?: unknown }).message)
          ? ((choice as { message: unknown }).message as { [key: string]: unknown })
          : null;
      const toolCalls = message && Array.isArray(message.tool_calls) ? message.tool_calls : [];
      const hasToolCalls = toolCalls.length > 0;
      return {
        observed: true,
        eligible: !hasToolCalls,
        source: 'chat',
        reason: `finish_reason_${finishReason}`,
        choiceIndex: idx,
        hasToolCalls
      };
    }

    return {
      observed: false,
      eligible: false,
      source: 'chat',
      reason: 'no_stop_finish_reason'
    };
  }

  const statusRaw = typeof payload.status === 'string' ? payload.status.trim().toLowerCase() : '';
  if (statusRaw && statusRaw !== 'completed') {
    return {
      observed: false,
      eligible: false,
      source: 'responses',
      reason: `status_${statusRaw}`
    };
  }

  const hasRequiredAction = Boolean(payload.required_action && typeof payload.required_action === 'object');
  const outputRaw = Array.isArray(payload.output) ? (payload.output as unknown[]) : [];
  if (!statusRaw && outputRaw.length === 0) {
    return {
      observed: false,
      eligible: false,
      source: 'responses',
      reason: 'no_status_or_output'
    };
  }
  if (outputRaw.some((item) => hasToolLikeOutput(item))) {
    return {
      observed: true,
      eligible: false,
      source: 'responses',
      reason: 'responses_tool_like_output'
    };
  }
  if (hasRequiredAction) {
    return {
      observed: true,
      eligible: false,
      source: 'responses',
      reason: 'responses_required_action'
    };
  }
  return {
    observed: true,
    eligible: true,
    source: 'responses',
    reason: statusRaw ? `status_${statusRaw}` : 'responses_output_completed'
  };
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
