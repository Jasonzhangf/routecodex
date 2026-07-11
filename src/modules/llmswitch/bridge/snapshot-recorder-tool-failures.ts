import type { AnyRecord } from './bridge-types.js';
import type { RuntimeErrorSignal, ToolExecutionFailureSignal } from './snapshot-recorder-types.js';
import { detectToolExecutionFailuresNative } from './native-exports.js';

const PARSE_ERROR_SIGNALS: Array<{ needle: string; errorType: string }> = [
  { needle: 'failed to parse function arguments', errorType: 'tool_args_parse_failed' },
  { needle: 'missing field `cmd`', errorType: 'tool_args_missing_cmd' },
  { needle: 'missing field `input`', errorType: 'tool_args_missing_input' },
  { needle: 'missing field `command`', errorType: 'tool_args_missing_command' },
  { needle: 'failed to decode sse payload', errorType: 'sse_decode_failed' },
  { needle: 'upstream sse terminated', errorType: 'sse_upstream_terminated' },
  { needle: 'does not support sse decoding', errorType: 'sse_protocol_unsupported' }
];

const EXEC_ERROR_SIGNALS: Array<{ needle: string; errorType: string }> = [
  { needle: 'apply_patch verification failed', errorType: 'apply_patch_verification_failed' },
  { needle: 'followup failed for flow', errorType: 'followup_execution_failed' },
  { needle: 'tool execution failed', errorType: 'tool_execution_failed' }
];

function clipText(input: string, max = 320): string {
  const text = String(input || '').trim();
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

export function classifyApplyPatchVerificationFailure(content: string): { errorType: string; matchedText: string } {
  const raw = String(content || '');
  const lower = raw.toLowerCase();
  const invalidHeaderTokenMatch = raw.match(
    /invalid hunk at line \d+,\s*'([^']+)' is not a valid hunk header/i
  );
  const invalidHeaderToken = invalidHeaderTokenMatch ? invalidHeaderTokenMatch[1].trim() : '';
  const invalidHeaderLower = invalidHeaderToken.toLowerCase();
  if (
    lower.includes('update file hunk for path') &&
    (lower.includes('is empty') || lower.includes('missing hunk body'))
  ) {
    return {
      errorType: 'apply_patch_empty_update_hunk',
      matchedText: clipText(raw)
    };
  }
  if (
    lower.includes('unexpected line found in update hunk') &&
    lower.includes("'@@'")
  ) {
    return {
      errorType: 'apply_patch_unexpected_hunk_line',
      matchedText: clipText(raw)
    };
  }
  if (
    invalidHeaderToken &&
    /^\*\*\*\s+\d+(?:,\d+)?\s+\*{4}$/i.test(invalidHeaderToken)
  ) {
    return {
      errorType: 'apply_patch_legacy_context_diff_hunk_header',
      matchedText: clipText(raw)
    };
  }
  if (
    invalidHeaderToken &&
    invalidHeaderLower.startsWith('*** update ') &&
    !invalidHeaderLower.startsWith('*** update file:')
  ) {
    return {
      errorType: 'apply_patch_legacy_update_header_missing_file_keyword',
      matchedText: clipText(raw)
    };
  }
  if (
    invalidHeaderToken &&
    invalidHeaderLower.startsWith('*** new file:')
  ) {
    return {
      errorType: 'apply_patch_legacy_new_file_header',
      matchedText: clipText(raw)
    };
  }
  if (
    invalidHeaderToken &&
    invalidHeaderLower.startsWith('*** start file:')
  ) {
    return {
      errorType: 'apply_patch_legacy_start_file_header',
      matchedText: clipText(raw)
    };
  }
  if (
    invalidHeaderToken &&
    invalidHeaderLower === '*** begin patch'
  ) {
    return {
      errorType: 'apply_patch_nested_begin_patch_marker',
      matchedText: clipText(raw)
    };
  }
  if (
    lower.includes("expected update hunk to start with a @@ context marker, got: '======='") ||
    lower.includes("expected update hunk to start with a @@ context marker, got: '<<<<<<<") ||
    lower.includes("expected update hunk to start with a @@ context marker, got: '>>>>>>>")
  ) {
    return {
      errorType: 'apply_patch_conflict_markers_or_merge_chunks',
      matchedText: clipText(raw)
    };
  }
  if (
    lower.includes('expected update hunk to start with a @@ context marker, got:')
  ) {
    return {
      errorType: 'apply_patch_missing_hunk_context_marker',
      matchedText: clipText(raw)
    };
  }
  if (lower.includes('failed to find context') && lower.includes('@@')) {
    return {
      errorType: 'apply_patch_gnu_line_number_context_not_found',
      matchedText: clipText(raw)
    };
  }
  if (
    invalidHeaderToken &&
    (invalidHeaderLower.startsWith('--- a/') ||
      invalidHeaderLower.startsWith('--- /dev/null') ||
      invalidHeaderLower.startsWith('+++ b/'))
  ) {
    return {
      errorType: 'apply_patch_mixed_gnu_diff_inside_begin_patch',
      matchedText: clipText(raw)
    };
  }
  if (lower.includes('failed to find expected lines in ')) {
    return {
      errorType: 'apply_patch_expected_lines_not_found',
      matchedText: clipText(raw)
    };
  }
  return {
    errorType: 'apply_patch_verification_failed',
    matchedText: clipText(raw)
  };
}

export function detectToolExecutionFailures(payload: AnyRecord): ToolExecutionFailureSignal[] {
  return detectToolExecutionFailuresNative(payload);
}

export function classifyRuntimeErrorSignalFromText(
  stage: string,
  message: string
): RuntimeErrorSignal | null {
  const lower = String(message || '').toLowerCase();
  if (!lower) {
    return null;
  }
  if (lower.includes('apply_patch verification failed')) {
    const resolved = classifyApplyPatchVerificationFailure(message);
    return {
      group: 'exec-error',
      errorType: resolved.errorType,
      matchedText: resolved.matchedText
    };
  }
  for (const signal of EXEC_ERROR_SIGNALS) {
    if (lower.includes(signal.needle)) {
      return {
        group: 'exec-error',
        errorType: signal.errorType,
        matchedText: signal.needle
      };
    }
  }
  for (const signal of PARSE_ERROR_SIGNALS) {
    if (lower.includes(signal.needle)) {
      return {
        group: 'parse-error',
        errorType: signal.errorType,
        matchedText: signal.needle
      };
    }
  }
  return null;
}

export function shouldLogClientToolErrorToConsole(failure: ToolExecutionFailureSignal): boolean {
  if (failure.toolName === 'apply_patch') {
    return (
      failure.errorType === 'apply_patch_args_missing_input' ||
      failure.errorType === 'apply_patch_args_missing_patch' ||
      failure.errorType === 'apply_patch_args_parse_failed'
    );
  }
  if (failure.toolName === 'exec_command') {
    return (
      failure.errorType === 'exec_command_args_missing_cmd' ||
      failure.errorType === 'exec_command_args_missing_input' ||
      failure.errorType === 'exec_command_args_parse_failed'
    );
  }
  return false;
}
