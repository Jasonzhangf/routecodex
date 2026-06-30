import type { ServerToolHandlerContext, ServerToolHandlerResult } from './types.js';
import type { ServerToolHandlerEntry } from './registry-types.js';
import {
  planServertoolBuiltinAutoHandlerEntriesWithNative,
  planServertoolBuiltinHandlerNamesWithNative,
  planServertoolBuiltinHandlerRecordEntriesWithNative,
  resolveServertoolBuiltinHandlerEntryWithNative
} from '../native/router-hotpath/native-chat-process-servertool-orchestration-semantics.js';
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
  const entry = resolveServertoolBuiltinHandlerEntryWithNative({ name });
  if (!entry) {
    return undefined;
  }
  return entry as unknown as ServerToolHandlerEntry;
}

export function listBuiltinHandlerNames(): string[] {
  return planServertoolBuiltinHandlerNamesWithNative().names;
}

export function listBuiltinAutoHandlerEntries(): ServerToolHandlerEntry[] {
  return planServertoolBuiltinAutoHandlerEntriesWithNative().entries as unknown as ServerToolHandlerEntry[];
}

export function listBuiltinHandlerRecordEntries(): ServerToolHandlerEntry[] {
  return planServertoolBuiltinHandlerRecordEntriesWithNative().entries as unknown as ServerToolHandlerEntry[];
}
