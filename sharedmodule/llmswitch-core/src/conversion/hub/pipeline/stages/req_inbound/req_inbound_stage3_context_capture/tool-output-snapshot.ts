import type { JsonObject } from '../../../../types/json.js';
import {
  buildReqInboundToolOutputSnapshotWithNative,
  collectReqInboundToolOutputsWithNative
} from '../../../../../../router/virtual-router/engine-selection/native-hub-pipeline-req-inbound-semantics.js';

type ToolOutputItem = { tool_call_id: string; call_id: string; output?: string; name?: string };

export function buildToolOutputSnapshot(
  payload: JsonObject,
  providerProtocol?: string
): Record<string, unknown> {
  return buildReqInboundToolOutputSnapshotWithNative(
    payload as unknown as Record<string, unknown>,
    providerProtocol
  );
}

export function collectToolOutputs(payload: JsonObject): ToolOutputItem[] {
  return collectReqInboundToolOutputsWithNative(payload).map((entry) => ({
    tool_call_id: entry.tool_call_id,
    call_id: entry.call_id,
    ...(typeof entry.output === 'string' ? { output: entry.output } : {}),
    ...(typeof entry.name === 'string' ? { name: entry.name } : {})
  }));
}
