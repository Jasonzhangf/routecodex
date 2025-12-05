import type { UnknownObject } from '../../../../modules/pipeline/types/common-types.js';

const SHELL_COMMAND_DESCRIPTION = 'Shell command argv tokens. Use ["bash","-lc","<cmd>"] form.';

const isRecord = (value: unknown): value is UnknownObject => typeof value === 'object' && value !== null;

type ToolDefinition = UnknownObject & { function?: ToolFunction };
type ToolFunction = UnknownObject & { name?: string; parameters?: ToolParameters; strict?: unknown };
type ToolParameters = UnknownObject & {
  properties?: Record<string, UnknownObject>;
  required?: string[];
  type?: string;
  additionalProperties?: boolean;
};

type ToolProperty = UnknownObject & {
  type?: string;
  description?: string;
  items?: UnknownObject;
  oneOf?: unknown;
};

const ensureStringArray = (value: unknown): string[] => {
  if (Array.isArray(value) && value.every(item => typeof item === 'string')) {
    return [...value];
  }
  return [];
};

const sanitizeShellCommandProperty = (properties: Record<string, UnknownObject>): void => {
  const candidate = properties.command;
  if (isRecord(candidate)) {
    const command = { ...candidate } as ToolProperty;
    delete command.oneOf;
    command.type = 'array';
    command.items = { type: 'string' };
    if (typeof command.description !== 'string' || command.description.length === 0) {
      command.description = SHELL_COMMAND_DESCRIPTION;
    }
    properties.command = command;
    return;
  }

  properties.command = {
    description: SHELL_COMMAND_DESCRIPTION,
    type: 'array',
    items: { type: 'string' }
  };
};

const sanitizeToolFunction = (toolFn: ToolFunction, isShell: boolean): ToolFunction => {
  const fn = { ...toolFn };
  if ('strict' in fn) {
    delete fn.strict;
  }

  if (!fn.parameters || !isRecord(fn.parameters)) {
    return fn;
  }

  const params: ToolParameters = { ...fn.parameters };
  if (isShell) {
    if (params.properties && isRecord(params.properties)) {
      params.properties = { ...params.properties };
    } else {
      params.properties = {};
    }

    sanitizeShellCommandProperty(params.properties as Record<string, UnknownObject>);

    const required = ensureStringArray(params.required);
    if (!required.includes('command')) {
      required.push('command');
    }
    params.required = required;
    params.type = typeof params.type === 'string' ? params.type : 'object';
    params.additionalProperties = typeof params.additionalProperties === 'boolean'
      ? params.additionalProperties
      : false;
  }

  fn.parameters = params;
  return fn;
};

const sanitizeToolDefinition = (tool: UnknownObject): UnknownObject => {
  const sanitized = { ...tool } as ToolDefinition;
  if (!sanitized.function || !isRecord(sanitized.function)) {
    return sanitized;
  }

  const fn = sanitizeToolFunction(sanitized.function, sanitized.function.name === 'shell');
  sanitized.function = fn;
  return sanitized;
};

export const sanitizeGLMToolsSchema = (data: UnknownObject): UnknownObject => {
  const toolsValue = (data as { tools?: unknown }).tools;
  if (!Array.isArray(toolsValue)) {
    return data;
  }

  const sanitizedTools = toolsValue.map(tool => (isRecord(tool) ? sanitizeToolDefinition(tool) : tool));
  return {
    ...data,
    tools: sanitizedTools
  };
};

export const sanitizeGLMToolsSchemaInPlace = (data: UnknownObject): void => {
  const toolsValue = (data as { tools?: unknown }).tools;
  if (!Array.isArray(toolsValue)) {
    return;
  }
  const sanitized = sanitizeGLMToolsSchema(data);
  (data as { tools?: unknown }).tools = (sanitized as { tools?: unknown }).tools;
};
