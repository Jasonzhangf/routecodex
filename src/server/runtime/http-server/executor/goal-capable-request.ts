const GOAL_TOOL_NAMES = new Set([
  'get_goal',
  'create_goal',
  'update_goal',
  'request_user_input'
]);

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

export function readGoalToolName(tool: unknown): string {
  const record = asRecord(tool);
  if (!record) {
    return '';
  }
  const directName = readNonEmptyString(record.name);
  if (directName) {
    return directName.toLowerCase();
  }
  const fn = asRecord(record.function);
  return readNonEmptyString(fn?.name)?.toLowerCase() ?? '';
}

export function isGoalToolName(name: unknown): boolean {
  return GOAL_TOOL_NAMES.has(readNonEmptyString(name)?.toLowerCase() ?? '');
}

export function hasGoalCapableTools(tools: unknown): boolean {
  if (!Array.isArray(tools)) {
    return false;
  }
  return tools.some((tool) => {
    const toolRecord = asRecord(tool);
    if (!toolRecord) {
      return false;
    }
    if (isGoalToolName(readGoalToolName(toolRecord))) {
      return true;
    }
    return hasGoalCapableTools(toolRecord.tools);
  });
}

export function isGoalCapableRequestSemantics(semantics: unknown): boolean {
  const record = asRecord(semantics);
  if (!record) {
    return false;
  }
  if (hasGoalCapableTools(record.tools)) {
    return true;
  }
  const toolsNode = asRecord(record.tools);
  return (
    hasGoalCapableTools(toolsNode?.clientToolsRaw)
    || hasGoalCapableTools(toolsNode?.baselineTools)
    || hasGoalCapableTools(toolsNode?.canonicalTools)
  );
}

export function isGoalCapableRequestPayload(payload: unknown): boolean {
  const record = asRecord(payload);
  if (!record) {
    return false;
  }
  return (
    hasGoalCapableTools(record.tools)
    || isGoalCapableRequestSemantics(record.semantics)
  );
}
