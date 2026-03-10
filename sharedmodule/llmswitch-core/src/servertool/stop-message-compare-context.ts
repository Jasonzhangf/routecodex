import { ensureRuntimeMetadata, readRuntimeMetadata } from '../conversion/runtime-metadata.js';

export interface StopMessageCompareContext {
  armed: boolean;
  mode: 'off' | 'on' | 'auto';
  allowModeOnly: boolean;
  textLength: number;
  maxRepeats: number;
  used: number;
  remaining: number;
  active: boolean;
  stopEligible: boolean;
  hasCapturedRequest: boolean;
  compactionRequest: boolean;
  hasSeed: boolean;
  decision: 'trigger' | 'skip';
  reason: string;
  stage?: string;
  bdWorkState?: string;
  observationHash?: string;
  observationStableCount?: number;
  toolSignatureHash?: string;
}

const STOP_MESSAGE_COMPARE_KEY = 'stopMessageCompareContext';

export function attachStopMessageCompareContext(
  adapterContext: unknown,
  context: StopMessageCompareContext
): void {
  if (!adapterContext || typeof adapterContext !== 'object' || Array.isArray(adapterContext)) {
    return;
  }
  try {
    const runtime = ensureRuntimeMetadata(adapterContext as Record<string, unknown>);
    (runtime as Record<string, unknown>)[STOP_MESSAGE_COMPARE_KEY] = {
      armed: context.armed,
      mode: context.mode,
      allowModeOnly: context.allowModeOnly,
      textLength: context.textLength,
      maxRepeats: context.maxRepeats,
      used: context.used,
      remaining: context.remaining,
      active: context.active,
      stopEligible: context.stopEligible,
      hasCapturedRequest: context.hasCapturedRequest,
      compactionRequest: context.compactionRequest,
      hasSeed: context.hasSeed,
      decision: context.decision,
      reason: context.reason,
      ...(typeof context.stage === 'string' && context.stage.trim() ? { stage: context.stage.trim() } : {}),
      ...(typeof context.bdWorkState === 'string' && context.bdWorkState.trim()
        ? { bdWorkState: context.bdWorkState.trim() }
        : {}),
      ...(typeof context.observationHash === 'string' && context.observationHash.trim()
        ? { observationHash: context.observationHash.trim() }
        : {}),
      ...(typeof context.observationStableCount === 'number' && Number.isFinite(context.observationStableCount)
        ? { observationStableCount: Math.max(0, Math.floor(context.observationStableCount)) }
        : {}),
      ...(typeof context.toolSignatureHash === 'string' && context.toolSignatureHash.trim()
        ? { toolSignatureHash: context.toolSignatureHash.trim() }
        : {})
    };
  } catch {
    // ignore metadata write failures
  }
}

export function readStopMessageCompareContext(adapterContext: unknown): StopMessageCompareContext | undefined {
  if (!adapterContext || typeof adapterContext !== 'object' || Array.isArray(adapterContext)) {
    return undefined;
  }
  const runtime = readRuntimeMetadata(adapterContext as Record<string, unknown>);
  const raw = runtime && typeof runtime === 'object' ? (runtime as Record<string, unknown>)[STOP_MESSAGE_COMPARE_KEY] : undefined;
  return normalizeStopMessageCompareContext(raw);
}

export function formatStopMessageCompareContext(context: StopMessageCompareContext | undefined): string {
  if (!context) {
    return 'decision=unknown reason=no_context';
  }
  return [
    `decision=${context.decision}`,
    `reason=${context.reason}`,
    `armed=${context.armed}`,
    `mode=${context.mode}`,
    `allowModeOnly=${context.allowModeOnly}`,
    `max=${context.maxRepeats}`,
    `used=${context.used}`,
    `left=${context.remaining}`,
    `active=${context.active}`,
    `stopEligible=${context.stopEligible}`,
    `captured=${context.hasCapturedRequest}`,
    `compaction=${context.compactionRequest}`,
    `seed=${context.hasSeed}`,
    ...(typeof context.stage === 'string' && context.stage ? [`stage=${context.stage}`] : []),
    ...(typeof context.bdWorkState === 'string' && context.bdWorkState ? [`bd=${context.bdWorkState}`] : []),
    `obs=${typeof context.observationHash === 'string' && context.observationHash ? context.observationHash : 'none'}`,
    `stable=${typeof context.observationStableCount === 'number' && Number.isFinite(context.observationStableCount)
      ? Math.max(0, Math.floor(context.observationStableCount))
      : 'n/a'}`,
    `toolSig=${typeof context.toolSignatureHash === 'string' && context.toolSignatureHash ? context.toolSignatureHash : 'none'}`
  ].join(' ');
}

function normalizeStopMessageCompareContext(raw: unknown): StopMessageCompareContext | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  const decisionRaw = typeof record.decision === 'string' ? record.decision.trim().toLowerCase() : '';
  if (decisionRaw !== 'trigger' && decisionRaw !== 'skip') {
    return undefined;
  }
  const modeRaw = typeof record.mode === 'string' ? record.mode.trim().toLowerCase() : '';
  const mode: StopMessageCompareContext['mode'] =
    modeRaw === 'on' || modeRaw === 'auto' || modeRaw === 'off'
      ? (modeRaw as StopMessageCompareContext['mode'])
      : 'off';
  const reason = typeof record.reason === 'string' && record.reason.trim() ? record.reason.trim() : 'unknown';
  const textLength =
    typeof record.textLength === 'number' && Number.isFinite(record.textLength)
      ? Math.max(0, Math.floor(record.textLength))
      : 0;
  const maxRepeats =
    typeof record.maxRepeats === 'number' && Number.isFinite(record.maxRepeats)
      ? Math.max(0, Math.floor(record.maxRepeats))
      : 0;
  const used =
    typeof record.used === 'number' && Number.isFinite(record.used)
      ? Math.max(0, Math.floor(record.used))
      : 0;
  const remaining =
    typeof record.remaining === 'number' && Number.isFinite(record.remaining)
      ? Math.max(0, Math.floor(record.remaining))
      : Math.max(0, maxRepeats - used);
  return {
    armed: Boolean(record.armed),
    mode,
    allowModeOnly: Boolean(record.allowModeOnly),
    textLength,
    maxRepeats,
    used,
    remaining,
    active: Boolean(record.active),
    stopEligible: Boolean(record.stopEligible),
    hasCapturedRequest: Boolean(record.hasCapturedRequest),
    compactionRequest: Boolean(record.compactionRequest),
    hasSeed: Boolean(record.hasSeed),
    decision: decisionRaw,
    reason,
    ...(typeof record.stage === 'string' && record.stage.trim() ? { stage: record.stage.trim() } : {}),
    ...(typeof record.bdWorkState === 'string' && record.bdWorkState.trim()
      ? { bdWorkState: record.bdWorkState.trim() }
      : {}),
    ...(typeof record.observationHash === 'string' && record.observationHash.trim()
      ? { observationHash: record.observationHash.trim() }
      : {}),
    ...(typeof record.observationStableCount === 'number' && Number.isFinite(record.observationStableCount)
      ? { observationStableCount: Math.max(0, Math.floor(record.observationStableCount)) }
      : {}),
    ...(typeof record.toolSignatureHash === 'string' && record.toolSignatureHash.trim()
      ? { toolSignatureHash: record.toolSignatureHash.trim() }
      : {})
  };
}
