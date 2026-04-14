import { readRuntimeMetadata } from '../runtime-metadata.js';
import type { ToolValidationOptions } from '../../tools/tool-registry.js';
import {
  parseLenientJsonishWithNative as parseLenient,
  repairArgumentsToStringWithNative as repairArgumentsToString
} from '../../router/virtual-router/engine-selection/native-shared-conversion-semantics.js';

type Unknown = Record<string, unknown>;

function isObject(v: unknown): v is Unknown {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

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

function isApplyPatchPayloadCandidate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const text = value.trim();
  if (!text) return false;
  return (
    text.startsWith('*** Begin Patch') ||
    text.startsWith('*** Update File:') ||
    text.startsWith('*** Add File:') ||
    text.startsWith('*** Delete File:') ||
    text.startsWith('--- a/') ||
    text.startsWith('--- ')
  );
}

function extractApplyPatchPayloadFromExecArgs(rawArgs: unknown): string | null {
  const argsStr = repairArgumentsToString(rawArgs);
  let parsed: unknown;
  try {
    parsed = JSON.parse(argsStr);
  } catch {
    parsed = parseLenient(argsStr);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }

  const obj = parsed as Record<string, unknown>;
  const commandValue = obj.command ?? obj.cmd;
  if (Array.isArray(commandValue)) {
    const tokens = commandValue.map((entry) => (typeof entry === 'string' ? entry : String(entry ?? '')));
    if (!tokens.length) return null;
    const commandToken = tokens[0]?.trim().toLowerCase() || '';
    const isApplyPatchCommand =
      commandToken === 'apply_patch' || commandToken.endsWith('/apply_patch') || commandToken.endsWith('\\apply_patch');
    if (!isApplyPatchCommand) {
      return null;
    }
    const patchText = tokens.slice(1).join('\n').trim();
    return isApplyPatchPayloadCandidate(patchText) ? patchText : null;
  }

  if (typeof commandValue === 'string') {
    const raw = commandValue.trim();
    if (!raw) return null;
    if (!raw.toLowerCase().startsWith('apply_patch')) return null;
    const patchText = raw.slice('apply_patch'.length).trim();
    return isApplyPatchPayloadCandidate(patchText) ? patchText : null;
  }

  return null;
}

export function rewriteExecCommandApplyPatchCall(fn: Record<string, unknown> | undefined): boolean {
  if (!fn) return false;
  const currentName = typeof fn.name === 'string' ? String(fn.name).trim().toLowerCase() : '';
  if (currentName !== 'exec_command') return false;

  const patch = extractApplyPatchPayloadFromExecArgs((fn as any).arguments);
  if (!patch) return false;

  (fn as any).name = 'apply_patch';
  (fn as any).arguments = JSON.stringify({ patch, input: '' });
  return true;
}

const NESTED_APPLY_PATCH_POLICY_MARKER = '[Codex NestedApplyPatch Policy]';

function buildNestedApplyPatchPolicyNotice(rewriteCount: number): string {
  const count = Number.isFinite(rewriteCount) && rewriteCount > 0 ? Math.floor(rewriteCount) : 0;
  return [
    NESTED_APPLY_PATCH_POLICY_MARKER,
    'Forbidden usage detected: apply_patch must NEVER be called via exec_command or shell (detected=' + count + ').',
    'The call was auto-rewritten to apply_patch for compatibility this turn.',
    'Next action rule: call apply_patch directly; do not nest apply_patch inside exec_command/shell.',
    '禁止通过 exec_command/shell 嵌套调用 apply_patch；本轮已自动改写，后续必须直接调用 apply_patch。'
  ].join('\n');
}

export function injectNestedApplyPatchPolicyNotice(messages: any[], rewriteCount: number): void {
  if (!Array.isArray(messages) || rewriteCount <= 0) {
    return;
  }
  const exists = messages.some((entry) => {
    if (!entry || typeof entry !== 'object') return false;
    if ((entry as any).role !== 'system') return false;
    const content = typeof (entry as any).content === 'string' ? String((entry as any).content) : '';
    return content.includes(NESTED_APPLY_PATCH_POLICY_MARKER);
  });
  if (exists) {
    return;
  }
  messages.push({
    role: 'system',
    content: buildNestedApplyPatchPolicyNotice(rewriteCount)
  });
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

function toApplyPatchGuardToken(value: string | undefined, fallback: string, maxLen = 64): string {
  const raw = String(value || '').trim().toLowerCase();
  const token = raw
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLen);
  return token || fallback;
}

function resolveApplyPatchGuardHint(reason?: string, message?: string): string {
  if (reason === 'unsupported_patch_format') {
    return 'update-file-requires-atat-hunk-or-use-delete-add';
  }
  if (reason === 'empty_add_file_block') {
    return 'add-file-requires-plus-prefixed-content-lines';
  }
  if (reason === 'invalid_patch_path') {
    return 'path-must-be-exact-and-dev-null-is-forbidden';
  }
  if (reason === 'missing_changes') {
    return 'provide-non-empty-patch-content';
  }
  const msgToken = toApplyPatchGuardToken(message, '', 80);
  if (msgToken) {
    return msgToken;
  }
  return 'invalid-apply-patch-arguments';
}

export function buildBlockedApplyPatchArgs(rawArgs: unknown, reason?: string, message?: string): string {
  const reasonToken = toApplyPatchGuardToken(reason, 'unknown');
  const hintToken = toApplyPatchGuardToken(resolveApplyPatchGuardHint(reason, message), 'see-guidance');
  const guardPath = `__rcc_apply_patch_validation_error__/reason-${reasonToken}__hint-${hintToken}.txt`;
  const patch = [
    '*** Begin Patch',
    `*** Update File: ${guardPath}`,
    '@@',
    '-RCC_APPLY_PATCH_VALIDATION_GUARD',
    `+RCC_APPLY_PATCH_VALIDATION_GUARD reason=${reasonToken} hint=${hintToken}`,
    '*** End Patch'
  ].join('\n');
  try {
    return JSON.stringify({ patch, input: patch });
  } catch {
    return '{"patch":"*** Begin Patch\\n*** Update File: __rcc_apply_patch_validation_error__/reason-unknown.txt\\n@@\\n-RCC_APPLY_PATCH_VALIDATION_GUARD\\n+RCC_APPLY_PATCH_VALIDATION_GUARD\\n*** End Patch","input":"*** Begin Patch\\n*** Update File: __rcc_apply_patch_validation_error__/reason-unknown.txt\\n@@\\n-RCC_APPLY_PATCH_VALIDATION_GUARD\\n+RCC_APPLY_PATCH_VALIDATION_GUARD\\n*** End Patch"}';
  }
}

const EXEC_COMMAND_NAME_AS_COMMAND_PATTERN =
  /^(?:rg|wc|cat|ls|find|grep|git|sed|head|tail|awk|bash|sh|zsh|node|npm|pnpm|yarn|bd|echo|cp|mv|rm|mkdir|python|python3|perl|ruby)\b/i;

export function repairCommandNameAsExecToolCall(
  fn: Record<string, unknown> | undefined,
  validationOptions?: ToolValidationOptions
): boolean {
  void fn;
  void validationOptions;
  // Client-canonical response rule:
  // do not reinterpret a free-form command-looking function name as exec_command,
  // and do not synthesize cmd/command during response repair.
  return false;
}
