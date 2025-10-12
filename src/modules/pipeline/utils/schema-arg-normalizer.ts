/**
 * Schema-driven argument normalizer
 * - Works with OpenAI function.parameters or Anthropic input_schema (JSON Schema-like)
 * - Normalizes keys (case/underscore/dash/space), supports x-aliases on property
 * - Light type coercion for string/number/integer/boolean/array/object
 * - Honors required and additionalProperties
 */

export interface NormalizeResult<T=Record<string, unknown>> {
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

const normKey = (k: string): string => k.toLowerCase().replace(/[^a-z0-9]+/g, '');

function getDefaultAliases(prop: string): string[] {
  const p = prop.toLowerCase();
  switch (p) {
    case 'file_path':
      return ['path', 'file', 'filepath', 'filePath'];
    case 'pattern':
      // Common synonyms used by providers and models
      return ['glob', 'include', 'includes', 'query', 'regex'];
    case 'content':
      return ['text', 'data', 'body'];
    case 'old_string':
      return ['old', 'from', 'before', 'oldString', 'previous'];
    case 'new_string':
      return ['new', 'to', 'after', 'newString', 'next'];
    case 'command':
      return ['cmd', 'command_list', 'commandList'];
    case 'path':
      return ['dir', 'directory'];
    case 'glob':
      return ['include', 'includes', 'patterns'];
    case 'todos':
      return ['items', 'list', 'tasks'];
    case 'replace_all':
      return ['replaceAll', 'all', 'allOccurrences'];
    default:
      return [];
  }
}

function buildPropertyMap(schema: JsonSchema): Map<string, string> {
  const map = new Map<string, string>();
  const props = schema?.properties || {};
  for (const [p, s] of Object.entries(props)) {
    map.set(normKey(p), p);
    const aliases = (s as any)['x-aliases'];
    if (Array.isArray(aliases)) {
      for (const a of aliases) { if (typeof a === 'string') { map.set(normKey(a), p); } }
    }
    // Always include built-in generic aliases for common property names
    for (const a of getDefaultAliases(p)) { map.set(normKey(a), p); }
  }
  return map;
}

function coerceType(value: any, schema: JsonSchema): any {
  const t = schema?.type;
  const want = Array.isArray(t) ? t[0] : t;
  if (!want) { return value; }
  switch (want) {
    case 'string':
      if (typeof value === 'string') return value;
      if (Array.isArray(value)) { return value.map(v => String(v)).join(' '); }
      if (value === null || value === undefined) return value;
      return String(value);
    case 'number':
      if (typeof value === 'number') return value;
      if (typeof value === 'string') { const n = Number(value); return Number.isFinite(n) ? n : value; }
      return value;
    case 'integer':
      if (typeof value === 'number') return Math.trunc(value);
      if (typeof value === 'string') { const n = parseInt(value, 10); return Number.isFinite(n) ? n : value; }
      return value;
    case 'boolean':
      if (typeof value === 'boolean') return value;
      if (typeof value === 'string') { const s = value.toLowerCase(); if (s === 'true') return true; if (s === 'false') return false; }
      return value;
    case 'array':
      if (Array.isArray(value)) return value;
      if (typeof value === 'string') {
        // split comma/space
        const parts = value.split(/[,\n]+/).map(s => s.trim()).filter(Boolean);
        return parts.length ? parts : value;
      }
      return value;
    case 'object':
      if (value && typeof value === 'object') return value;
      return value;
    default:
      return value;
  }
}

export function normalizeArgsBySchema(input: any, schema?: JsonSchema): NormalizeResult {
  if (!schema || !schema.properties || typeof input !== 'object' || input === null) {
    // If no schema, accept non-empty object as-is
    const ok = !!(input && typeof input === 'object' && Object.keys(input).length > 0);
    return ok ? { ok: true, value: input } : { ok: false, errors: ['no_schema_or_invalid_input'] };
  }

  const propMap = buildPropertyMap(schema);
  const out: Record<string, unknown> = {};
  const errors: string[] = [];
  const additional = schema.additionalProperties !== false;

  // Special case: only a raw string provided under _raw, and schema has exactly one required string property
  const reqList = Array.isArray(schema.required) ? schema.required : [];
  if (Object.keys(input).length === 1 && typeof (input as any)._raw === 'string' && reqList.length === 1) {
    const only = reqList[0];
    const child = (schema.properties || {})[only] as JsonSchema | undefined;
    if (child) {
      const coerced = coerceType((input as any)._raw, child);
      if (typeof coerced === 'string' && coerced.trim().length > 0) {
        out[only] = coerced;
      }
    }
  }

  // map known properties
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    const key = normKey(k);
    const target = propMap.get(key);
    if (target) {
      const childSchema = schema.properties![target] as JsonSchema;
      out[target] = coerceType(v, childSchema);
    } else if (additional) {
      out[k] = v;
    }
  }

  // required check (treat empty string/empty array/empty object as missing)
  const req = schema.required || [];
  for (const r of req) {
    if (!(r in out)) {
      errors.push(`missing_required:${r}`);
      continue;
    }
    const v: any = out[r as keyof typeof out];
    if (typeof v === 'string' && v.trim().length === 0) {
      errors.push(`missing_required:${r}`);
      continue;
    }
    if (Array.isArray(v) && v.length === 0) {
      errors.push(`missing_required:${r}`);
      continue;
    }
    if (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0) {
      errors.push(`missing_required:${r}`);
      continue;
    }
  }

  const ok = errors.length === 0;
  return ok ? { ok, value: out } : { ok, value: out, errors };
}
