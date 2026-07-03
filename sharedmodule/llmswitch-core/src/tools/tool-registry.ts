// Tool registry and validator (single source of truth)

import { parseToolArgsJson } from './args-json.js';
import { validateExecCommandArgs } from './exec-command/validator.js';
import { validateApplyPatchArgumentsNative } from '../../../../src/modules/llmswitch/bridge/native-exports.js';

type UnknownRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const asString = (value: unknown): string | null => {
  if (typeof value === 'string') {
    return value;
  }
  return null;
};

const asStringArray = (value: unknown): string[] | null => {
  if (!Array.isArray(value)) {
    return null;
  }
  const normalized: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.trim().length === 0) {
      return null;
    }
    normalized.push(entry);
  }
  return normalized;
};

const readBoolean = (value: unknown): boolean | undefined =>
  typeof value === 'boolean' ? value : undefined;

const readNumber = (value: unknown): number | undefined => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }
  return value;
};

const shouldPassApplyPatchRecordToNative = (value: unknown): value is UnknownRecord => {
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
};

// JSON parsing/repair helpers are shared via tools/args-json.ts

const toJson = (value: unknown): string => {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return '{}';
  }
};

const detectForbiddenWrite = (script: string): boolean => {
  const normalized = script.toLowerCase();
  if (!normalized) {
    return false;
  }
  if (/>\s*[^\s<]/.test(normalized)) {
    return true;
  }
  if (/<<</.test(normalized) || /<</.test(normalized)) {
    return true;
  }
  if (/\bsed\b[^\n]*-i\b/.test(normalized)) {
    return true;
  }
  if (/\bed\b[^\n]*-s\b/.test(normalized)) {
    return true;
  }
  if (/\btee\b\s+/.test(normalized)) {
    return true;
  }
  return false;
};

const isImagePath = (value: unknown): boolean => typeof value === 'string' && /\.(png|jpe?g|gif|webp|bmp|svg|tiff?)$/i.test(value.trim());

export interface ToolValidationResult {
  ok: boolean;
  reason?: string;
  message?: string;
  warnings?: Array<Record<string, unknown>>;
  normalizedArgs?: string;
}

export interface ToolValidationOptions {
  execCommandGuard?: {
    enabled?: boolean;
    policyFile?: string;
  };
  schemaMode?: 'compat' | 'canonical';
}

export function getAllowedToolNames(): string[] {
  return [
    'shell',
    'shell_command',
    'bash',
    'exec_command',
    'apply_patch',
    'update_plan',
    'view_image',
    'list_mcp_resources',
    'read_mcp_resource',
    'list_mcp_resource_templates'
  ];
}

type ShellArgs = {
  command: string[];
  workdir?: string;
  timeout_ms?: number;
  with_escalated_permissions?: boolean;
  justification?: string;
};

export function validateToolCall(
  name: string,
  argsString: string,
  options?: ToolValidationOptions
): ToolValidationResult {
  const normalizedName = String(name || '').trim();
  if (!normalizedName) {
    return { ok: false, reason: 'empty_tool_name' };
  }
  const allowed = new Set(getAllowedToolNames());
  if (!allowed.has(normalizedName)) {
    return { ok: false, reason: 'unknown_tool' };
  }

  const rawArgsAny = parseToolArgsJson(typeof argsString === 'string' ? argsString : '{}');

  switch (normalizedName) {
    case 'apply_patch': {
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
      const validation = validateApplyPatchArgumentsNative(applyPatchArgsSource);
      if (!validation.ok) {
        return {
          ok: false,
          reason: validation.reason || 'invalid_apply_patch_args',
          message: validation.message
        };
      }
      return { ok: true, normalizedArgs: validation.normalizedArguments };
    }
    case 'exec_command': {
      const guard = options?.execCommandGuard;
      const validation = validateExecCommandArgs(
        argsString,
        rawArgsAny,
        {
          ...(guard && guard.enabled ? { policyFile: guard.policyFile } : {}),
          ...(options?.schemaMode ? { schemaMode: options.schemaMode } : {})
        }
      );
      if (!validation.ok) {
        const reason = validation.reason || 'unknown';
        return { ok: false, reason, message: validation.message };
      }
      return { ok: true, normalizedArgs: validation.normalizedArgs };
    }
    case 'shell_command':
    case 'bash': {
      const rawArgs = isRecord(rawArgsAny) ? rawArgsAny : {};
      const command =
        asString(rawArgs.command) ??
        asString(rawArgs.cmd);
      if (typeof command !== 'string') {
        return { ok: false, reason: 'missing_command' };
      }
      return { ok: true, normalizedArgs: toJson(rawArgs) };
    }
    case 'shell': {
      const rawArgs = isRecord(rawArgsAny) ? rawArgsAny : {};
      const rawCommand = rawArgs.command;
      let normalizedCommand: string[] | null = null;
      if (typeof rawCommand === 'string') {
        normalizedCommand = [rawCommand];
      } else {
        normalizedCommand = asStringArray(rawCommand);
      }
      if (!normalizedCommand) {
        return { ok: false, reason: 'invalid_command' };
      }
      const scriptJoined = normalizedCommand.join(' ');
      if (detectForbiddenWrite(scriptJoined)) {
        return { ok: false, reason: 'forbidden_write_redirection' };
      }
      const looksBashLc = (arr: string[]) => arr.length >= 2 && arr[0] === 'bash' && arr[1] === '-lc';
      const hasMetaChars = (script: string) => /[|;&]/.test(script) || script.includes('&&') || script.includes('||');

      let finalCommand = normalizedCommand.slice();
      if (!looksBashLc(finalCommand) && hasMetaChars(scriptJoined)) {
        finalCommand = ['bash', '-lc', scriptJoined];
      }

      const shellArgs: ShellArgs = { command: finalCommand };
      const workdir = asString(rawArgs.workdir);
      if (workdir) {
        shellArgs.workdir = workdir;
      }
      const timeout = readNumber(rawArgs.timeout_ms);
      if (timeout !== undefined) {
        shellArgs.timeout_ms = timeout;
      }
      const escalated = readBoolean(rawArgs.with_escalated_permissions);
      if (typeof escalated === 'boolean') {
        shellArgs.with_escalated_permissions = escalated;
      }
      const justification = asString(rawArgs.justification);
      if (justification) {
        shellArgs.justification = justification;
      }
      return { ok: true, normalizedArgs: toJson(shellArgs) };
    }
    case 'update_plan': {
      const rawArgs = isRecord(rawArgsAny) ? rawArgsAny : {};
      if (!Array.isArray(rawArgs.plan)) {
        return { ok: false, reason: 'missing_plan' };
      }
      let inProgressCount = 0;
      for (const entry of rawArgs.plan) {
        if (isRecord(entry) && entry.status === 'in_progress') {
          inProgressCount += 1;
        }
      }
      const warnings: Array<Record<string, unknown>> = [];
      if (inProgressCount > 1) {
        warnings.push({ kind: 'multiple_in_progress', count: inProgressCount });
      }
      const explanation = asString(rawArgs.explanation);
      return {
        ok: true,
        warnings: warnings.length ? warnings : undefined,
        normalizedArgs: toJson({ explanation, plan: rawArgs.plan })
      };
    }
    case 'view_image': {
      const rawArgs = isRecord(rawArgsAny) ? rawArgsAny : {};
      const pathValue = asString(rawArgs.path);
      if (!pathValue || !isImagePath(pathValue)) {
        return { ok: false, reason: 'invalid_image_path' };
      }
      return { ok: true, normalizedArgs: toJson({ path: pathValue }) };
    }
    case 'list_mcp_resources': {
      const rawArgs = isRecord(rawArgsAny) ? rawArgsAny : {};
      const payload: Record<string, string> = {};
      const server = asString(rawArgs.server);
      if (server) {
        payload.server = server;
      }
      const filter = asString(rawArgs.filter);
      if (filter) {
        payload.filter = filter;
      }
      const root = asString(rawArgs.root);
      if (root) {
        payload.root = root;
      }
      return { ok: true, normalizedArgs: toJson(payload) };
    }
    case 'read_mcp_resource': {
      const rawArgs = isRecord(rawArgsAny) ? rawArgsAny : {};
      const server = asString(rawArgs.server);
      const uri = asString(rawArgs.uri);
      if (!server || !uri) {
        return { ok: false, reason: 'missing_server_or_uri' };
      }
      return { ok: true, normalizedArgs: toJson({ server, uri }) };
    }
    case 'list_mcp_resource_templates': {
      const rawArgs = isRecord(rawArgsAny) ? rawArgsAny : {};
      const payload: Record<string, string> = {};
      const server = asString(rawArgs.server);
      if (server) {
        payload.server = server;
      }
      const cursor = asString(rawArgs.cursor);
      if (cursor) {
        payload.cursor = cursor;
      }
      return { ok: true, normalizedArgs: toJson(payload) };
    }
    default:
      return { ok: false, reason: 'unknown_tool' };
  }
}
