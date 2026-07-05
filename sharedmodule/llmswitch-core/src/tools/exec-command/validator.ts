import { parseToolArgsJson } from '../args-json.js';
import { normalizeExecCommandArgs } from './normalize.js';
import { validateExecCommandGuardWithNative } from '../../native/router-hotpath/native-shared-conversion-semantics-toolcalls.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

type UnknownRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const toJson = (value: unknown): string => {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return '{}';
  }
};

export type ExecCommandValidationResult = {
  ok: boolean;
  reason?: string;
  message?: string;
  normalizedArgs?: string;
};

export type ExecCommandValidationOptions = {
  policyFile?: string;
  schemaMode?: 'compat' | 'canonical';
};

type PolicyViolation = {
  reason: 'forbidden_exec_command_policy';
  message: string;
};

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
    const raw = fs.readFileSync(resolved, 'utf8');
    return raw.trim() ? raw : undefined;
  } catch {
    return undefined;
  }
}

export function validateExecCommandArgs(
  argsString: string,
  rawArgs: unknown,
  options?: ExecCommandValidationOptions
): ExecCommandValidationResult {
  const raw = typeof argsString === 'string' ? argsString : String(argsString ?? '');

  const parsed =
    isRecord(rawArgs) && Object.keys(rawArgs).length > 0
      ? rawArgs
      : (parseToolArgsJson(raw) as unknown);
  const rawTrimmed = raw.trim();
  const parsedRecord =
    (isRecord(parsed) && Object.keys(parsed).length > 0)
      ? parsed
      : (rawTrimmed && !rawTrimmed.startsWith('{') && !rawTrimmed.startsWith('[')
          ? { cmd: rawTrimmed }
          : parsed);

  const normalized = normalizeExecCommandArgs(parsedRecord, {
    schemaMode: options?.schemaMode === 'canonical' ? 'canonical' : 'compat'
  });
  if (normalized.ok === false) {
    return { ok: false, reason: normalized.reason };
  }

  const command = typeof normalized.normalized.cmd === 'string' ? normalized.normalized.cmd : '';
  const nativeGuard = validateExecCommandGuardWithNative(command, readPolicyJson(options?.policyFile));
  if (!nativeGuard.ok) {
    return {
      ok: false,
      reason: nativeGuard.reason || 'forbidden_exec_command',
      message: nativeGuard.message
    };
  }

  return { ok: true, normalizedArgs: toJson({ ...normalized.normalized, cmd: nativeGuard.normalizedCmd ?? command }) };
}
