import type { AnyRecord } from './module-loader.js';
import type { RuntimeErrorSignal, ToolExecutionFailureSignal } from './snapshot-recorder-types.js';

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

const MAX_TRAILING_TOOL_MESSAGES = 8;

function looksLikeToolOutputTranscript(content: string): boolean {
  const raw = String(content || '');
  if (!raw) return false;
  const lower = raw.toLowerCase();
  if (!lower.includes('chunk id:')) {
    return false;
  }
  if (!lower.includes('wall time:')) {
    return false;
  }
  if (!lower.includes('process exited with code')) {
    return false;
  }
  if (!lower.includes('output:') && !lower.includes('original token count:')) {
    return false;
  }
  return true;
}

function resolveExecCommandFailure(content: string): { errorType: string; matchedText: string } | null {
  const raw = String(content || '');
  const lower = raw.toLowerCase();
  if (looksLikeToolOutputTranscript(raw)) {
    return null;
  }
  if (lower.includes('failed to parse function arguments')) {
    if (lower.includes('missing field `cmd`')) {
      return {
        errorType: 'exec_command_args_missing_cmd',
        matchedText: 'missing field `cmd`'
      };
    }
    if (lower.includes('missing field `input`')) {
      return {
        errorType: 'exec_command_args_missing_input',
        matchedText: 'missing field `input`'
      };
    }
    return {
      errorType: 'exec_command_args_parse_failed',
      matchedText: clipText(raw)
    };
  }
  const nonZeroExit = raw.match(/process exited with code\s+(-?\d+)/i);
  if (nonZeroExit) {
    const code = Number(nonZeroExit[1]);
    if (Number.isFinite(code) && code !== 0) {
      return {
        errorType: 'exec_command_non_zero_exit',
        matchedText: `process exited with code ${code}`
      };
    }
  }
  if (lower.includes('exec_command failed')) {
    return {
      errorType: 'exec_command_failed',
      matchedText: clipText(raw)
    };
  }
  return null;
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

function resolveApplyPatchFailure(content: string): { errorType: string; matchedText: string } | null {
  const raw = String(content || '');
  const lower = raw.toLowerCase();
  if (looksLikeToolOutputTranscript(raw)) {
    return null;
  }
  if (lower.includes('failed to parse function arguments')) {
    if (lower.includes('missing field `input`')) {
      return {
        errorType: 'apply_patch_args_missing_input',
        matchedText: 'missing field `input`'
      };
    }
    if (lower.includes('missing field `patch`')) {
      return {
        errorType: 'apply_patch_args_missing_patch',
        matchedText: 'missing field `patch`'
      };
    }
    return {
      errorType: 'apply_patch_args_parse_failed',
      matchedText: clipText(raw)
    };
  }
  if (lower.includes('apply_patch verification failed')) {
    return classifyApplyPatchVerificationFailure(raw);
  }
  if (lower.includes('apply_patch failed') || lower.includes('invalid patch')) {
    return {
      errorType: 'apply_patch_failed',
      matchedText: clipText(raw)
    };
  }
  return null;
}

function resolveShellCommandFailure(content: string): { errorType: string; matchedText: string } | null {
  const raw = String(content || '');
  const lower = raw.toLowerCase();
  if (looksLikeToolOutputTranscript(raw)) {
    return null;
  }
  if (lower.includes('missing field `command`')) {
    return {
      errorType: 'shell_command_args_missing_command',
      matchedText: 'missing field `command`'
    };
  }
  if (lower.includes('missing field `cmd`')) {
    return {
      errorType: 'shell_command_args_missing_cmd',
      matchedText: 'missing field `cmd`'
    };
  }
  if (lower.includes('missing field `input`')) {
    return {
      errorType: 'shell_command_args_missing_input',
      matchedText: 'missing field `input`'
    };
  }
  if (lower.includes('failed to parse function arguments')) {
    return {
      errorType: 'shell_command_args_parse_failed',
      matchedText: clipText(raw)
    };
  }
  return null;
}

export function collectToolMessages(payload: AnyRecord): Array<Record<string, unknown>> {
  const directCandidates: Array<unknown> = [];
  const pushArray = (value: unknown) => {
    if (Array.isArray(value)) {
      directCandidates.push(value);
    }
  };

  pushArray(payload?.messages);
  pushArray(payload?.input);
  pushArray((payload as Record<string, unknown> | undefined)?.payload);
  pushArray((payload as Record<string, unknown> | undefined)?.governedPayload);

  const payloadRecord = payload as Record<string, unknown> | undefined;
  if (payloadRecord && typeof payloadRecord === 'object') {
    const nestedPayload = payloadRecord.payload;
    if (nestedPayload && typeof nestedPayload === 'object' && !Array.isArray(nestedPayload)) {
      pushArray((nestedPayload as Record<string, unknown>).messages);
      pushArray((nestedPayload as Record<string, unknown>).input);
    }
    const governedPayload = payloadRecord.governedPayload;
    if (
      governedPayload &&
      typeof governedPayload === 'object' &&
      !Array.isArray(governedPayload)
    ) {
      pushArray((governedPayload as Record<string, unknown>).messages);
      pushArray((governedPayload as Record<string, unknown>).input);
    }
  }

  const dedup = new Set<Record<string, unknown>>();
  const collected: Array<Record<string, unknown>> = [];

  for (const candidate of directCandidates) {
    if (!Array.isArray(candidate) || candidate.length <= 0) {
      continue;
    }
    let seenTrailingTool = 0;
    for (let index = candidate.length - 1; index >= 0; index -= 1) {
      const row = candidate[index];
      if (!row || typeof row !== 'object' || Array.isArray(row)) {
        if (seenTrailingTool > 0) {
          break;
        }
        continue;
      }
      const record = row as Record<string, unknown>;
      const role = typeof record.role === 'string' ? record.role.trim().toLowerCase() : '';
      const name = typeof record.name === 'string' ? record.name.trim().toLowerCase() : '';
      const content = typeof record.content === 'string' ? record.content : '';
      if (role && role !== 'tool') {
        break;
      }
      if (role === 'tool' && name && content) {
        seenTrailingTool += 1;
        if (!dedup.has(record)) {
          dedup.add(record);
          collected.unshift(record);
        }
        if (seenTrailingTool >= MAX_TRAILING_TOOL_MESSAGES) {
          break;
        }
        continue;
      }
      if (seenTrailingTool > 0) {
        break;
      }
    }
  }

  return collected;
}

export function detectToolExecutionFailures(payload: AnyRecord): ToolExecutionFailureSignal[] {
  const failures: ToolExecutionFailureSignal[] = [];
  const dedup = new Set<string>();
  for (const msg of collectToolMessages(payload)) {
    const rawToolName = typeof msg.name === 'string' ? msg.name.trim().toLowerCase() : '';
    const toolName =
      rawToolName === 'shell' || rawToolName === 'bash' || rawToolName === 'terminal'
        ? 'shell_command'
        : rawToolName;
    if (toolName !== 'exec_command' && toolName !== 'apply_patch' && toolName !== 'shell_command') {
      continue;
    }
    const content = typeof msg.content === 'string' ? msg.content : '';
    const resolver =
      toolName === 'exec_command'
        ? resolveExecCommandFailure(content)
        : toolName === 'apply_patch'
          ? resolveApplyPatchFailure(content)
          : resolveShellCommandFailure(content);
    if (!resolver) {
      continue;
    }
    const toolCallId = typeof msg.tool_call_id === 'string' ? msg.tool_call_id : undefined;
    const callId = typeof msg.call_id === 'string' ? msg.call_id : undefined;
    const key = [toolName, resolver.errorType, resolver.matchedText, toolCallId || '', callId || ''].join('|');
    if (dedup.has(key)) {
      continue;
    }
    dedup.add(key);
    failures.push({
      toolName: toolName as 'exec_command' | 'apply_patch' | 'shell_command',
      errorType: resolver.errorType,
      matchedText: resolver.matchedText,
      toolCallId,
      callId
    });
  }
  return failures;
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
