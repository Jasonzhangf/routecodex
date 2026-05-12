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
  const text = String(cmd || '').trim();
  if (!text) {
    return false;
  }
  const unwrapped = unwrapShellWrapperCommand(text);
  const commandSpans = tokenizeShellWords(unwrapped);
  for (let index = 0; index < commandSpans.length; index += 1) {
    const current = commandSpans[index];
    if (!isCommandPosition(commandSpans, index)) {
      continue;
    }
    const commandName = normalizeCommandName(current.value);
    if (!commandName) {
      continue;
    }
    if (commandName === 'pkill' || commandName === 'killall' || commandName === 'taskkill') {
      return true;
    }
    if (commandName === 'kill') {
      const tail = unwrapped.slice(current.end).trimStart();
      if (tail.startsWith('$(')) {
        return true;
      }
      continue;
    }
    if (commandName === 'xargs') {
      const xargsCommand = findXargsInvokedCommand(commandSpans, index + 1);
      if (xargsCommand === 'kill' || xargsCommand === 'pkill' || xargsCommand === 'killall' || xargsCommand === 'taskkill') {
        return true;
      }
    }
  }
  return false;
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

type ShellTokenSpan = {
  value: string;
  start: number;
  end: number;
};

function unwrapShellWrapperCommand(input: string): string {
  const trimmed = String(input || '').trim();
  const wrapperMatch = trimmed.match(/^(?:bash|sh|zsh)\s+-l?c\s+(['"])([\s\S]*)\1\s*$/i);
  if (!wrapperMatch) {
    return trimmed;
  }
  return wrapperMatch[2] ?? trimmed;
}

function tokenizeShellWords(input: string): ShellTokenSpan[] {
  const tokens: ShellTokenSpan[] = [];
  const text = String(input || '');
  let tokenStart = -1;
  let tokenValue = '';
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let escaping = false;

  const flushToken = (end: number) => {
    if (tokenStart < 0) {
      return;
    }
    tokens.push({ value: tokenValue, start: tokenStart, end });
    tokenStart = -1;
    tokenValue = '';
  };

  const pushTokenChar = (char: string, index: number) => {
    if (tokenStart < 0) {
      tokenStart = index;
    }
    tokenValue += char;
  };

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = index + 1 < text.length ? text[index + 1] : '';

    if (escaping) {
      pushTokenChar(char, index);
      escaping = false;
      continue;
    }

    if (!inSingleQuote && char === '\\') {
      pushTokenChar(char, index);
      escaping = true;
      continue;
    }

    if (!inDoubleQuote && char === '\'') {
      pushTokenChar(char, index);
      inSingleQuote = !inSingleQuote;
      continue;
    }

    if (!inSingleQuote && char === '"') {
      pushTokenChar(char, index);
      inDoubleQuote = !inDoubleQuote;
      continue;
    }

    if (!inSingleQuote && !inDoubleQuote) {
      const isWhitespace = /\s/.test(char);
      if (isWhitespace) {
        flushToken(index);
        continue;
      }
      if ((char === '&' && next === '&') || (char === '|' && next === '|')) {
        flushToken(index);
        tokens.push({ value: `${char}${next}`, start: index, end: index + 2 });
        index += 1;
        continue;
      }
      if (char === '|' || char === ';') {
        flushToken(index);
        tokens.push({ value: char, start: index, end: index + 1 });
        continue;
      }
    }

    pushTokenChar(char, index);
  }

  flushToken(text.length);
  return tokens;
}

function isCommandPosition(tokens: ShellTokenSpan[], index: number): boolean {
  if (index <= 0) {
    return true;
  }
  const previous = tokens[index - 1]?.value;
  return previous === '|' || previous === '||' || previous === '&&' || previous === ';';
}

function normalizeCommandName(value: string): string {
  const trimmed = String(value || '').trim();
  if (!trimmed) {
    return '';
  }
  const unquoted = trimmed.replace(/^['"]|['"]$/g, '');
  const segments = unquoted.split('/').filter(Boolean);
  return (segments[segments.length - 1] || '').toLowerCase();
}

function isShellOperator(value: string): boolean {
  return value === '|' || value === '||' || value === '&&' || value === ';';
}

function isOptionToken(value: string): boolean {
  const normalized = String(value || '').trim();
  return normalized.startsWith('-') && normalized !== '-';
}

function findXargsInvokedCommand(tokens: ShellTokenSpan[], startIndex: number): string {
  for (let index = startIndex; index < tokens.length; index += 1) {
    const value = tokens[index]?.value ?? '';
    if (!value || isShellOperator(value)) {
      return '';
    }
    if (isOptionToken(value)) {
      continue;
    }
    return normalizeCommandName(value);
  }
  return '';
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
