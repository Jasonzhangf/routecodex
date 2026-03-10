import type { RoutingInstructionState } from './routing-instructions.js';

export function serializePreCommandState(state: RoutingInstructionState): Record<string, unknown> {
  return {
    ...(typeof state.preCommandSource === 'string' && state.preCommandSource.trim()
      ? { preCommandSource: state.preCommandSource.trim() }
      : {}),
    ...(typeof state.preCommandScriptPath === 'string' && state.preCommandScriptPath.trim()
      ? { preCommandScriptPath: state.preCommandScriptPath.trim() }
      : {}),
    ...(typeof state.preCommandUpdatedAt === 'number' && Number.isFinite(state.preCommandUpdatedAt)
      ? { preCommandUpdatedAt: state.preCommandUpdatedAt }
      : {})
  };
}

export function deserializePreCommandState(
  data: Record<string, unknown>,
  state: RoutingInstructionState
): void {
  if (typeof data.preCommandSource === 'string' && data.preCommandSource.trim()) {
    state.preCommandSource = data.preCommandSource.trim();
  }
  if (typeof data.preCommandScriptPath === 'string' && data.preCommandScriptPath.trim()) {
    state.preCommandScriptPath = data.preCommandScriptPath.trim();
  }
  if (typeof data.preCommandUpdatedAt === 'number' && Number.isFinite(data.preCommandUpdatedAt)) {
    state.preCommandUpdatedAt = data.preCommandUpdatedAt;
  }
}
