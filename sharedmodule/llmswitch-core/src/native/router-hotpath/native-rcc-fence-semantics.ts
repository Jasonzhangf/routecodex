import type { StoplessGoalStateSnapshot } from '../../router/virtual-router/routing-instructions.js';
import { failNativeRequired } from './native-router-hotpath-policy.js';
import { parseRecord, readNativeFunction, safeStringify } from './native-shared-conversion-semantics-core.js';

export type RccFenceBlock = {
  raw: string;
  startOffset: number;
  endOffset: number;
  commandLine: string;
  domain: string;
  action: string;
  args: string[];
  body: string;
};

export type RccDirective = {
  directiveType: string;
  domain: string;
  action: string;
  args: string[];
  body: string;
  passthrough: 'body-forward' | 'private-only' | 'state-only' | string;
};

export type RccFenceDocument = {
  blocks: RccFenceBlock[];
  directives: RccDirective[];
};

export type StoplessGoalDirectiveTransitionInput = {
  currentState?: StoplessGoalStateSnapshot;
  directive: RccDirective;
  nowMs?: number | null;
};

function parseRccFenceDocumentPayload(raw: string): RccFenceDocument | null {
  const parsed = parseRecord(raw);
  if (!parsed) {
    return null;
  }
  if (!Array.isArray(parsed.blocks) || !Array.isArray(parsed.directives)) {
    return null;
  }
  return parsed as unknown as RccFenceDocument;
}

function parseStoplessGoalStatePayload(raw: string): StoplessGoalStateSnapshot | null {
  const parsed = parseRecord(raw);
  if (!parsed) {
    return null;
  }
  if (typeof parsed.status !== 'string' || typeof parsed.objective !== 'string') {
    return null;
  }
  return parsed as unknown as StoplessGoalStateSnapshot;
}

export function parseRccFenceDocumentWithNative(text: string): RccFenceDocument {
  const capability = 'parseRccFenceDocumentJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    return failNativeRequired<RccFenceDocument>(capability);
  }
  try {
    const result = fn(text);
    if (typeof result !== 'string' || !result) {
      return failNativeRequired<RccFenceDocument>(capability, 'empty result');
    }
    return parseRccFenceDocumentPayload(result)
      ?? failNativeRequired<RccFenceDocument>(capability, 'invalid payload');
  } catch (error) {
    return failNativeRequired<RccFenceDocument>(
      capability,
      error instanceof Error ? error.message : String(error ?? 'unknown')
    );
  }
}

export function applyStoplessGoalDirectiveWithNative(
  input: StoplessGoalDirectiveTransitionInput
): StoplessGoalStateSnapshot {
  const capability = 'applyStoplessGoalDirectiveJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    return failNativeRequired<StoplessGoalStateSnapshot>(capability);
  }
  const payloadJson = safeStringify(input);
  if (!payloadJson) {
    return failNativeRequired<StoplessGoalStateSnapshot>(capability, 'json stringify failed');
  }
  try {
    const result = fn(payloadJson);
    if (typeof result !== 'string' || !result) {
      return failNativeRequired<StoplessGoalStateSnapshot>(capability, 'empty result');
    }
    return parseStoplessGoalStatePayload(result)
      ?? failNativeRequired<StoplessGoalStateSnapshot>(capability, 'invalid payload');
  } catch (error) {
    return failNativeRequired<StoplessGoalStateSnapshot>(
      capability,
      error instanceof Error ? error.message : String(error ?? 'unknown')
    );
  }
}
