import type { JsonObject } from '../../hub/types/json.js';
import { sanitizeToolSchemaGlmShellWithNative } from '../../../router/virtual-router/engine-selection/native-compat-action-semantics.js';

type UnknownRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const sanitizeGLMToolsSchema = (data: UnknownRecord): UnknownRecord => {
  if (!isRecord(data)) {
    return data;
  }
  return sanitizeToolSchemaGlmShellWithNative(data);
};

export const sanitizeGLMToolsSchemaInPlace = (data: UnknownRecord): void => {
  if (!isRecord(data)) {
    return;
  }
  const sanitized = sanitizeGLMToolsSchema(data);
  for (const key of Object.keys(data)) {
    delete data[key];
  }
  Object.assign(data, sanitized);
};

export function sanitizeToolSchema(payload: JsonObject, mode: 'glm_shell' = 'glm_shell'): JsonObject {
  if (mode !== 'glm_shell') {
    return payload;
  }
  return sanitizeGLMToolsSchema(payload as UnknownRecord) as JsonObject;
}
