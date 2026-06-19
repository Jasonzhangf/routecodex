/**
 * stopless goal state persistence from merged metadata.
 * Reads stopless goal state from MetadataCenter and persists to llmswitch bridge.
 */
import { persistStoplessGoalStateSnapshot } from '../../../../modules/llmswitch/bridge.js';
import { readRuntimeRequestTruthIdentifiers } from '../metadata-center/request-truth-readers.js';
import { MetadataCenter } from '../metadata-center/metadata-center.js';
import { readString } from './request-executor-error-shared.js';

export function asFlatRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function persistGoalStateFromMergedMetadata(mergedMetadata: Record<string, unknown> | undefined): void {
  const metadata = asFlatRecord(mergedMetadata);
  const runtimeControl = MetadataCenter.read(metadata)?.readRuntimeControl();
  const goalState = asFlatRecord(runtimeControl?.stoplessGoal?.state);
  const status = readString(goalState?.status);
  const objective = readString(goalState?.objective);
  if (!goalState || !status || !objective) {
    return;
  }

  const requestTruth = readRuntimeRequestTruthIdentifiers(metadata);
  const adapterContext: Record<string, unknown> = {
    ...(readString(metadata?.clientTmuxSessionId) ? { clientTmuxSessionId: readString(metadata?.clientTmuxSessionId) } : {}),
    ...(readString(metadata?.client_tmux_session_id) ? { client_tmux_session_id: readString(metadata?.client_tmux_session_id) } : {}),
    ...(readString(metadata?.tmuxSessionId) ? { tmuxSessionId: readString(metadata?.tmuxSessionId) } : {}),
    ...(readString(metadata?.tmux_session_id) ? { tmux_session_id: readString(metadata?.tmux_session_id) } : {}),
    ...(requestTruth.sessionId ? { sessionId: requestTruth.sessionId } : {}),
    ...(requestTruth.conversationId ? { conversationId: requestTruth.conversationId } : {})
  };
  const metadataCenter = MetadataCenter.read(metadata);
  if (metadataCenter) {
    MetadataCenter.bind(adapterContext, metadataCenter);
  }
  const explicitScope = readString(runtimeControl?.stopMessageClientInject?.sessionScope);
  if (Object.keys(adapterContext).length === 0 && !explicitScope) {
    return;
  }
  persistStoplessGoalStateSnapshot(adapterContext, goalState);
}
