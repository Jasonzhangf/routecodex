/**
 * Shared pure functions: tool call validation and recovery.
 *
 * Extracted from provider-response-converter.ts to establish
 * single-responsibility block boundary for client tool call validation.
 */

export function isImagePathLike(value: string): boolean {
  return /\.(png|jpg|jpeg|gif|webp|bmp|svg|tiff?|ico|heic|jxl)$/i.test(value);
}

export function parseToolArgsRecord(argsString: string): Record<string, unknown> | null {
  const trimmed = String(argsString || '').trim();
  if (!trimmed || !(trimmed.startsWith('{') || trimmed.startsWith('['))) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed);
    return asFlatRecord(parsed) ?? null;
  } catch {
    return null;
  }
}

export function buildMissingFields(fields: Array<string | undefined>): string[] | undefined {
  const normalized = fields
    .map((field) => (typeof field === 'string' ? field.trim() : ''))
    .filter((field): field is string => Boolean(field));
  return normalized.length ? normalized : undefined;
}

export function buildToolValidationFailure(args: {
  reason: string;
  message: string;
  missingFields?: string[];
}): {
  ok: false;
  reason: string;
  message: string;
  missingFields?: string[];
} {
  return {
    ok: false,
    reason: args.reason,
    message: args.message,
    ...(args.missingFields?.length ? { missingFields: args.missingFields } : {})
  };
}

export function readReasoningStopBoolean(value: unknown): boolean | undefined {
  if (value === true) {
    return true;
  }
  if (value === false) {
    return false;
  }
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true') {
    return true;
  }
  if (normalized === 'false') {
    return false;
  }
  return undefined;
}

export function containsBroadKillCommand(cmd: string): boolean {
  const text = String(cmd || '').trim().toLowerCase();
  if (!text) {
    return false;
  }
  return (
    /\bpkill\b/.test(text) ||
    /\bkillall\b/.test(text) ||
    /\bkill\s*\$\s*\(/.test(text) ||
    /\bxargs\s+kill\b/.test(text)
  );
}

export function hasInvalidShellWrapperShape(cmd: string): boolean {
  const trimmed = String(cmd || '').trim();
  if (!trimmed) {
    return false;
  }
  const shellWrapperPrefixes = [
    "bash -lc '",
    "bash -c '",
    "sh -lc '",
    "sh -c '",
    "zsh -lc '",
    "zsh -c '"
  ] as const;
  return shellWrapperPrefixes.some((prefix) => trimmed.startsWith(prefix) && !trimmed.endsWith("'"));
}

function asFlatRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function validateCanonicalClientToolCall(
  name: string,
  argsString: string,
  declaredToolNames?: Set<string>
): {
  ok: boolean;
  reason?: string;
  message?: string;
  missingFields?: string[];
  normalizedArgs?: string;
} {
  const parsed = parseToolArgsRecord(argsString);
  const normalizedName = name.trim().toLowerCase();
  switch (normalizedName) {
    case 'exec_command': {
      const cmd = typeof parsed?.cmd === 'string' ? parsed.cmd.trim() : '';
      if (!cmd) {
        return buildToolValidationFailure({
          reason: 'missing_cmd',
          message: 'exec_command requires input.cmd as a non-empty string.',
          missingFields: ['cmd']
        });
      }
      if (containsBroadKillCommand(cmd)) {
        return buildToolValidationFailure({
          reason: 'forbidden_broad_kill',
          message: 'exec_command contains a forbidden broad process-kill command. Use explicit PID- or service-scoped shutdown/restart only.'
        });
      }
      if (hasInvalidShellWrapperShape(cmd)) {
        return buildToolValidationFailure({
          reason: 'invalid_shell_wrapper_shape',
          message:
            "exec_command contains a malformed shell wrapper: `bash/sh/zsh -c/-lc '...'` must keep the closing single quote. Tail-truncated wrappers are rejected."
        });
      }
      return { ok: true, normalizedArgs: JSON.stringify({ ...parsed, cmd }) };
    }
    case 'view_image': {
      const pathValue = typeof parsed?.path === 'string' ? parsed.path.trim() : '';
      if (!pathValue || !isImagePathLike(pathValue)) {
        return buildToolValidationFailure({
          reason: 'invalid_image_path',
          message: 'view_image requires input.path pointing to an image file.'
        });
      }
      return { ok: true, normalizedArgs: JSON.stringify({ path: pathValue }) };
    }
    case 'apply_patch': {
      const patch =
        typeof parsed?.patch === 'string' && parsed.patch.trim()
          ? parsed.patch
          : typeof parsed?.input === 'string' && parsed.input.trim()
            ? parsed.input
            : '';
      if (!patch) {
        return buildToolValidationFailure({
          reason: 'missing_patch',
          message: 'apply_patch requires patch content in input.patch or input.input.',
          missingFields: ['patch']
        });
      }
      return { ok: true, normalizedArgs: JSON.stringify({ patch, input: patch }) };
    }
    case 'update_plan': {
      if (!Array.isArray(parsed?.plan)) {
        return buildToolValidationFailure({
          reason: 'missing_plan',
          message: 'update_plan requires input.plan as an array.',
          missingFields: ['plan']
        });
      }
      return { ok: true, normalizedArgs: JSON.stringify({ explanation: parsed?.explanation, plan: parsed.plan }) };
    }
    case 'shell_command':
    case 'bash': {
      const command = typeof parsed?.command === 'string' ? parsed.command.trim() : '';
      if (!command) {
        return buildToolValidationFailure({
          reason: 'missing_command',
          message: `${normalizedName} requires input.command as a non-empty string.`,
          missingFields: ['command']
        });
      }
      return { ok: true, normalizedArgs: JSON.stringify(parsed) };
    }
    case 'shell': {
      const command = parsed?.command;
      if (!(Array.isArray(command) && command.every((entry) => typeof entry === 'string' && entry.trim().length > 0))) {
        return buildToolValidationFailure({
          reason: 'invalid_command',
          message: 'shell requires input.command as a non-empty string array.'
        });
      }
      return { ok: true, normalizedArgs: JSON.stringify(parsed) };
    }
    case 'read_mcp_resource': {
      const server = typeof parsed?.server === 'string' ? parsed.server.trim() : '';
      const uri = typeof parsed?.uri === 'string' ? parsed.uri.trim() : '';
      if (!server || !uri) {
        return buildToolValidationFailure({
          reason: 'missing_server_or_uri',
          message: 'read_mcp_resource requires both input.server and input.uri.',
          missingFields: buildMissingFields([
            !server ? 'server' : undefined,
            !uri ? 'uri' : undefined
          ])
        });
      }
      return { ok: true, normalizedArgs: JSON.stringify({ server, uri }) };
    }
    case 'reasoning.stop': {
      if (!parsed) {
        return buildToolValidationFailure({
          reason: 'invalid_reasoning_stop_arguments',
          message: 'reasoning.stop requires a JSON object arguments payload.'
        });
      }
      const taskGoal = typeof parsed.task_goal === 'string'
        ? parsed.task_goal.trim()
        : typeof parsed.taskGoal === 'string'
          ? parsed.taskGoal.trim()
          : typeof parsed.goal === 'string'
            ? parsed.goal.trim()
            : '';
      if (!taskGoal) {
        return buildToolValidationFailure({
          reason: 'invalid_reasoning_stop_arguments',
          message: 'reasoning.stop requires task_goal.',
          missingFields: ['task_goal']
        });
      }
      const completed = readReasoningStopBoolean(parsed.is_completed ?? parsed.isCompleted ?? parsed.completed);
      if (typeof completed !== 'boolean') {
        return buildToolValidationFailure({
          reason: 'invalid_reasoning_stop_arguments',
          message: 'reasoning.stop requires is_completed(boolean).',
          missingFields: ['is_completed']
        });
      }
      return { ok: true, normalizedArgs: JSON.stringify(parsed) };
    }
    case 'list_mcp_resources':
    case 'list_mcp_resource_templates':
      return { ok: true, normalizedArgs: JSON.stringify(parsed ?? {}) };
    default:
      if (declaredToolNames?.has(normalizedName)) {
        if (!parsed) {
          return buildToolValidationFailure({
            reason: 'invalid_declared_tool_arguments',
            message: `Tool "${name.trim()}" requires JSON object arguments.`
          });
        }
        return { ok: true, normalizedArgs: JSON.stringify(parsed) };
      }
      const declaredList = declaredToolNames && declaredToolNames.size > 0
        ? Array.from(declaredToolNames).sort().join(', ')
        : '';
      return buildToolValidationFailure({
        reason: 'unknown_tool',
        message: declaredList
          ? `Tool "${name.trim()}" is not declared for this request. Declared tools: ${declaredList}.`
          : `Tool "${name.trim()}" is not declared for this request.`
      });
  }
}
