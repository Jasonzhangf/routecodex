import { failNativeRequired } from '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-router-hotpath-loader.js';
import {
  parseJson,
  parseRecord,
  readNativeFunction,
  resolveRccUserDirWithNative as resolveRccUserDir,
  safeStringify,
} from '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-shared-conversion-semantics-core.js';
import type { RoutingInstruction } from '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-virtual-router-routing-state.js';

type StandardizedMessage = {
  role?: unknown;
  content?: unknown;
  [key: string]: unknown;
};

function stringifyForNative(capability: string, value: unknown): string {
  return safeStringify(value) ?? failNativeRequired<string>(capability, 'json stringify failed');
}

function parseRecordArrayPayload(raw: string): Array<Record<string, unknown>> | null {
  const parsed = parseJson(raw);
  if (!Array.isArray(parsed)) {
    return null;
  }
  const records = parsed.filter(
    (entry) => entry && typeof entry === 'object' && !Array.isArray(entry)
  ) as Array<Record<string, unknown>>;
  return records.length === parsed.length ? records : null;
}

function readLatestUserMessageText(messages: StandardizedMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (!message || message.role !== 'user' || typeof message.content !== 'string') {
      continue;
    }
    const trimmed = message.content.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return '';
}

export function parseRoutingInstructions(messages: StandardizedMessage[]): RoutingInstruction[] {
  if (!Array.isArray(messages) || messages.length === 0) {
    return [];
  }
  const capability = 'parseRoutingInstructionsJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    return failNativeRequired<RoutingInstruction[]>(capability);
  }
  try {
    const result = fn(
      stringifyForNative(capability, messages),
      stringifyForNative(capability, { rccUserDir: resolveRccUserDir() }),
    );
    if (typeof result !== 'string' || !result) {
      return failNativeRequired<RoutingInstruction[]>(capability, 'empty result');
    }
    const instructions = parseRecordArrayPayload(result);
    if (!instructions) {
      return failNativeRequired<RoutingInstruction[]>(capability, 'invalid payload');
    }
    const latestUserMessage = readLatestUserMessageText(messages);
    if (!latestUserMessage || !latestUserMessage.includes('\u200BstopMessage')) {
      return instructions as unknown as RoutingInstruction[];
    }
    return (instructions as unknown as RoutingInstruction[]).filter((inst) => !(
      inst.type === 'stopMessageSet' ||
      inst.type === 'stopMessageMode' ||
      inst.type === 'stopMessageClear'
    ));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return failNativeRequired<RoutingInstruction[]>(capability, reason);
  }
}

export function applyRoutingInstructionsWithNative(input: {
  instructions: Array<Record<string, unknown>>;
  state: Record<string, unknown>;
}): Record<string, unknown> {
  const capability = 'applyRoutingInstructionsJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    return failNativeRequired<Record<string, unknown>>(capability);
  }
  try {
    const result = fn(stringifyForNative(capability, input));
    if (typeof result !== 'string' || !result) {
      return failNativeRequired<Record<string, unknown>>(capability, 'empty result');
    }
    return parseRecord(result) ?? failNativeRequired<Record<string, unknown>>(capability, 'invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return failNativeRequired<Record<string, unknown>>(capability, reason);
  }
}
