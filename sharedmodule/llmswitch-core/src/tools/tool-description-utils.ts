const SHELL_TOOL_ALIASES = new Set(['shell', 'shell_command', 'exec_command', 'bash']);

const APPLY_PATCH_NAME = 'apply_patch';

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

export function hasApplyPatchToolDeclared(tools: unknown[] | undefined): boolean {
  if (!Array.isArray(tools)) {
    return false;
  }
  return tools.some((entry) => normalizeToolName(extractToolFunctionName(entry)) === APPLY_PATCH_NAME);
}

export function buildShellDescription(toolDisplayName: string, hasApplyPatch: boolean): string {
  const label = toolDisplayName && toolDisplayName.trim().length > 0
    ? toolDisplayName.trim()
    : 'shell';
  const base = 'Runs a shell command and returns its output.';
  const workdirLine =
    `- Always set the \`workdir\` param when using the ${label} function. Avoid using \`cd\` unless absolutely necessary.`;
  const applyPatchLine =
    '- Prefer apply_patch for editing files instead of shell redirection or here-doc usage.';
  return hasApplyPatch ? `${base}\n${workdirLine}\n${applyPatchLine}` : `${base}\n${workdirLine}`;
}

export function appendApplyPatchReminder(description: string, hasApplyPatch: boolean): string {
  if (!hasApplyPatch) {
    return description;
  }
  const trimmed = description?.trim() ?? '';
  if (!trimmed) {
    return buildShellDescription('shell', true);
  }
  if (trimmed.includes('apply_patch')) {
    return trimmed;
  }
  const applyPatchLine =
    '- Prefer apply_patch for editing files instead of shell redirection or here-doc usage.';
  return `${trimmed}\n${applyPatchLine}`;
}
