import { normalizeExecCommandArgsWithNative } from '../../native/router-hotpath/native-shared-conversion-semantics-toolcalls.js';

type UnknownRecord = Record<string, unknown>;

export type ExecCommandNormalizeResult =
  | { ok: true; normalized: UnknownRecord }
  | { ok: false; reason: 'missing_cmd'; normalized: UnknownRecord };

export type ExecCommandNormalizeOptions = {
  schemaMode?: 'compat' | 'canonical';
};

// Rust owner: `resp_process_stage1_tool_governance_blocks::exec_command_args`.
// TS must stay a fail-fast native facade; no local alias/unwrap/field mapping here.
export function normalizeExecCommandArgs(
  args: unknown,
  options?: ExecCommandNormalizeOptions
): ExecCommandNormalizeResult {
  return normalizeExecCommandArgsWithNative(args, {
    schemaMode: options?.schemaMode === 'canonical' ? 'canonical' : 'compat'
  });
}
