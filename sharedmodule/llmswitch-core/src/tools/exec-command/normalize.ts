import { repairFindMeta } from '../../conversion/shared/tooling.js';

type UnknownRecord = Record<string, unknown>;
const COMMAND_KEYS = ['cmd', 'command', 'toon', 'script'] as const;
const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const hasCommandField = (value: unknown): value is UnknownRecord =>
  isRecord(value) && COMMAND_KEYS.some((key) => Object.prototype.hasOwnProperty.call(value, key));
const unwrapExecArgsShape = (value: unknown): UnknownRecord => {
  if (!isRecord(value)) return {};
  if (hasCommandField(value)) return { ...value };
  const nestedInput = hasCommandField((value as UnknownRecord).input) ? ((value as UnknownRecord).input as UnknownRecord) : undefined;
  const nestedArguments = hasCommandField((value as UnknownRecord).arguments)
    ? ((value as UnknownRecord).arguments as UnknownRecord)
    : undefined;
  const nested = nestedInput ?? nestedArguments;
  return nested ? { ...(nested as UnknownRecord), ...(value as UnknownRecord) } : { ...(value as UnknownRecord) };
};
const asNonEmptyString = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
};
const asPrimitiveString = (value: unknown): string | undefined => {
  if (typeof value === 'string') return asNonEmptyString(value);
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return String(value);
  return undefined;
};
const asFiniteNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;
const asBoolean = (value: unknown): boolean | undefined => (typeof value === 'boolean' ? value : undefined);
const asStringArray = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const out = value.flatMap((entry) => (entry == null ? [] : [typeof entry === 'string' ? entry : String(entry)]));
  return out.length ? out : undefined;
};
const dropToon = (value: UnknownRecord): void => {
  try {
    if (Object.prototype.hasOwnProperty.call(value, 'toon')) delete (value as { toon?: unknown }).toon;
  } catch {}
};

export type ExecCommandNormalizeResult =
  | { ok: true; normalized: UnknownRecord }
  | { ok: false; reason: 'missing_cmd'; normalized: UnknownRecord };

export type ExecCommandNormalizeOptions = {
  schemaMode?: 'compat' | 'canonical';
};

type ExecCommandNormalizedArgs = {
  cmd: string;
  workdir?: string;
  login?: boolean;
  timeout_ms?: number;
  max_output_tokens?: number;
  yield_time_ms?: number;
  sandbox_permissions?: string;
  shell?: string;
  tty?: boolean;
  justification?: string;
};

export function normalizeExecCommandArgs(
  args: unknown,
  options?: ExecCommandNormalizeOptions
): ExecCommandNormalizeResult {
  const canonicalOnly = options?.schemaMode === 'canonical';
  const base = canonicalOnly
    ? (isRecord(args) ? { ...args } : {})
    : unwrapExecArgsShape(args);
  const cmdCandidate =
    (canonicalOnly
      ? asNonEmptyString(base.cmd)
      : (
        asPrimitiveString(base.cmd) ??
        asPrimitiveString(base.command) ??
        asPrimitiveString(base.toon) ??
        asPrimitiveString(base.script) ??
        (() => {
          const arr = asStringArray(base.command) ?? asStringArray(base.cmd);
          return arr?.join(' ');
        })()
      ));
  dropToon(base);
  if (!cmdCandidate) return { ok: false, reason: 'missing_cmd', normalized: base };

  const normalized: ExecCommandNormalizedArgs = { cmd: repairFindMeta(cmdCandidate) };
  const workdir = canonicalOnly
    ? asNonEmptyString(base.workdir)
    : (asNonEmptyString(base.workdir) ?? asNonEmptyString(base.cwd) ?? asNonEmptyString(base.workDir));
  if (workdir) normalized.workdir = workdir;
  const login = asBoolean(base.login);
  if (login !== undefined) normalized.login = login;
  const tty = asBoolean(base.tty);
  if (tty !== undefined) normalized.tty = tty;
  const timeoutMs = canonicalOnly
    ? asFiniteNumber(base.timeout_ms)
    : (asFiniteNumber(base.timeout_ms) ?? asFiniteNumber(base.timeoutMs));
  if (timeoutMs !== undefined) normalized.timeout_ms = timeoutMs;
  const shell = asNonEmptyString(base.shell);
  if (shell) normalized.shell = shell;
  const sandboxPermissions =
    canonicalOnly
      ? asNonEmptyString(base.sandbox_permissions)
      : (
        asNonEmptyString(base.sandbox_permissions) ??
        (asBoolean(base.with_escalated_permissions) ? 'require_escalated' : undefined)
      );
  if (sandboxPermissions) normalized.sandbox_permissions = sandboxPermissions;
  const justification = asNonEmptyString(base.justification);
  if (justification) normalized.justification = justification;
  const maxOutput = canonicalOnly
    ? asFiniteNumber(base.max_output_tokens)
    : (asFiniteNumber(base.max_output_tokens) ?? asFiniteNumber(base.max_tokens));
  if (maxOutput !== undefined) normalized.max_output_tokens = maxOutput;
  const yieldTime = canonicalOnly
    ? asFiniteNumber(base.yield_time_ms)
    : (asFiniteNumber(base.yield_time_ms) ?? asFiniteNumber(base.yield_ms) ?? asFiniteNumber(base.wait_ms));
  if (yieldTime !== undefined) normalized.yield_time_ms = yieldTime;
  return { ok: true, normalized };
}
