// metadata-center-carrier.ts
//
// Apply a Rust-built StoplessMetadataCenterWritePlan to the TS-side MetadataCenter
// (the global symbol-injected singleton). This is the single TS writer entry
// point — all stopless metadata mutations must go through `applyStoplessMetadataCenterWritePlan`.
//
// Feature: hub.servertool_stopless_cli_continuation

import { readNativeFunction } from '../native/router-hotpath/native-shared-conversion-semantics-core.js';

const METADATA_CENTER_SYMBOL = Symbol.for('routecodex.metadataCenter');

type RuntimeControlWriter = {
  module: string;
  symbol: string;
  stage: string;
};

type MetadataCenterLike = {
  writeRuntimeControl?: (
    key: string,
    value: unknown,
    writtenBy: RuntimeControlWriter,
    reason?: string
  ) => void;
  readRuntimeControl?: () => Record<string, unknown>;
};

type StoplessRuntimeControlValue = {
  flowId: string;
  repeatCount: number;
  maxRepeats: number;
  triggerHint?: string;
  continuationPrompt?: string;
  schemaFeedback?: Record<string, unknown>;
  active: boolean;
  updatedAt?: number;
};

type StoplessMetadataCenterWritePlan = {
  stopless?: {
    flowId: string;
    active: boolean;
    repeatCount: number;
    maxRepeats: number;
    triggerHint?: string;
    continuationPrompt?: string;
    schemaFeedback?: Record<string, unknown>;
    updatedAt: number;
  };
  stopMessageCompareContext?: Record<string, unknown>;
  learnedNote?: {
    requestId: string;
    sessionId?: string;
    workingDirectory?: string;
    timestampMs: number;
    learned?: string;
    reason?: string;
    evidence?: string;
  };
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function findBoundMetadataCenter(target: Record<string, unknown>): MetadataCenterLike | undefined {
  const direct = Reflect.get(target, METADATA_CENTER_SYMBOL) as MetadataCenterLike | undefined;
  if (direct && typeof direct.writeRuntimeControl === 'function') {
    return direct;
  }
  const nested = asRecord(target.metadata);
  if (nested) {
    const nestedCenter = Reflect.get(nested, METADATA_CENTER_SYMBOL) as MetadataCenterLike | undefined;
    if (nestedCenter && typeof nestedCenter.writeRuntimeControl === 'function') {
      return nestedCenter;
    }
  }
  return undefined;
}

const WRITER: RuntimeControlWriter = {
  module: 'rust/router-hotpath-napi/stopless_auto_handler_bridge',
  symbol: 'buildStoplessMetadataCenterWritePlanJson',
  stage: 'stopless_runtime_control_writer'
};

/**
 * Apply a stopless metadata center write plan to the bound MetadataCenter.
 *
 * The plan is built by the Rust side and passed back as JSON. This function
 * performs the actual `Reflect.set` on `Symbol.for('routecodex.metadataCenter')`.
 */
export function applyStoplessMetadataCenterWritePlan(args: {
  adapterContext: Record<string, unknown>;
  plan: StoplessMetadataCenterWritePlan;
  reason?: string;
}): boolean {
  const center = findBoundMetadataCenter(args.adapterContext);
  if (!center) {
    return false;
  }

  if (args.plan.stopless) {
    const sl = args.plan.stopless;
    const value: StoplessRuntimeControlValue = {
      flowId: sl.flowId,
      repeatCount: sl.repeatCount,
      maxRepeats: sl.maxRepeats,
      active: sl.active,
      updatedAt: sl.updatedAt,
      ...(sl.triggerHint ? { triggerHint: sl.triggerHint } : {}),
      ...(sl.continuationPrompt ? { continuationPrompt: sl.continuationPrompt } : {}),
      ...(sl.schemaFeedback ? { schemaFeedback: sl.schemaFeedback } : {})
    };
    center.writeRuntimeControl?.('stopless', value, WRITER, args.reason ?? 'stopless-runtime-state');
  }

  if (args.plan.stopMessageCompareContext) {
    center.writeRuntimeControl?.(
      'stopMessageCompareContext',
      args.plan.stopMessageCompareContext,
      WRITER,
      args.reason ?? 'stop-message-compare-context'
    );
  }

  return true;
}

/**
 * Build a StoplessMetadataCenterWritePlan by calling the Rust NAPI function.
 * Returns null if the native function is unavailable.
 */
export function buildStoplessMetadataCenterWritePlan(args: {
  handlerPlan: Record<string, unknown>;
  center: Record<string, unknown>;
  requestId: string;
  timestampMs: number;
}): StoplessMetadataCenterWritePlan | null {
  const fn = readNativeFunction('buildStoplessMetadataCenterWritePlanJson');
  if (!fn) {
    return null;
  }
  const inputJson = JSON.stringify({
    handlerPlan: args.handlerPlan,
    center: args.center,
    requestId: args.requestId,
    timestampMs: args.timestampMs
  });
  const raw = fn(inputJson);
  if (typeof raw !== 'string') {
    return null;
  }
  try {
    return JSON.parse(raw) as StoplessMetadataCenterWritePlan;
  } catch {
    return null;
  }
}