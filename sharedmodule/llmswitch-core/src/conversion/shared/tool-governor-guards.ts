import { readRuntimeMetadata } from '../runtime-metadata.js';
import { validateToolCall, type ToolValidationOptions } from '../../tools/tool-registry.js';
import {
  parseLenientJsonishWithNative as parseLenient,
  repairArgumentsToStringWithNative as repairArgumentsToString
} from '../../router/virtual-router/engine-selection/native-shared-conversion-semantics.js';
import { isObject } from '../../shared/common-utils.js';

type Unknown = Record<string, unknown>;


export function resolveExecCommandGuardValidationOptions(payload: Unknown): ToolValidationOptions | undefined {
  const carrier = isObject((payload as any).metadata)
    ? ((payload as any).metadata as Record<string, unknown>)
    : (payload as Record<string, unknown>);
  const rt = readRuntimeMetadata(carrier);
  if (!rt || typeof rt !== 'object') {
    return undefined;
  }
  const guardRaw = (rt as Record<string, unknown>).execCommandGuard;
  if (!guardRaw || typeof guardRaw !== 'object' || Array.isArray(guardRaw)) {
    return undefined;
  }
  const guard = guardRaw as Record<string, unknown>;
  const enabled = guard.enabled === true;
  if (!enabled) {
    return undefined;
  }
  const policyFile =
    typeof guard.policyFile === 'string' && guard.policyFile.trim().length ? guard.policyFile.trim() : undefined;
  return {
    execCommandGuard: {
      enabled: true,
      ...(policyFile ? { policyFile } : {})
    }
  };
}

function shellSingleQuote(text: string): string {
  return `'${String(text || '').replace(/'/g, `'\\''`)}'`;
}

function buildExecCommandGuardScript(reason?: string, message?: string): string {
  const fallback = 'blocked by exec_command guard policy.';
  const detail =
    reason === 'forbidden_git_reset_hard'
      ? 'blocked by exec_command guard: git reset --hard is forbidden. Use git reset --mixed REF or git restore --source REF -- FILE.'
      : reason === 'forbidden_git_checkout_scope'
        ? 'blocked by exec_command guard: git checkout is allowed only for a single file. Use git checkout -- FILE or git checkout REF -- FILE.'
        : reason === 'forbidden_exec_command_policy'
          ? `policy 不允许: ${(message || '').trim() || 'command blocked by policy'}`
          : message && message.trim()
            ? `blocked by exec_command guard: ${message.trim()}`
            : fallback;
  const compact = detail.replace(/\s+/g, ' ').trim() || fallback;
  return `bash -lc "printf '%s\\n' ${shellSingleQuote(compact)} >&2; exit 2"`;
}

export function buildBlockedExecCommandArgs(rawArgs: unknown, reason?: string, message?: string): string {
  let parsed: any = {};
  try {
    const repaired = repairArgumentsToString(rawArgs);
    try {
      parsed = JSON.parse(repaired);
    } catch {
      parsed = parseLenient(repaired);
    }
  } catch {
    parsed = {};
  }
  const out: Record<string, unknown> = {};
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const workdir =
      typeof parsed.workdir === 'string'
        ? parsed.workdir
        : typeof parsed.cwd === 'string'
          ? parsed.cwd
          : undefined;
    if (workdir && workdir.trim().length > 0) {
      out.workdir = workdir.trim();
    }
  }
  out.cmd = buildExecCommandGuardScript(reason, message);
  try {
    return JSON.stringify(out);
  } catch {
    return JSON.stringify({
      cmd: `bash -lc 'printf "%s\\n" "blocked by exec_command guard policy." >&2; exit 2'`
    });
  }
}

const EXEC_COMMAND_NAME_AS_COMMAND_PATTERN =
  /^(?:rg|wc|cat|ls|find|grep|git|sed|head|tail|awk|bash|sh|zsh|node|npm|pnpm|yarn|bd|echo|cp|mv|rm|mkdir|python|python3|perl|ruby)\b/i;

export function repairCommandNameAsExecToolCall(
  fn: Record<string, unknown> | undefined,
  validationOptions?: ToolValidationOptions
): boolean {
  if (!fn || typeof fn !== 'object') {
    return false;
  }

  const rawName = typeof fn.name === 'string' ? String(fn.name).trim() : '';
  if (!rawName) {
    return false;
  }

  const lowered = rawName.toLowerCase();
  if (
    lowered === 'exec_command' ||
    lowered === 'execute_command' ||
    lowered === 'execute-command' ||
    lowered === 'shell_command' ||
    lowered === 'shell' ||
    lowered === 'bash' ||
    lowered === 'terminal'
  ) {
    return false;
  }

  if (!EXEC_COMMAND_NAME_AS_COMMAND_PATTERN.test(rawName)) {
    return false;
  }

  const argsStr = repairArgumentsToString((fn as any).arguments);
  let parsed: Record<string, unknown> = {};
  try {
    const json = JSON.parse(argsStr);
    if (json && typeof json === 'object' && !Array.isArray(json)) {
      parsed = json as Record<string, unknown>;
    }
  } catch {
    const lenient = parseLenient(argsStr);
    if (lenient && typeof lenient === 'object' && !Array.isArray(lenient)) {
      parsed = lenient as Record<string, unknown>;
    }
  }

  const hasExplicitCommand =
    typeof parsed.cmd === 'string' ||
    typeof parsed.command === 'string' ||
    typeof parsed.toon === 'string' ||
    typeof parsed.script === 'string';
  const normalized = {
    ...parsed,
    ...(hasExplicitCommand ? {} : { cmd: rawName })
  };

  let nextArgs = '{}';
  try {
    const validation = validateToolCall('exec_command', JSON.stringify(normalized), validationOptions);
    if (validation && validation.ok && typeof validation.normalizedArgs === 'string') {
      nextArgs = validation.normalizedArgs;
    } else {
      nextArgs = JSON.stringify(normalized);
    }
  } catch {
    try {
      nextArgs = JSON.stringify(normalized);
    } catch {
      nextArgs = '{}';
    }
  }

  (fn as any).name = 'exec_command';
  (fn as any).arguments = nextArgs;
  return true;
}
