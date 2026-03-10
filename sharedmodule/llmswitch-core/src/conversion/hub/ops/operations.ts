import type { StandardizedRequest, StandardizedTool } from '../types/standardized.js';
import { applyHubOperationsWithNative } from '../../../router/virtual-router/engine-selection/native-hub-pipeline-req-process-semantics.js';

export type HubOperation =
  | {
      op: 'set_request_metadata_fields';
      fields: Record<string, unknown>;
    }
  | {
      op: 'unset_request_metadata_keys';
      keys: string[];
    }
  | {
      op: 'set_request_parameter_fields';
      fields: Record<string, unknown>;
    }
  | {
      op: 'unset_request_parameter_keys';
      keys: string[];
    }
  | {
      op: 'append_tool_if_missing';
      toolName: string;
      tool: StandardizedTool;
    };

export function applyHubOperations<T extends StandardizedRequest>(request: T, ops: HubOperation[]): T {
  if (!ops || ops.length === 0) {
    return request;
  }
  return applyHubOperationsWithNative(
    request as unknown as Record<string, unknown>,
    ops as unknown as unknown[]
  ) as unknown as T;
}
