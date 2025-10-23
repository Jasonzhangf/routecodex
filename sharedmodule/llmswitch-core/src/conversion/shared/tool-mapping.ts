// Placeholder for strict tool/arguments mapping shared helper.
// Phase 2 will move normalization & schema-aware shaping here.
export interface ToolCallFunction {
  name: string;
  arguments: string; // always JSON string
}

export interface ToolCallItem {
  id?: string;
  type: 'function';
  function: ToolCallFunction;
}

export function stringifyArgs(args: unknown): string {
  if (typeof args === 'string') return args;
  try { return JSON.stringify(args ?? {}); } catch { return String(args); }
}

