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

function isObject(v: unknown): v is Unknown {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

const normKey = (k: string): string => k.toLowerCase().replace(/[^a-z0-9]+/g, '');

function getDefaultAliases(prop: string): string[] {
  const p = prop.toLowerCase();
  switch (p) {
    case 'file_path': return ['path', 'file', 'filepath', 'filePath'];
    case 'pattern': return ['glob', 'include', 'includes', 'query', 'regex'];
    case 'content': return ['text', 'data', 'body'];
    case 'old_string': return ['old', 'from', 'before', 'oldString', 'previous'];
    case 'new_string': return ['new', 'to', 'after', 'newString', 'next'];
    case 'command': return ['cmd', 'command_list', 'commandList'];
    case 'path': return ['dir', 'directory'];
    case 'glob': return ['include', 'includes', 'patterns'];
    case 'todos': return ['items', 'list', 'tasks'];
    case 'replace_all': return ['replaceAll', 'all', 'allOccurrences'];
    default: return [];
  }
}

function buildPropertyMap(schema: JsonSchema): Map<string, string> {
  const map = new Map<string, string>();
  const props = schema?.properties || {};
  for (const [p, s] of Object.entries(props)) {
    map.set(normKey(p), p);
    const aliases = (s as any)['x-aliases'];
    if (Array.isArray(aliases)) { for (const a of aliases) { if (typeof a === 'string') { map.set(normKey(a), p); } } }
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
      if (Array.isArray(value)) return value.map(v => String(v)).join(' ');
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
        // conservative: split commas/newlines; caller controls format
        const parts = value.split(/[\n,]+/).map(s => s.trim()).filter(Boolean);
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
  if (!schema || !schema.properties || !isObject(input)) {
    const ok = !!(isObject(input) && Object.keys(input).length > 0);
    return ok ? { ok: true, value: input } : { ok: false, errors: ['no_schema_or_invalid_input'] };
  }

  const propMap = buildPropertyMap(schema);
  const out: Record<string, unknown> = {};
  const errors: string[] = [];
  const additional = schema.additionalProperties !== false;

  const reqList = Array.isArray(schema.required) ? schema.required : [];
  if (Object.keys(input).length === 1 && typeof (input as any)._raw === 'string' && reqList.length === 1) {
    const only = reqList[0];
    const child = (schema.properties || {})[only] as JsonSchema | undefined;
    if (child) {
      const coerced = coerceType((input as any)._raw, child);
      if (typeof coerced === 'string' && coerced.trim().length > 0) out[only] = coerced;
    }
  }

  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    const key = normKey(k);
    const target = propMap.get(key);
    if (target) {
      const childSchema = schema.properties![target] as JsonSchema;
      (out as any)[target] = coerceType(v, childSchema);
    } else if (additional) {
      (out as any)[k] = v;
    }
  }

  const req = schema.required || [];
  for (const r of req) {
    if (!(r in out)) { errors.push(`missing_required:${r}`); continue; }
    const v: any = (out as any)[r];
    if (typeof v === 'string' && v.trim().length === 0) { errors.push(`missing_required:${r}`); continue; }
    if (Array.isArray(v) && v.length === 0) { errors.push(`missing_required:${r}`); continue; }
    if (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0) { errors.push(`missing_required:${r}`); continue; }
  }

  const ok = errors.length === 0;
  return ok ? { ok, value: out } : { ok, value: out, errors };
}

// Tools normalizer (OpenAI-like)
export function normalizeTools(tools: any[]): Unknown[] {
  if (!Array.isArray(tools)) return [];
  const out: Unknown[] = [];
  for (const t of tools) {
    if (!t || typeof t !== 'object') continue;
    const fn = (t as any).function || {};
    const topName = typeof (t as any).name === 'string' ? (t as any).name : undefined;
    const topDesc = typeof (t as any).description === 'string' ? (t as any).description : undefined;
    const topParams = (t as any).parameters;
    const name = typeof fn?.name === 'string' ? fn.name : topName;
    const desc = typeof fn?.description === 'string' ? fn.description : topDesc;
    let params = (fn?.parameters !== undefined ? fn.parameters : topParams);
    if (typeof params === 'string') { try { params = JSON.parse(params); } catch { params = {}; } }
    if (!isObject(params)) params = { type: 'object', properties: {}, additionalProperties: true };
    const norm: Unknown = { type: 'function', function: { name, ...(desc ? { description: desc } : {}), parameters: params as Unknown } };
    if ((norm as any).function?.name) out.push(norm);
  }
  return out;
}

