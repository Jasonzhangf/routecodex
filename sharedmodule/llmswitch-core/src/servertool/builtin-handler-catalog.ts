import type { ServerToolHandlerContext, ServerToolHandlerResult } from './types.js';
import type { ServerToolHandlerEntry } from './registry-types.js';
import type { ServerToolHandlerRegistrationSpec } from './skeleton-config.js';
import type { JsonObject } from '../conversion/hub/types/json.js';
import { getServertoolToolSpec, listServertoolToolSpecs } from './skeleton-config.js';
import { readNativeFunction } from '../native/router-hotpath/native-shared-conversion-semantics-core.js';
import {
  applyStoplessMetadataCenterWritePlan,
} from './stopless-metadata-center-writer.js';

type StoplessAutoHandlerRuntimeOutput = {
  action: 'return_null' | 'throw_error' | 'return_handler_result';
  metadataWritePlan?: JsonObject;
  learnedNoteWrite?: Record<string, unknown>;
  error?: {
    message: string;
    code?: string;
    status?: number;
    repeatCount?: number;
    threshold?: number;
    goalContextCount?: number;
  };
  flowId?: string;
  handlerResult?: ServerToolHandlerResult;
} & Record<string, unknown>;

function isBuiltinRuntimeSupported(name: string): boolean {
  switch (name.trim().toLowerCase()) {
    case 'stop_message_auto':
      return true;
    default:
      return false;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

type MetadataCenterLike = {
  readRequestTruth?: () => Record<string, unknown>;
  readContinuationContext?: () => Record<string, unknown>;
  readRuntimeControl?: () => Record<string, unknown>;
  readProviderObservation?: () => Record<string, unknown>;
  readClientAttachmentScope?: () => Record<string, unknown>;
  readDebugSnapshot?: () => Record<string, unknown>;
};

function isMetadataCenterLike(value: unknown): value is MetadataCenterLike {
  const record = asRecord(value);
  if (!record) {
    return false;
  }
  return (
    typeof record.readRequestTruth === 'function'
    && typeof record.readContinuationContext === 'function'
    && typeof record.readRuntimeControl === 'function'
    && typeof record.readProviderObservation === 'function'
    && typeof record.readDebugSnapshot === 'function'
  );
}

function readBoundMetadataCenter(target: unknown): MetadataCenterLike | null {
  const record = asRecord(target);
  if (!record) {
    return null;
  }
  const symbolValue = Reflect.get(record, Symbol.for('routecodex.metadataCenter'));
  if (isMetadataCenterLike(symbolValue)) {
    return symbolValue;
  }
  return null;
}

function buildMetadataCenterRustSnapshot(target: unknown): Record<string, unknown> | null {
  const center = readBoundMetadataCenter(target);
  if (!center) {
    return null;
  }
  return {
    requestTruth: center.readRequestTruth?.() ?? {},
    continuationContext: center.readContinuationContext?.() ?? {},
    runtimeControl: center.readRuntimeControl?.() ?? {},
    providerObservation: center.readProviderObservation?.() ?? {},
    clientAttachmentScope: center.readClientAttachmentScope?.() ?? {},
    debugSnapshot: center.readDebugSnapshot?.() ?? {},
  };
}

function readMetadataCenterSnapshot(target: unknown): Record<string, unknown> | null {
  const liveSnapshot = buildMetadataCenterRustSnapshot(target);
  if (liveSnapshot) {
    return liveSnapshot;
  }
  const record = asRecord(target);
  if (!record) {
    return null;
  }
  const direct = asRecord(record.metadataCenterSnapshot);
  if (direct) {
    return direct;
  }
  const nestedMetadata = asRecord(record.metadata);
  return nestedMetadata ? asRecord(nestedMetadata.metadataCenterSnapshot) : null;
}

async function runStoplessAutoHandlerRuntimeNapi(
  ctx: ServerToolHandlerContext
): Promise<StoplessAutoHandlerRuntimeOutput> {
  const fn = readNativeFunction('runStoplessAutoHandlerRuntimeJson');
  if (!fn) {
    throw new Error('runStoplessAutoHandlerRuntimeJson native unavailable');
  }
  const metadataCenterSnapshot = readMetadataCenterSnapshot(ctx.adapterContext);
  const runtimeMetadata = metadataCenterSnapshot
    ? {
        metadataCenterSnapshot
      }
    : null;
  const raw = fn(JSON.stringify({
    adapterContext: ctx.adapterContext,
    base: ctx.base,
    requestId: ctx.requestId,
    runtimeMetadata,
  }));
  if (typeof raw === 'string') {
    return JSON.parse(raw) as StoplessAutoHandlerRuntimeOutput;
  }
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as StoplessAutoHandlerRuntimeOutput;
  }
  throw new Error(`runStoplessAutoHandlerRuntimeJson native returned unsupported payload: ${typeof raw}`);
}

async function runBuiltinStopMessageAutoHandler(
  ctx: ServerToolHandlerContext
): Promise<{ flowId: string; finalize: () => Promise<ServerToolHandlerResult> } | null> {
  const record = ctx.adapterContext as Record<string, unknown>;
  const runtime = await runStoplessAutoHandlerRuntimeNapi(ctx);

  if (runtime.metadataWritePlan && typeof runtime.metadataWritePlan === 'object' && !Array.isArray(runtime.metadataWritePlan)) {
    applyStoplessMetadataCenterWritePlan({
      adapterContext: record,
      plan: runtime.metadataWritePlan,
      reason: 'stop-message-runtime'
    });
  }

  if (runtime.action === 'return_null') {
    return null;
  }
  if (runtime.action === 'throw_error') {
    const err: Error & {
      code?: string;
      status?: number;
      repeatCount?: number;
      threshold?: number;
      goalContextCount?: number;
    } = Object.assign(
      new Error(runtime.error?.message ?? '[servertool] Rust stopless runtime requested an error'),
      {
        code: runtime.error?.code ?? 'STOPLESS_RUNTIME_ERROR',
        status: runtime.error?.status ?? 500,
        repeatCount: runtime.error?.repeatCount,
        threshold: runtime.error?.threshold,
        goalContextCount: runtime.error?.goalContextCount
      }
    );
    throw err;
  }
  if (runtime.action !== 'return_handler_result') {
    throw new Error(`[servertool] unsupported Rust stopless runtime action: ${String(runtime.action)}`);
  }
  if (!runtime.handlerResult) {
    throw new Error('[servertool] Rust stopless runtime missing handlerResult');
  }
  return {
    flowId: runtime.flowId ?? runtime.handlerResult.execution.flowId,
    finalize: async (): Promise<ServerToolHandlerResult> => ({
      ...(runtime.handlerResult as ServerToolHandlerResult),
      ...(runtime.metadataWritePlan && typeof runtime.metadataWritePlan === 'object'
        ? { metadataWritePlan: runtime.metadataWritePlan }
        : {})
    })
  };
}

async function runBuiltinHandler(
  name: string,
  ctx: ServerToolHandlerContext
): Promise<{ flowId: string; finalize: () => Promise<ServerToolHandlerResult> } | null> {
  switch (name) {
    case 'stop_message_auto':
      return runBuiltinStopMessageAutoHandler(ctx);
    default:
      throw new Error(`[servertool] unsupported builtin handler runtime: ${name}`);
  }
}

export async function __executeBuiltinHandlerForRuntime(
  name: string,
  ctx: ServerToolHandlerContext
): Promise<{ flowId: string; finalize: () => Promise<ServerToolHandlerResult> } | null> {
  return runBuiltinHandler(name, ctx);
}

function readSkeletonOwnedRegistration(name: string): ServerToolHandlerRegistrationSpec | null {
  const spec = getServertoolToolSpec(name);
  if (!spec || spec.enabled === false) {
    return null;
  }
  const autoHook =
    spec.trigger.type === 'auto'
      ? {
          id: spec.name,
          phase: spec.trigger.phase ?? 'default',
          priority: spec.trigger.priority ?? 100
        }
      : undefined;
  return {
    name: spec.name,
    enabled: true,
    trigger: spec.trigger.type,
    executionMode: spec.execution.mode,
    stripAfterExecute: spec.execution.stripAfterExecute,
    ...(autoHook ? { autoHook } : {})
  };
}

export function getBuiltinHandlerEntry(name: string): ServerToolHandlerEntry | undefined {
  const registration = readSkeletonOwnedRegistration(name);
  if (!registration) {
    return undefined;
  }
  if (!isBuiltinRuntimeSupported(registration.name)) {
    return undefined;
  }
  const entry: ServerToolHandlerEntry = {
    name: registration.name,
    trigger: registration.trigger,
    execution: {
      kind: 'builtin',
      builtinName: registration.name
    },
    registration
  };
  if (registration.trigger === 'auto' && registration.autoHook) {
    entry.autoHook = {
      id: registration.autoHook.id,
      phase: registration.autoHook.phase,
      priority: registration.autoHook.priority,
      order: -1
    }
  }
  return entry;
}

export function listBuiltinHandlerNames(): string[] {
  return listServertoolToolSpecs()
    .filter((spec) => spec.enabled !== false)
    .map((spec) => spec.name.trim().toLowerCase())
    .filter((name) => isBuiltinRuntimeSupported(name))
    .sort();
}

export function listBuiltinAutoHandlerEntries(): ServerToolHandlerEntry[] {
  return listBuiltinHandlerNames()
    .map((name) => getBuiltinHandlerEntry(name))
    .filter((entry): entry is ServerToolHandlerEntry => Boolean(entry?.autoHook));
}
