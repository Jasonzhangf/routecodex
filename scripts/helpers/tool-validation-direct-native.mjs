import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const require = createRequire(import.meta.url);

function loadNativeBinding() {
  return require(path.join(repoRoot, 'sharedmodule/llmswitch-core/dist/native/router_hotpath_napi.node'));
}

async function loadExecCommandValidator() {
  const url = pathToFileURL(path.join(repoRoot, 'sharedmodule/llmswitch-core/dist/tools/exec-command/validator.js')).href;
  return import(url);
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
  const rawArgsWasObject = (() => {
    if (typeof argsString !== 'string') return isRecord(rawArgsAny);
    const trimmed = argsString.trim();
    return trimmed.startsWith('{') && trimmed.endsWith('}') && isRecord(rawArgsAny);
  })();
  const applyPatchArgsSource =
    rawArgsWasObject && shouldPassApplyPatchRecordToNative(rawArgsAny)
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

export async function validateExecCommandToolCallDirectNative(argsString, options = {}) {
  const { validateExecCommandArgs } = await loadExecCommandValidator();
  const rawArgsAny = parseToolArgsJson(typeof argsString === 'string' ? argsString : '{}');
  const guard = options?.execCommandGuard;
  return validateExecCommandArgs(argsString, rawArgsAny, {
    ...(guard && guard.enabled ? { policyFile: guard.policyFile } : {}),
    ...(options?.schemaMode ? { schemaMode: options.schemaMode } : {}),
  });
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
