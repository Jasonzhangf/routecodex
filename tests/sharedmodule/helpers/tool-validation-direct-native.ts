import { readNativeFunction } from '../../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-router-hotpath-loader.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

type UnknownRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function resolvePolicyPath(rawPath: string): string {
  const trimmed = rawPath.trim();
  if (!trimmed) {
    return '';
  }
  if (trimmed.startsWith('~/')) {
    return path.join(os.homedir(), trimmed.slice(2));
  }
  return path.resolve(trimmed);
}

function readPolicyJson(policyFile?: string): string | undefined {
  const resolved = typeof policyFile === 'string' ? resolvePolicyPath(policyFile) : '';
  if (!resolved) {
    return undefined;
  }
  try {
    const stat = fs.statSync(resolved);
    if (!stat.isFile()) {
      return undefined;
    }
    const raw = fs.readFileSync(resolved, 'utf8').trim();
    return raw || undefined;
  } catch {
    return undefined;
  }
}

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

function parseNativeValidationResult(raw: string, capability: string): UnknownRecord {
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed) || typeof parsed.ok !== 'boolean') {
    throw new Error(`[llmswitch-core] ${capability} returned invalid result`);
  }
  return parsed;
}

function parseToolArgsJsonDirectNative(input: unknown): unknown {
  const capability = 'parseToolArgsJsonWithArtifactRepairJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error(`[llmswitch-core] ${capability} not available`);
  }
  const raw = fn(JSON.stringify(typeof input === 'string' ? input : ''));
  if (typeof raw !== 'string') {
    throw new Error(`[llmswitch-core] ${capability} returned non-string result`);
  }
  return JSON.parse(raw) as unknown;
}

function normalizeExecCommandArgsDirectNative(
  args: unknown,
  schemaMode: 'compat' | 'canonical',
): { ok: true; normalized: UnknownRecord } | { ok: false; reason?: string } {
  const capability = 'normalizeExecCommandArgsJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error(`[llmswitch-core] ${capability} not available`);
  }
  const raw = fn(JSON.stringify({ args: args ?? null, schemaMode }));
  if (typeof raw !== 'string') {
    throw new Error(`[llmswitch-core] ${capability} returned non-string result`);
  }
  const parsed = parseNativeValidationResult(raw, capability);
  if (!parsed.ok) {
    return {
      ok: false,
      ...(typeof parsed.reason === 'string' ? { reason: parsed.reason } : {}),
    };
  }
  if (!isRecord(parsed.normalized)) {
    throw new Error(`[llmswitch-core] ${capability} returned invalid normalized payload`);
  }
  return { ok: true, normalized: parsed.normalized };
}

function validateCanonicalClientToolCallDirectNative(toolName: string, argsString: string): {
  ok: boolean;
  reason?: string;
  message?: string;
  normalizedArgs?: string;
} {
  const capability = 'validateCanonicalClientToolCallJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error(`[llmswitch-core] ${capability} not available`);
  }
  const raw = fn(JSON.stringify({ name: toolName, argsString }));
  if (typeof raw !== 'string') {
    throw new Error(`[llmswitch-core] ${capability} returned non-string result`);
  }
  const parsed = parseNativeValidationResult(raw, capability);
  return {
    ok: parsed.ok,
    ...(typeof parsed.reason === 'string' ? { reason: parsed.reason } : {}),
    ...(typeof parsed.message === 'string' ? { message: parsed.message } : {}),
    ...(typeof parsed.normalizedArgs === 'string' ? { normalizedArgs: parsed.normalizedArgs } : {}),
  };
}

function validateExecCommandGuardDirectNative(cmd: string, policyJson?: string): {
  ok: boolean;
  reason?: string;
  message?: string;
  normalizedCmd?: string;
} {
  const capability = 'validateExecCommandGuardJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error(`[llmswitch-core] ${capability} not available`);
  }
  const raw = fn(JSON.stringify({
    cmd,
    ...(typeof policyJson === 'string' && policyJson.trim() ? { policyJson } : {}),
  }));
  if (typeof raw !== 'string') {
    throw new Error(`[llmswitch-core] ${capability} returned non-string result`);
  }
  const parsed = parseNativeValidationResult(raw, capability);
  return {
    ok: parsed.ok,
    ...(typeof parsed.reason === 'string' ? { reason: parsed.reason } : {}),
    ...(typeof parsed.message === 'string' ? { message: parsed.message } : {}),
    ...(typeof parsed.normalizedCmd === 'string' ? { normalizedCmd: parsed.normalizedCmd } : {}),
  };
}

export function validateApplyPatchToolCallDirectNative(argsString: string): {
  ok: boolean;
  reason?: string;
  message?: string;
  normalizedArgs?: string;
} {
  const rawArgsAny = parseToolArgsJsonDirectNative(typeof argsString === 'string' ? argsString : '{}');
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
  const rawArgsAny = parseToolArgsJsonDirectNative(typeof argsString === 'string' ? argsString : '{}');
  const guard = options?.execCommandGuard;
  const schemaMode = options?.schemaMode === 'canonical' ? 'canonical' : 'compat';
  const normalized = normalizeExecCommandArgsDirectNative(rawArgsAny, schemaMode);
  if (!normalized.ok) {
    return { ok: false, reason: normalized.reason || 'missing_cmd' };
  }
  const canonical = validateCanonicalClientToolCallDirectNative(
    'exec_command',
    JSON.stringify(normalized.normalized),
  );
  if (!canonical.ok) {
    return canonical;
  }
  const canonicalArgs = JSON.parse(String(canonical.normalizedArgs || '{}')) as unknown;
  if (!isRecord(canonicalArgs) || typeof canonicalArgs.cmd !== 'string') {
    throw new Error('[llmswitch-core] validateCanonicalClientToolCallJson returned invalid exec_command payload');
  }
  const policyJson = guard && guard.enabled ? readPolicyJson(guard.policyFile) : undefined;
  const nativeGuard = validateExecCommandGuardDirectNative(canonicalArgs.cmd, policyJson);
  if (!nativeGuard.ok) {
    return {
      ok: false,
      reason: nativeGuard.reason || 'forbidden_exec_command',
      message: nativeGuard.message,
    };
  }
  return {
    ok: true,
    normalizedArgs: JSON.stringify({
      ...canonicalArgs,
      cmd: nativeGuard.normalizedCmd ?? canonicalArgs.cmd,
    }),
  };
}
