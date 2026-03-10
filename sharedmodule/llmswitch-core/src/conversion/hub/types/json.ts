export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;
export interface JsonObject {
  [key: string]: JsonValue;
}

export type JsonArray = JsonValue[];

export function isJsonObject(value: JsonValue | null | undefined): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function isJsonArray(value: JsonValue | null | undefined): value is JsonArray {
  return Array.isArray(value);
}

export function jsonClone<T extends JsonValue>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
