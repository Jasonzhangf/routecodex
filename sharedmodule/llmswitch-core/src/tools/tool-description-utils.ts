const SHELL_TOOL_ALIASES = new Set(['shell', 'shell_command', 'exec_command', 'bash']);

export function normalizeToolName(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function extractToolFunctionName(entry: unknown): string {
  if (!entry || typeof entry !== 'object') {
    return '';
  }
  const fnName = typeof (entry as any).function?.name === 'string'
    ? (entry as any).function.name
    : undefined;
  if (fnName && fnName.trim().length > 0) {
    return fnName.trim();
  }
  const topName = typeof (entry as any).name === 'string' ? (entry as any).name : '';
  return topName.trim();
}

export function isShellToolName(value: unknown): boolean {
  return SHELL_TOOL_ALIASES.has(normalizeToolName(value));
}

export function buildShellDescription(toolDisplayName: string): string {
  const label = toolDisplayName && toolDisplayName.trim().length > 0
    ? toolDisplayName.trim()
    : 'shell';
  const base = 'Runs a shell command and returns its output.';
  const workdirLine =
    `- Always set the \`workdir\` param when using the ${label} function. Avoid using \`cd\` unless absolutely necessary.`;
  return `${base}\n${workdirLine}`;
}

export function appendApplyPatchReminder(description: string): string {
  return description;
}
