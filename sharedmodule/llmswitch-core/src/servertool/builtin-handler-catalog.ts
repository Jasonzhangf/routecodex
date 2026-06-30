import type { ServerToolHandlerContext, ServerToolHandlerResult } from './types.js';
import type { ServerToolHandlerEntry } from './registry-types.js';
import {
  planServertoolBuiltinAutoHandlerEntriesWithNative,
  resolveServertoolBuiltinHandlerEntryWithNative
} from '../native/router-hotpath/native-chat-process-servertool-orchestration-semantics.js';
import { runStoplessBuiltinHandlerForRuntimeWithNative } from '../native/router-hotpath/native-servertool-core-semantics.js';

export async function __executeBuiltinHandlerForRuntime(
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

export function getBuiltinHandlerEntry(name: string): ServerToolHandlerEntry | undefined {
  const entry = resolveServertoolBuiltinHandlerEntryWithNative({ name });
  if (!entry) {
    return undefined;
  }
  return entry as unknown as ServerToolHandlerEntry;
}

export function listBuiltinAutoHandlerEntries(): ServerToolHandlerEntry[] {
  return planServertoolBuiltinAutoHandlerEntriesWithNative().entries as unknown as ServerToolHandlerEntry[];
}
