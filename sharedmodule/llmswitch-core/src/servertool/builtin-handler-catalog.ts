import type { JsonObject } from '../conversion/hub/types/json.js';
import type { ServerToolHandlerContext, ServerToolHandlerResult } from './types.js';
import type { ServerToolHandlerEntry } from './registry-types.js';
import type { ServerToolHandlerRegistrationSpec } from './skeleton-config.js';
import { getServertoolToolSpec, listServertoolToolSpecs } from './skeleton-config.js';
import { readNativeFunction } from '../native/router-hotpath/native-shared-conversion-semantics-core.js';
import {
  applyStoplessMetadataCenterWritePlan,
} from './stopless-metadata-center-writer.js';
import { MetadataCenter } from '../../../../src/server/runtime/http-server/metadata-center/metadata-center.js';
import { buildMetadataCenterRustSnapshot } from '../../../../src/server/runtime/http-server/metadata-center/dualwrite-api.js';

type StoplessAutoHandlerRuntimeOutput = {
  action:
    | 'return_null'
    | 'return_terminal_final'
    | 'throw_goal_active_loop'
    | 'return_schema_fail_fast'
    | 'return_schema_allow_stop'
    | 'return_handler_plan';
  metadataWritePlan?: Record<string, unknown>;
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
  chatResponse?: Record<string, unknown>;
  execution?: Record<string, unknown>;
} & Record<string, unknown>;

function isBuiltinRuntimeSupported(name: string): boolean {
  switch (name.trim().toLowerCase()) {
    case 'stop_message_auto':
      return true;
    default:
      return false;
  }
}

async function runStoplessAutoHandlerRuntimeNapi(
  ctx: ServerToolHandlerContext
): Promise<StoplessAutoHandlerRuntimeOutput> {
  const fn = readNativeFunction('runStoplessAutoHandlerRuntimeJson');
  if (!fn) {
    throw new Error('runStoplessAutoHandlerRuntimeJson native unavailable');
  }
  const center = MetadataCenter.read(ctx.adapterContext as Record<string, unknown>)
    ?? MetadataCenter.read(((ctx.adapterContext as Record<string, unknown>).metadata as Record<string, unknown> | undefined));
  const runtimeMetadata = center
    ? {
        metadataCenterSnapshot: buildMetadataCenterRustSnapshot(ctx.adapterContext as Record<string, unknown>)
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

  switch (runtime.action) {
    case 'return_null':
      return null;
    case 'throw_goal_active_loop': {
      const err: Error & {
        code?: string;
        status?: number;
        repeatCount?: number;
        threshold?: number;
        goalContextCount?: number;
      } = Object.assign(
        new Error(runtime.error?.message ?? '[servertool] goal active stop loop detected'),
        {
          code: runtime.error?.code ?? 'GOAL_ACTIVE_STOP_LOOP_DETECTED',
          status: runtime.error?.status ?? 500,
          repeatCount: runtime.error?.repeatCount,
          threshold: runtime.error?.threshold,
          goalContextCount: runtime.error?.goalContextCount
        }
      );
      throw err;
    }
    case 'return_terminal_final':
    case 'return_schema_fail_fast':
    case 'return_schema_allow_stop':
      return {
        flowId: runtime.flowId ?? 'stop_message_flow',
        finalize: async (): Promise<ServerToolHandlerResult> => ({
          chatResponse: (runtime.chatResponse ?? ctx.base) as JsonObject,
          execution: (runtime.execution ?? {
            flowId: runtime.flowId ?? 'stop_message_flow',
            context: { stopMessageTerminalFinal: true }
          }) as any
        })
      };
    case 'return_handler_plan':
      return {
        flowId: runtime.flowId ?? 'stop_message_flow',
        finalize: async (): Promise<ServerToolHandlerResult> => ({
          chatResponse: (runtime.chatResponse ?? ctx.base) as JsonObject,
          execution: (runtime.execution ?? {
            flowId: runtime.flowId ?? 'stop_message_flow',
            context: {}
          }) as any
        })
      };
    default:
      return null;
  }
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
