export type Unknown = Record<string, unknown>;

function isObject(v: unknown): v is Unknown {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function tryParseJsonString(s: unknown): unknown {
  if (typeof s !== 'string') return s;
  try { return JSON.parse(s); } catch { return s; }
}

function toJsonString(v: unknown): string {
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v ?? {}); } catch { return String(v); }
}

// Extract expected simple types from JSON Schema (very lightweight)
function getExpectedType(schema: Unknown | undefined, key: string): { kind: 'string'|'arrayString'|'object'|'any' } {
  if (!schema || !isObject(schema)) return { kind: 'any' };
  const props = isObject(schema.properties) ? (schema.properties as Unknown) : undefined;
  const s = props && isObject(props[key]) ? (props[key] as Unknown) : undefined;
  if (!s) return { kind: 'any' };
  const t = s.type;
  if (t === 'string') return { kind: 'string' };
  if (t === 'object') return { kind: 'object' };
  if (t === 'array') {
    const items = s.items as Unknown | undefined;
    const it = items && isObject(items) ? items.type : undefined;
    if (it === 'string') return { kind: 'arrayString' };
    return { kind: 'any' };
  }
  return { kind: 'any' };
}

function coerceValueByKind(value: unknown, kind: 'string'|'arrayString'|'object'|'any'): unknown {
  if (kind === 'any') return value;
  if (kind === 'string') {
    if (Array.isArray(value) && value.length === 1 && typeof value[0] === 'string') return value[0];
    if (typeof value !== 'string') return toJsonString(value);
    return value;
  }
  // Lightweight shell-style splitter for command strings
  function splitShellWords(s: string): string[] {
    const out: string[] = [];
    let cur = '';
    let quote: null | 'single' | 'double' = null;
    let escape = false;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (escape) { cur += ch; escape = false; continue; }
      if (ch === '\\') { escape = true; continue; }
      if (quote === 'single') { if (ch === '\'') { quote = null; } else { cur += ch; } continue; }
      if (quote === 'double') { if (ch === '"') { quote = null; } else { cur += ch; } continue; }
      if (ch === '\'') { quote = 'single'; continue; }
      if (ch === '"') { quote = 'double'; continue; }
      if (/\s/.test(ch)) { if (cur.length) { out.push(cur); cur = ''; } continue; }
      cur += ch;
    }
    if (cur.length) out.push(cur);
    return out.filter(Boolean);
  }
  if (kind === 'arrayString') {
    if (Array.isArray(value)) return value;
    if (typeof value === 'string') {
      const trimmed = value.trim();
      // If looks like a JSON array, try parse first
      if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
        try {
          const arr = JSON.parse(trimmed);
          if (Array.isArray(arr) && arr.every((x) => typeof x === 'string')) return arr as string[];
        } catch { /* ignore JSON parse errors */ }
      }
      const parts = splitShellWords(trimmed);
      return parts.length ? parts : [trimmed];
    }
    return [toJsonString(value)];
  }
  if (kind === 'object') {
    if (isObject(value)) return value;
    // try parse if string
    const parsed = tryParseJsonString(value);
    return isObject(parsed) ? parsed : {};
  }
  return value;
}

export function normalizeArgumentsBySchema(argsStringOrObj: unknown, functionName: string | undefined, tools: unknown): string {
  // Parse args into object
  const raw = tryParseJsonString(argsStringOrObj);
  const argsObj: Unknown = isObject(raw) ? (raw as Unknown) : {};

  // Find function schema in provided tools (OpenAI Chat normalized shape)
  let fnSchema: Unknown | undefined;
  if (Array.isArray(tools)) {
    for (const t of tools as any[]) {
      if (!t || typeof t !== 'object') continue;
      const fn = (t as any).function || {};
      const nm = typeof fn?.name === 'string' ? fn.name : undefined;
      if (nm && functionName && nm === functionName) {
        const params = fn?.parameters;
        if (isObject(params)) fnSchema = params as Unknown;
        break;
      }
    }
  }

  if (!fnSchema) {
    // Fallback: try to infer per-key expectations from any available tool schemas.
    // Build a merged properties map of first-matching property types across tools.
    const mergedProps: Record<string, { kind: 'string'|'arrayString'|'object'|'any' }> = {};
    if (Array.isArray(tools)) {
      for (const t of tools as any[]) {
        if (!t || typeof t !== 'object') continue;
        const fn = (t as any).function || {};
        const params = fn?.parameters;
        if (!isObject(params)) continue;
        const props = (params as any).properties;
        if (!isObject(props)) continue;
        for (const key of Object.keys(props)) {
          if (mergedProps[key]) continue;
          mergedProps[key] = getExpectedType(params as Unknown, key);
        }
      }
    }
    // If we learned anything about expected keys, coerce by those kinds.
    const keys = Object.keys(mergedProps);
    if (keys.length > 0) {
      for (const key of keys) {
        if (key in argsObj) {
          const kind = mergedProps[key].kind;
          argsObj[key] = coerceValueByKind(argsObj[key], kind);
        }
      }
      return toJsonString(argsObj);
    }
    // No hints — return original (stringified)
    return toJsonString(argsStringOrObj);
  }

  // Coerce each known property by expected type
  const props = (fnSchema as any).properties;
  if (isObject(props)) {
    for (const key of Object.keys(props)) {
      const exp = getExpectedType(fnSchema as Unknown, key);
      if (key in argsObj) {
        argsObj[key] = coerceValueByKind(argsObj[key], exp.kind);
      }
    }
  }

  return toJsonString(argsObj);
}
