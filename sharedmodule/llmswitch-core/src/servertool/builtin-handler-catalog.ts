import type { ServerToolHandlerContext, ServerToolHandlerResult } from './types.js';
import type { ServerToolHandlerEntry } from './registry-types.js';
import {
  planServertoolBuiltinAutoHandlerEntries,
  planServertoolBuiltinHandlerRecordEntries,
  planServertoolBuiltinHandlerNames,
  resolveServertoolBuiltinHandlerEntry
} from './skeleton-config.js';
import { runStoplessBuiltinHandlerForRuntimeWithNative } from '../native/router-hotpath/native-servertool-core-semantics.js';

async function runBuiltinHandlerForRuntimeNapi(
  name: string,
  ctx: ServerToolHandlerContext
): Promise<ServerToolHandlerResult | null> {
  return runStoplessBuiltinHandlerForRuntimeWithNative({
    name,
    base: ctx.base,
    requestId: ctx.requestId,
    runtimeMetadata: ctx.runtimeMetadata ?? null
  }) as ServerToolHandlerResult | null;
}

async function runBuiltinHandler(
  name: string,
  ctx: ServerToolHandlerContext
): Promise<ServerToolHandlerResult | null> {
  return runBuiltinHandlerForRuntimeNapi(name, ctx);
}

export async function __executeBuiltinHandlerForRuntime(
  name: string,
  ctx: ServerToolHandlerContext
): Promise<ServerToolHandlerResult | null> {
  return runBuiltinHandler(name, ctx);
}

export function getBuiltinHandlerEntry(name: string): ServerToolHandlerEntry | undefined {
  const entry = resolveServertoolBuiltinHandlerEntry(name);
  if (!entry) {
    return undefined;
  }
  return entry as unknown as ServerToolHandlerEntry;
}

export function listBuiltinHandlerNames(): string[] {
  return planServertoolBuiltinHandlerNames();
}

export function listBuiltinAutoHandlerEntries(): ServerToolHandlerEntry[] {
  return planServertoolBuiltinAutoHandlerEntries() as unknown as ServerToolHandlerEntry[];
}

export function listBuiltinHandlerRecordEntries(): ServerToolHandlerEntry[] {
  return planServertoolBuiltinHandlerRecordEntries() as unknown as ServerToolHandlerEntry[];
}
