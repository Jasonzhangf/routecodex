import type { StandardizedMessage } from '../../../conversion/hub/types/standardized.js';
import type { RoutingInstruction } from './types.js';
import { parseRoutingInstructionsWithNative } from '../engine-selection/native-virtual-router-routing-instructions-semantics.js';

export function parseRoutingInstructions(messages: StandardizedMessage[]): RoutingInstruction[] {
  if (!Array.isArray(messages) || messages.length === 0) {
    return [];
  }
  return parseRoutingInstructionsWithNative(messages as unknown as Array<Record<string, unknown>>) as unknown as RoutingInstruction[];
}

export function parseAndPreprocessRoutingInstructions(messages: StandardizedMessage[]): RoutingInstruction[] {
  const rawInstructions = parseRoutingInstructions(messages);
  if (rawInstructions.length === 0) {
    return [];
  }
  const clearIndex = rawInstructions.findIndex((inst) => inst.type === 'clear');
  if (clearIndex < 0) {
    return rawInstructions;
  }
  return rawInstructions.slice(clearIndex + 1);
}

export function extractClearInstruction(messages: StandardizedMessage[]): boolean {
  return parseRoutingInstructions(messages).some((inst) => inst.type === 'clear');
}

export function extractStopMessageClearInstruction(messages: StandardizedMessage[]): boolean {
  return parseRoutingInstructions(messages).some((inst) => inst.type === 'stopMessageClear');
}
