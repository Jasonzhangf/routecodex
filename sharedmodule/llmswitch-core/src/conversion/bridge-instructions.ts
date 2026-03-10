import { ensureBridgeInstructionsWithNative } from '../router/virtual-router/engine-selection/native-shared-conversion-semantics.js';

export function ensureBridgeInstructions(payload: Record<string, unknown>): string | undefined {
  const normalized = ensureBridgeInstructionsWithNative(payload);
  if (normalized && typeof normalized === 'object') {
    if (Object.prototype.hasOwnProperty.call(normalized, 'input')) {
      (payload as any).input = (normalized as any).input;
    }
    if (Object.prototype.hasOwnProperty.call(normalized, 'instructions')) {
      (payload as any).instructions = (normalized as any).instructions;
    } else if (Object.prototype.hasOwnProperty.call(payload, 'instructions')) {
      delete (payload as any).instructions;
    }
  }
  const instructions = (payload as any).instructions;
  return typeof instructions === 'string' && instructions.length ? instructions : undefined;
}
