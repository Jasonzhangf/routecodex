import type { RoutingInstruction, RoutingInstructionState } from './routing-instructions.js';

export function applyPreCommandInstructionToState(
  instruction: RoutingInstruction,
  state: RoutingInstructionState
): boolean {
  switch (instruction.type) {
    case 'preCommandSet': {
      const scriptPath =
        typeof instruction.preCommandScriptPath === 'string' && instruction.preCommandScriptPath.trim()
          ? instruction.preCommandScriptPath.trim()
          : '';
      if (!scriptPath) {
        return true;
      }
      state.preCommandScriptPath = scriptPath;
      state.preCommandSource = 'explicit';
      state.preCommandUpdatedAt = Date.now();
      return true;
    }
    case 'preCommandClear':
      clearPreCommandState(state);
      return true;
    default:
      return false;
  }
}

export function clearPreCommandState(state: RoutingInstructionState): void {
  state.preCommandScriptPath = undefined;
  state.preCommandSource = undefined;
  state.preCommandUpdatedAt = undefined;
}
