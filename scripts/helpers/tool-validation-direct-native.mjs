import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(import.meta.url);

function loadNativeBinding() {
  return require(path.join(repoRoot, 'sharedmodule/llmswitch-core/dist/native/router_hotpath_napi.node'));
}

function parseToolArgsJson(value) {
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function isRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function resolvePolicyPath(rawPath) {
  const trimmed = typeof rawPath === 'string' ? rawPath.trim() : '';
  if (!trimmed) return '';
  if (trimmed.startsWith('~/')) {
    return path.join(os.homedir(), trimmed.slice(2));
  }
  return path.resolve(trimmed);
}

function readPolicyJson(policyFile) {
  const resolved = resolvePolicyPath(policyFile);
  if (!resolved) return undefined;
  try {
    const stat = fs.statSync(resolved);
    if (!stat.isFile()) return undefined;
    const raw = fs.readFileSync(resolved, 'utf8').trim();
    return raw || undefined;
  } catch {
    return undefined;
  }
}

function shouldPassApplyPatchRecordToNative(value) {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  if (keys.length === 0) return true;
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

export function validateApplyPatchToolCallDirectNative(argsString) {
  const binding = loadNativeBinding();
  const fn = binding.validateApplyPatchArgumentsJson;
  if (typeof fn !== 'function') {
    throw new Error('validateApplyPatchArgumentsJson native export is required');
  }
  const rawArgsAny = parseToolArgsJson(typeof argsString === 'string' ? argsString : '{}');
  const argsTrimmed = typeof argsString === 'string' ? argsString.trim() : '';
  const rawArgsWasObject = (() => {
    if (typeof argsString !== 'string') return isRecord(rawArgsAny);
    return argsTrimmed.startsWith('{') && argsTrimmed.endsWith('}') && isRecord(rawArgsAny);
  })();
  const rawArgsRepairLostPayload =
    rawArgsWasObject
    && argsTrimmed.length > 2
    && isRecord(rawArgsAny)
    && Object.keys(rawArgsAny).length === 0;
  const applyPatchArgsSource =
    rawArgsWasObject && !rawArgsRepairLostPayload && shouldPassApplyPatchRecordToNative(rawArgsAny)
      ? rawArgsAny
      : typeof argsString === 'string'
        ? argsString
        : rawArgsAny;
  const raw = fn(JSON.stringify({ arguments: applyPatchArgsSource ?? null }));
  const parsed = JSON.parse(String(raw || '{}'));
  if (!parsed?.ok) {
    return {
      ok: false,
      reason: parsed?.reason || 'invalid_apply_patch_args',
      message: parsed?.message,
    };
  }
  return {
    ok: true,
    ...(typeof parsed.normalizedArguments === 'string' ? { normalizedArgs: parsed.normalizedArguments } : {}),
  };
}

function parseNativeValidationResult(raw, capability) {
  const parsed = JSON.parse(String(raw || '{}'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || typeof parsed.ok !== 'boolean') {
    throw new Error(`${capability} returned invalid result`);
  }
  return parsed;
}

function normalizeExecCommandArgsDirectNative(args, schemaMode) {
  const binding = loadNativeBinding();
  const fn = binding.normalizeExecCommandArgsJson;
  if (typeof fn !== 'function') {
    throw new Error('normalizeExecCommandArgsJson native export is required');
  }
  const raw = fn(JSON.stringify({ args: args ?? null, schemaMode }));
  const parsed = parseNativeValidationResult(raw, 'normalizeExecCommandArgsJson');
  if (!parsed.ok) {
    return {
      ok: false,
      ...(typeof parsed.reason === 'string' ? { reason: parsed.reason } : {}),
    };
  }
  if (!isRecord(parsed.normalized)) {
    throw new Error('normalizeExecCommandArgsJson returned invalid normalized payload');
  }
  return { ok: true, normalized: parsed.normalized };
}

function validateCanonicalClientToolCallDirectNative(toolName, argsString) {
  const binding = loadNativeBinding();
  const fn = binding.validateCanonicalClientToolCallJson;
  if (typeof fn !== 'function') {
    throw new Error('validateCanonicalClientToolCallJson native export is required');
  }
  const raw = fn(JSON.stringify({ name: toolName, argsString }));
  const parsed = parseNativeValidationResult(raw, 'validateCanonicalClientToolCallJson');
  return {
    ok: parsed.ok,
    ...(typeof parsed.reason === 'string' ? { reason: parsed.reason } : {}),
    ...(typeof parsed.message === 'string' ? { message: parsed.message } : {}),
    ...(typeof parsed.normalizedArgs === 'string' ? { normalizedArgs: parsed.normalizedArgs } : {}),
  };
}

function validateExecCommandGuardDirectNative(cmd, policyJson) {
  const binding = loadNativeBinding();
  const fn = binding.validateExecCommandGuardJson;
  if (typeof fn !== 'function') {
    throw new Error('validateExecCommandGuardJson native export is required');
  }
  const raw = fn(JSON.stringify({
    cmd,
    ...(typeof policyJson === 'string' && policyJson.trim() ? { policyJson } : {}),
  }));
  const parsed = parseNativeValidationResult(raw, 'validateExecCommandGuardJson');
  return {
    ok: parsed.ok,
    ...(typeof parsed.reason === 'string' ? { reason: parsed.reason } : {}),
    ...(typeof parsed.message === 'string' ? { message: parsed.message } : {}),
    ...(typeof parsed.normalizedCmd === 'string' ? { normalizedCmd: parsed.normalizedCmd } : {}),
  };
}

export function validateExecCommandToolCallDirectNative(argsString, options = {}) {
  const rawArgsAny = parseToolArgsJson(typeof argsString === 'string' ? argsString : '{}');
  const guard = options?.execCommandGuard;
  const schemaMode = options?.schemaMode === 'canonical' ? 'canonical' : 'compat';
  const normalized = normalizeExecCommandArgsDirectNative(rawArgsAny, schemaMode);
  if (!normalized.ok) {
    return { ok: false, reason: normalized.reason || 'missing_cmd' };
  }
  const canonical = validateCanonicalClientToolCallDirectNative('exec_command', JSON.stringify(normalized.normalized));
  if (!canonical.ok) return canonical;
  const canonicalArgs = JSON.parse(String(canonical.normalizedArgs || '{}'));
  if (!isRecord(canonicalArgs) || typeof canonicalArgs.cmd !== 'string') {
    throw new Error('validateCanonicalClientToolCallJson returned invalid exec_command payload');
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

export async function validateToolCallDirectNative(toolName, argsString, options = {}) {
  if (toolName === 'apply_patch') {
    return validateApplyPatchToolCallDirectNative(argsString);
  }
  if (toolName === 'exec_command') {
    return validateExecCommandToolCallDirectNative(argsString, options);
  }
  return { ok: false, reason: 'retired_tool_registry_shell' };
}
