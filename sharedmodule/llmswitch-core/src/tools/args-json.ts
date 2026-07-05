import { parseToolArgsJsonWithArtifactRepairWithNative } from '../native/router-hotpath/native-shared-conversion-semantics-toolcalls.js';

/**
 * Parse tool arguments JSON with artifact repair.
 *
 * Rust owner: `resp_process_stage1_tool_governance_blocks::json_args`.
 * TS must stay a fail-fast native facade; no local regex/repair semantics here.
 */
export function parseToolArgsJson(input: unknown): unknown {
  return parseToolArgsJsonWithArtifactRepairWithNative(input);
}
