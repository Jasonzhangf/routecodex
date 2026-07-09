import { parseToolArgsJson } from '../../../sharedmodule/llmswitch-core/src/tools/args-json.js';
import {
  validateExecCommandArgs,
  type ExecCommandValidationOptions,
} from '../../../sharedmodule/llmswitch-core/src/tools/exec-command/validator.js';
import { readNativeFunction } from '../../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-shared-conversion-semantics-core.js';

type UnknownRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function shouldPassApplyPatchRecordToNative(value: unknown): value is UnknownRecord {
  if (!isRecord(value)) {
    return false;
  }
  const keys = Object.keys(value);
  if (keys.length === 0) {
    return true;
  }
  const nestedInput = value.input;
  return typeof value.patch === 'string'
    || typeof value.input === 'string'
    || typeof value.filePath === 'string'
    || typeof value.file_path === 'string'
    || (isRecord(nestedInput)
      && (typeof nestedInput.patch === 'string'
        || typeof nestedInput.input === 'string'
        || typeof nestedInput.filePath === 'string'
        || typeof nestedInput.file_path === 'string'))
    || Array.isArray(value.changes)
    || typeof value.instructions === 'string'
    || typeof value.file === 'string'
    || typeof value.path === 'string'
    || typeof value.filepath === 'string'
    || typeof value.filename === 'string'
    || typeof value.style === 'string'
    || typeof value.onClick === 'string'
    || typeof value.cmd === 'string'
    || typeof value.command === 'string';
}

function validateApplyPatchArgumentsDirectNative(applyPatchArgsSource: unknown): {
  ok: boolean;
  reason?: string;
  message?: string;
  normalizedArgs?: string;
} {
  const fn = readNativeFunction('validateApplyPatchArgumentsJson');
  if (!fn) {
    throw new Error('[llmswitch-core] validateApplyPatchArgumentsJson not available');
  }
  const resultJson = fn(JSON.stringify({ arguments: applyPatchArgsSource ?? null }));
  if (typeof resultJson !== 'string') {
    throw new Error('[llmswitch-core] validateApplyPatchArgumentsJson returned non-string result');
  }
  const parsed = JSON.parse(resultJson) as unknown;
  if (!isRecord(parsed) || typeof parsed.ok !== 'boolean') {
    throw new Error('[llmswitch-core] validateApplyPatchArgumentsJson returned invalid result');
  }
  return {
    ok: parsed.ok,
    ...(typeof parsed.reason === 'string' ? { reason: parsed.reason } : {}),
    ...(typeof parsed.message === 'string' ? { message: parsed.message } : {}),
    ...(typeof parsed.normalizedArguments === 'string' ? { normalizedArgs: parsed.normalizedArguments } : {}),
  };
}

export function validateApplyPatchToolCallDirectNative(argsString: string): {
  ok: boolean;
  reason?: string;
  message?: string;
  normalizedArgs?: string;
} {
  const rawArgsAny = parseToolArgsJson(typeof argsString === 'string' ? argsString : '{}');
  const rawArgsWasObject = (() => {
    if (typeof argsString !== 'string') {
      return isRecord(rawArgsAny);
    }
    const trimmed = argsString.trim();
    return trimmed.startsWith('{') && trimmed.endsWith('}') && isRecord(rawArgsAny);
  })();
  const applyPatchArgsSource =
    rawArgsWasObject && shouldPassApplyPatchRecordToNative(rawArgsAny)
      ? rawArgsAny
      : typeof argsString === 'string'
        ? argsString
        : rawArgsAny;
  const validation = validateApplyPatchArgumentsDirectNative(applyPatchArgsSource);
  if (!validation.ok) {
    return {
      ok: false,
      reason: validation.reason || 'invalid_apply_patch_args',
      message: validation.message,
    };
  }
  return { ok: true, normalizedArgs: validation.normalizedArgs };
}

export function validateExecCommandToolCallDirectNative(
  argsString: string,
  options?: { execCommandGuard?: { enabled?: boolean; policyFile?: string }; schemaMode?: 'compat' | 'canonical' },
) {
  const rawArgsAny = parseToolArgsJson(typeof argsString === 'string' ? argsString : '{}');
  const guard = options?.execCommandGuard;
  return validateExecCommandArgs(
    argsString,
    rawArgsAny,
    {
      ...(guard && guard.enabled ? { policyFile: guard.policyFile } : {}),
      ...(options?.schemaMode ? { schemaMode: options.schemaMode } : {}),
    } satisfies ExecCommandValidationOptions,
  );
}
