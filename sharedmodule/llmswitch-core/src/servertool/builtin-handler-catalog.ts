import type { ServerToolHandlerContext, ServerToolHandlerResult } from './types.js';
import type { ServerToolHandlerEntry } from './registry-types.js';
import type { JsonObject } from '../conversion/hub/types/json.js';
import {
  planServertoolBuiltinHandlerEntry,
  planServertoolBuiltinHandlerNames
} from './skeleton-config.js';
import { readNativeFunction } from '../native/router-hotpath/native-shared-conversion-semantics-core.js';

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

async function runStoplessAutoHandlerRuntimeNapi(
  ctx: ServerToolHandlerContext
): Promise<StoplessAutoHandlerRuntimeOutput> {
  const fn = readNativeFunction('runStoplessAutoHandlerRuntimeJson');
  if (!fn) {
    throw new Error('runStoplessAutoHandlerRuntimeJson native unavailable');
  }
  const raw = fn(JSON.stringify({
    base: ctx.base,
    requestId: ctx.requestId,
    runtimeMetadata: ctx.runtimeMetadata ?? null,
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
  const runtime = await runStoplessAutoHandlerRuntimeNapi(ctx);

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

export function getBuiltinHandlerEntry(name: string): ServerToolHandlerEntry | undefined {
  const plan = planServertoolBuiltinHandlerEntry(name);
  if (plan.action === 'return_none') {
    return undefined;
  }
  if (
    plan.action !== 'return_entry' ||
    !plan.entry ||
    typeof plan.entry !== 'object' ||
    Array.isArray(plan.entry)
  ) {
    throw new Error(`[servertool] invalid Rust builtin handler entry plan for ${name}`);
  }
  return plan.entry as unknown as ServerToolHandlerEntry;
}

export function listBuiltinHandlerNames(): string[] {
  return planServertoolBuiltinHandlerNames();
}

export function listBuiltinAutoHandlerEntries(): ServerToolHandlerEntry[] {
  return listBuiltinHandlerNames()
    .map((name) => getBuiltinHandlerEntry(name))
    .filter((entry): entry is ServerToolHandlerEntry => Boolean(entry?.autoHook));
}
