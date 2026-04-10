export type UnknownRecord = Record<string, unknown>;

export const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const asString = (value: unknown): string | null => {
  if (typeof value === 'string' && value.trim().length > 0) return value;
  return null;
};

