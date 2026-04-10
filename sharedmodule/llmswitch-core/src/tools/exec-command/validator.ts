import { parseToolArgsJson } from '../args-json.js';
import { normalizeExecCommandArgs } from './normalize.js';
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
};

type PolicyViolation = {
  reason:
    | 'forbidden_git_reset_hard'
    | 'forbidden_git_checkout_scope'
    | 'forbidden_exec_command_policy';
  message: string;
};

type ExecCommandGuardRule = {
  id: string;
  regex: RegExp;
  reason: string;
};

type ExecCommandGuardPolicyCacheEntry = {
  mtimeMs: number;
  rules: ExecCommandGuardRule[];
};

const POLICY_CACHE = new Map<string, ExecCommandGuardPolicyCacheEntry>();

const GIT_RESET_HARD_PATTERN = /\bgit\s+reset\s+--hard(?:\s|$)/i;
const GIT_CHECKOUT_PATTERN = /\bgit\s+checkout\b/i;
const SHELL_SEPARATORS = new Set([';', '&&', '||', '|', '&']);

function splitShellTokens(command: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let escaped = false;

  const pushCurrent = (): void => {
    if (current.length > 0) {
      tokens.push(current);
      current = '';
    }
  };

  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      pushCurrent();
      continue;
    }
    if (ch === ';') {
      pushCurrent();
      tokens.push(';');
      continue;
    }
    if (ch === '|' || ch === '&') {
      pushCurrent();
      const next = command[i + 1];
      if ((ch === '|' || ch === '&') && next === ch) {
        tokens.push(ch + next);
        i += 1;
      } else {
        tokens.push(ch);
      }
      continue;
    }
    current += ch;
  }

  pushCurrent();
  return tokens;
}

function evaluateGitCheckoutScope(command: string): PolicyViolation | null {
  const match = GIT_CHECKOUT_PATTERN.exec(command);
  if (!match) {
    return null;
  }
  const checkoutText = command.slice(match.index);
  const tokens = splitShellTokens(checkoutText);
  if (tokens.length < 3 || tokens[0]?.toLowerCase() !== 'git' || tokens[1]?.toLowerCase() !== 'checkout') {
    return {
      reason: 'forbidden_git_checkout_scope',
      message:
        'Command blocked: git checkout is restricted to a single file path. Use `git checkout -- <file>` or `git checkout <ref> -- <file>`.'
    };
  }

  const separatorIdx = tokens.findIndex((token, idx) => idx >= 2 && SHELL_SEPARATORS.has(token));
  if (separatorIdx >= 0) {
    return {
      reason: 'forbidden_git_checkout_scope',
      message:
        'Command blocked: git checkout must be a standalone single-file command (no chained commands).'
    };
  }
  const checkoutTokens = separatorIdx >= 0 ? tokens.slice(0, separatorIdx) : tokens;
  const dashDashIdx = checkoutTokens.indexOf('--', 2);
  if (dashDashIdx < 0) {
    return {
      reason: 'forbidden_git_checkout_scope',
      message:
        'Command blocked: git checkout is restricted to a single file path. Use `git checkout -- <file>` or `git checkout <ref> -- <file>`.'
    };
  }

  const beforeDashDash = checkoutTokens.slice(2, dashDashIdx);
  if (beforeDashDash.length > 1 || beforeDashDash.some((token) => token.startsWith('-'))) {
    return {
      reason: 'forbidden_git_checkout_scope',
      message:
        'Command blocked: git checkout is restricted to a single file path. Use `git checkout -- <file>` or `git checkout <ref> -- <file>`.'
    };
  }

  const paths = checkoutTokens.slice(dashDashIdx + 1);
  if (paths.length !== 1) {
    return {
      reason: 'forbidden_git_checkout_scope',
      message:
        'Command blocked: git checkout is restricted to a single file path. Use `git checkout -- <file>` or `git checkout <ref> -- <file>`.'
    };
  }

  const path = paths[0];
  if (!path || path === '.' || path === '/' || path === '*' || path.endsWith('/')) {
    return {
      reason: 'forbidden_git_checkout_scope',
      message:
        'Command blocked: git checkout is restricted to one concrete file path (directory/pathset restore is not allowed).'
    };
  }

  return null;
}

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

function loadPolicyRules(policyFile?: string): ExecCommandGuardRule[] {
  const resolved = typeof policyFile === 'string' ? resolvePolicyPath(policyFile) : '';
  if (!resolved) {
    return [];
  }
  try {
    const stat = fs.statSync(resolved);
    if (!stat.isFile()) {
      return [];
    }
    const cached = POLICY_CACHE.get(resolved);
    if (cached && cached.mtimeMs === stat.mtimeMs) {
      return cached.rules;
    }
    const raw = fs.readFileSync(resolved, 'utf8');
    const parsed = raw.trim() ? JSON.parse(raw) : {};
    const rulesNode = isRecord(parsed) && Array.isArray(parsed.rules) ? parsed.rules : [];
    const rules: ExecCommandGuardRule[] = [];
    for (const item of rulesNode) {
      if (!isRecord(item)) {
        continue;
      }
      const type = typeof item.type === 'string' ? item.type.trim().toLowerCase() : '';
      if (type !== 'regex') {
        continue;
      }
      const pattern = typeof item.pattern === 'string' ? item.pattern : '';
      if (!pattern.trim()) {
        continue;
      }
      const id = typeof item.id === 'string' && item.id.trim() ? item.id.trim() : `rule_${rules.length + 1}`;
      const reason =
        typeof item.reason === 'string' && item.reason.trim()
          ? item.reason.trim()
          : `policy rule "${id}" blocked this command`;
      const flagsRaw = typeof item.flags === 'string' ? item.flags.trim() : '';
      let regex: RegExp;
      try {
        regex = new RegExp(pattern, flagsRaw || 'i');
      } catch {
        continue;
      }
      rules.push({ id, regex, reason });
    }
    POLICY_CACHE.set(resolved, { mtimeMs: stat.mtimeMs, rules });
    return rules;
  } catch {
    return [];
  }
}

function detectPolicyRuleViolation(command: string, options?: ExecCommandValidationOptions): PolicyViolation | null {
  const rules = loadPolicyRules(options?.policyFile);
  if (!rules.length) {
    return null;
  }
  for (const rule of rules) {
    if (rule.regex.test(command)) {
      return {
        reason: 'forbidden_exec_command_policy',
        message: rule.reason
      };
    }
  }
  return null;
}

function detectPolicyViolation(command: string, options?: ExecCommandValidationOptions): PolicyViolation | null {
  if (!command || !command.trim()) {
    return null;
  }
  const policyViolation = detectPolicyRuleViolation(command, options);
  if (policyViolation) {
    return policyViolation;
  }
  if (GIT_RESET_HARD_PATTERN.test(command)) {
    return {
      reason: 'forbidden_git_reset_hard',
      message:
        'Command blocked: `git reset --hard` is destructive. Use `git reset --mixed <ref>` or file-scoped restore commands instead.'
    };
  }
  return evaluateGitCheckoutScope(command);
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

  const normalized = normalizeExecCommandArgs(parsedRecord);
  if (normalized.ok === false) {
    return { ok: false, reason: normalized.reason };
  }

  const command = typeof normalized.normalized.cmd === 'string' ? normalized.normalized.cmd : '';
  const violation = detectPolicyViolation(command, options);
  if (violation) {
    return { ok: false, reason: violation.reason, message: violation.message };
  }

  return { ok: true, normalizedArgs: toJson(normalized.normalized) };
}
