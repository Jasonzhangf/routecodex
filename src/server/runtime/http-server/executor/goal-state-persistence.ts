/**
 * stopless goal state persistence from merged metadata.
 * Reads stoplessGoalState from pipeline metadata and persists to llmswitch bridge.
 */
import { persistStoplessGoalStateSnapshot } from '../../../../modules/llmswitch/bridge.js';
import { readRuntimeRequestTruthIdentifiers } from '../metadata-center/request-truth-readers.js';
import { readString } from './request-executor-error-shared.js';

export function asFlatRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function persistGoalStateFromMergedMetadata(mergedMetadata: Record<string, unknown> | undefined): void {
  const metadata = asFlatRecord(mergedMetadata);
  const goalState = asFlatRecord(metadata?.stoplessGoalState);
  const status = readString(goalState?.status);
  const objective = readString(goalState?.objective);
  if (!goalState || !status || !objective) {
    return;
  }

  const explicitScope =
    readString(metadata?.stopMessageClientInjectSessionScope)
    ?? readString(metadata?.stopMessageClientInjectScope);
  const requestTruth = readRuntimeRequestTruthIdentifiers(metadata);
  const adapterContext: Record<string, unknown> = {
    ...(explicitScope ? { stopMessageClientInjectSessionScope: explicitScope } : {}),
    ...(readString(metadata?.clientTmuxSessionId) ? { clientTmuxSessionId: readString(metadata?.clientTmuxSessionId) } : {}),
    ...(readString(metadata?.client_tmux_session_id) ? { client_tmux_session_id: readString(metadata?.client_tmux_session_id) } : {}),
    ...(readString(metadata?.tmuxSessionId) ? { tmuxSessionId: readString(metadata?.tmuxSessionId) } : {}),
    ...(readString(metadata?.tmux_session_id) ? { tmux_session_id: readString(metadata?.tmux_session_id) } : {}),
    ...(requestTruth.sessionId ? { sessionId: requestTruth.sessionId } : {}),
    ...(requestTruth.conversationId ? { conversationId: requestTruth.conversationId } : {})
  };
  if (Object.keys(adapterContext).length === 0) {
    return;
  }
  persistStoplessGoalStateSnapshot(adapterContext, goalState);
}
