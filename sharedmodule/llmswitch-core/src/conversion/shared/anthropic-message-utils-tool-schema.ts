import { mapBridgeToolsToChat, mapChatToolsToBridge } from './tool-mapping.js';
import type { BridgeToolDefinition } from '../types/bridge-message-types.js';
import type { ChatToolDefinition, MissingField } from '../hub/types/chat-envelope.js';
import { jsonClone, type JsonValue, type JsonObject } from '../hub/types/json.js';
import { denormalizeAnthropicToolName, normalizeAnthropicToolName } from './anthropic-message-utils-core.js';

const ANTHROPIC_STABLE_TOOL_SCHEMA_NAMES = new Set<string>([
  'exec_command',
  'write_stdin',
  'apply_patch',
  'request_user_input',
  'update_plan',
  'view_image',
  'web_search',
  'clock',
  'continue_execution',
  'review'
]);

const ANTHROPIC_STABLE_TOOL_SCHEMA_KEYS = new Map<string, Set<string>>([
  ['exec_command', new Set(['cmd', 'command', 'workdir', 'justification', 'login', 'max_output_tokens', 'sandbox_permissions', 'shell', 'yield_time_ms', 'tty', 'prefix_rule'])],
  ['write_stdin', new Set(['session_id', 'chars', 'text', 'yield_time_ms', 'max_output_tokens'])],
  ['apply_patch', new Set(['patch', 'input', 'instructions', 'text', 'file', 'changes'])],
  ['request_user_input', new Set(['questions'])],
  ['update_plan', new Set(['explanation', 'plan'])],
  ['view_image', new Set(['path'])],
  ['web_search', new Set(['query', 'q', 'domains', 'recency'])],
  ['clock', new Set(['action', 'items', 'taskId'])]
]);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function coerceJsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value as JsonValue;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => coerceJsonValue(entry)) as JsonValue;
  }
  if (isPlainRecord(value)) {
    const obj: JsonObject = {};
    for (const [key, entry] of Object.entries(value)) {
      obj[key] = coerceJsonValue(entry);
    }
    return obj;
  }
  return String(value ?? '') as JsonValue;
}

function cloneAnthropicSchema(value: unknown): Record<string, unknown> {
  if (isPlainRecord(value)) {
    try {
      return JSON.parse(JSON.stringify(value));
    } catch {
      return value as Record<string, unknown>;
    }
  }
  return { type: 'object', properties: {} } as Record<string, unknown>;
}

function normalizeAnthropicSchemaType(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim().toLowerCase();
    if (
      trimmed === 'string' ||
      trimmed === 'number' ||
      trimmed === 'integer' ||
      trimmed === 'boolean' ||
      trimmed === 'object' ||
      trimmed === 'array'
    ) {
      return trimmed;
    }
    return undefined;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const normalized = normalizeAnthropicSchemaType(entry);
      if (normalized) {
        return normalized;
      }
    }
  }
  return undefined;
}

function compactAnthropicPropertySchema(schema: unknown): Record<string, unknown> {
  if (!isPlainRecord(schema)) {
    return { type: 'string' };
  }
  const out: Record<string, unknown> = {};
  const type = normalizeAnthropicSchemaType(schema.type);
  if (type) {
    out.type = type;
  }
  if (typeof schema.description === 'string' && schema.description.trim()) {
    out.description = schema.description;
  }
  const enumRaw = Array.isArray(schema.enum) ? schema.enum : undefined;
  if (enumRaw && enumRaw.length) {
    const enumValues = enumRaw
      .filter((entry) => {
        const entryType = typeof entry;
        return entryType === 'string' || entryType === 'number' || entryType === 'boolean';
      })
      .slice(0, 64);
    if (enumValues.length) {
      out.enum = enumValues;
      if (!out.type) {
        const inferred = typeof enumValues[0];
        out.type = inferred === 'boolean' ? 'boolean' : inferred === 'number' ? 'number' : 'string';
      }
    }
  }
  if (out.type === 'array') {
    const items = isPlainRecord(schema.items) ? schema.items : {};
    const itemType = normalizeAnthropicSchemaType(items.type) ?? 'string';
    out.items = { type: itemType };
  } else if (out.type === 'object') {
    out.properties = {};
    out.additionalProperties = false;
  }
  if (!out.type) {
    out.type = 'string';
  }
  return out;
}

function sanitizeAnthropicBuiltinInputSchema(toolName: string, schemaSource: unknown): Record<string, unknown> {
  const normalizedName = toolName.trim().toLowerCase();
  if (!ANTHROPIC_STABLE_TOOL_SCHEMA_NAMES.has(normalizedName)) {
    return cloneAnthropicSchema(schemaSource);
  }

  const source = cloneAnthropicSchema(schemaSource);
  const sourceProperties = isPlainRecord(source.properties) ? (source.properties as Record<string, unknown>) : {};
  const allowedKeys = ANTHROPIC_STABLE_TOOL_SCHEMA_KEYS.get(normalizedName);
  const sanitizedProperties: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(sourceProperties)) {
    if (allowedKeys && !allowedKeys.has(key)) {
      continue;
    }
    sanitizedProperties[key] = compactAnthropicPropertySchema(value);
  }

  const required = Array.isArray(source.required)
    ? source.required.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    : [];
  const filteredRequired = allowedKeys
    ? required.filter((key) => allowedKeys.has(key))
    : required;

  for (const key of filteredRequired) {
    if (!Object.prototype.hasOwnProperty.call(sanitizedProperties, key)) {
      sanitizedProperties[key] = { type: 'string' };
    }
  }

  const output: Record<string, unknown> = {
    type: 'object',
    properties: sanitizedProperties,
    additionalProperties: false
  };
  if (filteredRequired.length) {
    output.required = Array.from(new Set(filteredRequired));
  }
  return output;
}

function prepareAnthropicBridgeTools(rawTools: JsonValue | undefined, missing?: MissingField[]): BridgeToolDefinition[] | undefined {
  if (!Array.isArray(rawTools) || rawTools.length === 0) {
    return undefined;
  }
  const result: BridgeToolDefinition[] = [];
  rawTools.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      missing?.push({
        path: `tools[${index}]`,
        reason: 'invalid_entry',
        originalValue: jsonClone(coerceJsonValue(entry))
      });
      return;
    }
    const name = typeof (entry as Record<string, unknown>).name === 'string'
      ? ((entry as Record<string, unknown>).name as string)
      : undefined;
    if (!name) {
      missing?.push({ path: `tools[${index}].name`, reason: 'missing_name' });
      return;
    }
    const description = typeof (entry as Record<string, unknown>).description === 'string'
      ? ((entry as Record<string, unknown>).description as string)
      : undefined;
    const schemaSource = (entry as Record<string, unknown>).input_schema;
    const parameters = cloneAnthropicSchema(schemaSource);
    result.push({
      type: 'function',
      function: {
        name,
        description,
        parameters
      }
    });
  });
  return result.length ? result : undefined;
}

function convertBridgeToolToAnthropic(def: BridgeToolDefinition): Record<string, unknown> | null {
  if (!def || typeof def !== 'object') {
    return null;
  }
  const fnNode = def.function && typeof def.function === 'object' ? def.function : undefined;
  const name = typeof fnNode?.name === 'string'
    ? fnNode.name
    : typeof def.name === 'string'
      ? def.name
      : undefined;
  if (!name) {
    return null;
  }
  const description = typeof fnNode?.description === 'string'
    ? fnNode.description
    : typeof def.description === 'string'
      ? def.description
      : undefined;
  const schemaSource = fnNode?.parameters ?? (def as Record<string, unknown>).parameters;
  const inputSchema = sanitizeAnthropicBuiltinInputSchema(name, schemaSource);
  const tool: Record<string, unknown> = {
    name,
    input_schema: inputSchema
  };
  if (description !== undefined) {
    tool.description = description;
  }
  return tool;
}

export function mapAnthropicToolsToChat(rawTools: unknown, missing?: MissingField[]): ChatToolDefinition[] | undefined {
  const prepared = prepareAnthropicBridgeTools(rawTools as JsonValue | undefined, missing);
  if (prepared === undefined) {
    return undefined;
  }
  return mapBridgeToolsToChat(prepared, { sanitizeName: normalizeAnthropicToolName });
}

export function mapChatToolsToAnthropicTools(rawTools: unknown): Record<string, unknown>[] | undefined {
  if (!Array.isArray(rawTools) || rawTools.length === 0) {
    return undefined;
  }
  const bridgeDefs = mapChatToolsToBridge(rawTools, { sanitizeName: denormalizeAnthropicToolName });
  if (!bridgeDefs || !bridgeDefs.length) {
    return undefined;
  }
  const converted = bridgeDefs
    .map((def) => convertBridgeToolToAnthropic(def))
    .filter((entry): entry is Record<string, unknown> => !!entry);
  return converted.length ? converted : undefined;
}
