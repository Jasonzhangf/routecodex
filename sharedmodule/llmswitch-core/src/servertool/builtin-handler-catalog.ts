import type { ServerToolHandlerContext, ServerToolHandlerResult } from './types.js';
import type { ServerToolHandlerEntry } from './registry-types.js';
import {
  planServertoolBuiltinHandlerEntry,
  planServertoolBuiltinHandlerNames
} from './skeleton-config.js';
import { readNativeFunction } from '../native/router-hotpath/native-shared-conversion-semantics-core.js';

async function runStoplessBuiltinHandlerForRuntimeNapi(
  ctx: ServerToolHandlerContext
): Promise<ServerToolHandlerResult | null> {
  const fn = readNativeFunction('runStoplessBuiltinHandlerForRuntimeJson');
  if (!fn) {
    throw new Error('runStoplessBuiltinHandlerForRuntimeJson native unavailable');
  }
  const raw = fn(JSON.stringify({
    base: ctx.base,
    requestId: ctx.requestId,
    runtimeMetadata: ctx.runtimeMetadata ?? null,
  }));
  if (typeof raw === 'string') {
    return JSON.parse(raw) as ServerToolHandlerResult | null;
  }
  if (raw === null || (raw && typeof raw === 'object' && !Array.isArray(raw))) {
    return raw as ServerToolHandlerResult | null;
  }
  throw new Error(`runStoplessBuiltinHandlerForRuntimeJson native returned unsupported payload: ${typeof raw}`);
}

async function runBuiltinHandler(
  name: string,
  ctx: ServerToolHandlerContext
): Promise<ServerToolHandlerResult | null> {
  if (name === 'stop_message_auto') {
    return runStoplessBuiltinHandlerForRuntimeNapi(ctx);
  }
  throw new Error(`[servertool] unsupported builtin handler runtime: ${name}`);
}

export async function __executeBuiltinHandlerForRuntime(
  name: string,
  ctx: ServerToolHandlerContext
): Promise<ServerToolHandlerResult | null> {
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

export function listBuiltinHandlerRecordEntries(): ServerToolHandlerEntry[] {
  return listBuiltinHandlerNames()
    .map((name) => getBuiltinHandlerEntry(name))
    .filter((entry): entry is ServerToolHandlerEntry => Boolean(entry));
}
