import { normalizeArgsBySchemaWithNative, normalizeToolsWithNative } from '../router/virtual-router/engine-selection/native-shared-conversion-semantics.js';

// Shared tool + argument mapping helpers (schema-driven)

export type Unknown = Record<string, unknown>;

export interface NormalizeResult<T = Record<string, unknown>> {
  ok: boolean;
  value?: T;
  errors?: string[];
}

type JsonSchema = {
  type?: string | string[];
  properties?: Record<string, JsonSchema & { ['x-aliases']?: string[] }>;
  required?: string[];
  items?: JsonSchema;
  additionalProperties?: boolean;
};

export function normalizeArgsBySchema(input: any, schema?: JsonSchema): NormalizeResult {
  return normalizeArgsBySchemaWithNative(input, schema) as NormalizeResult;
}

// Tools normalizer (OpenAI-like)
export function normalizeTools(tools: any[]): Unknown[] {
  return normalizeToolsWithNative(tools) as Unknown[];
}
