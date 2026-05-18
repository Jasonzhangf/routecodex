import { isRecord } from '../utils/common-utils.js';

export type TomlPrimitive = string | number | boolean;
export interface TomlTable {
  [key: string]: TomlValue;
}
export type TomlValue = TomlPrimitive | TomlValue[] | TomlTable;

type MutableRecord = Record<string, unknown>;

interface TomlCollectionState {
  squareDepth: number;
  braceDepth: number;
  inString: boolean;
  escape: boolean;
}

function stripTomlComment(line: string): string {
  let out = '';
  let inString = false;
  let escape = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inString) {
      out += ch;
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === '\\') {
        escape = true;
        continue;
      }
      if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === '#') {
      break;
    }
    out += ch;
  }
  return out.trim();
}

function splitTopLevel(input: string, delimiter: string): string[] {
  const parts: string[] = [];
  let current = '';
  let inString = false;
  let escape = false;
  let bracketDepth = 0;
  let braceDepth = 0;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (inString) {
      current += ch;
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === '\\') {
        escape = true;
        continue;
      }
      if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      current += ch;
      continue;
    }
    if (ch === '[') bracketDepth++;
    if (ch === ']') bracketDepth--;
    if (ch === '{') braceDepth++;
    if (ch === '}') braceDepth--;
    if (ch === delimiter && bracketDepth === 0 && braceDepth === 0) {
      parts.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) {
    parts.push(current.trim());
  }
  return parts;
}

function createCollectionState(): TomlCollectionState {
  return {
    squareDepth: 0,
    braceDepth: 0,
    inString: false,
    escape: false
  };
}

function advanceCollectionState(state: TomlCollectionState, input: string): void {
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (state.inString) {
      if (state.escape) {
        state.escape = false;
        continue;
      }
      if (ch === '\\') {
        state.escape = true;
        continue;
      }
      if (ch === '"') {
        state.inString = false;
      }
      continue;
    }
    if (ch === '"') {
      state.inString = true;
      continue;
    }
    if (ch === '[') {
      state.squareDepth += 1;
      continue;
    }
    if (ch === ']') {
      state.squareDepth -= 1;
      continue;
    }
    if (ch === '{') {
      state.braceDepth += 1;
      continue;
    }
    if (ch === '}') {
      state.braceDepth -= 1;
    }
  }
}

function isCollectionBalanced(state: TomlCollectionState): boolean {
  return !state.inString && state.squareDepth === 0 && state.braceDepth === 0;
}

function parseQuotedString(raw: string): string {
  return JSON.parse(raw) as string;
}

function parseKeyPath(raw: string): string[] {
  return splitTopLevel(raw.trim(), '.').map((segment) => {
    const trimmed = segment.trim();
    if (!trimmed) {
      throw new Error(`[config] invalid TOML key path segment in "${raw}"`);
    }
    if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
      return parseQuotedString(trimmed);
    }
    return trimmed;
  });
}

function parseInlineTable(raw: string): TomlTable {
  const body = raw.slice(1, -1).trim();
  const record: Record<string, TomlValue> = {};
  if (!body) {
    return record;
  }
  for (const entry of splitTopLevel(body, ',')) {
    const eq = entry.indexOf('=');
    if (eq <= 0) {
      throw new Error(`[config] invalid TOML inline table entry "${entry}"`);
    }
    const key = entry.slice(0, eq).trim();
    const value = entry.slice(eq + 1).trim();
    const keyPath = parseKeyPath(key);
    assignValueAtPath(record as MutableRecord, keyPath, parseTomlValue(value));
  }
  return record;
}

export function parseTomlValue(raw: string): TomlValue {
  const value = raw.trim();
  if (!value) {
    throw new Error('[config] invalid empty TOML value');
  }
  if (value.startsWith('"') && value.endsWith('"')) {
    return parseQuotedString(value);
  }
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^-?\d+$/.test(value)) {
    return Number.parseInt(value, 10);
  }
  if (/^-?\d+\.\d+$/.test(value)) {
    return Number.parseFloat(value);
  }
  if (value.startsWith('[') && value.endsWith(']')) {
    const body = value.slice(1, -1).trim();
    if (!body) {
      return [];
    }
    return splitTopLevel(body, ',').map((entry) => parseTomlValue(entry));
  }
  if (value.startsWith('{') && value.endsWith('}')) {
    return parseInlineTable(value);
  }
  throw new Error(`[config] unsupported TOML value "${value}"`);
}

function ensureChildRecord(parent: MutableRecord, key: string): MutableRecord {
  const existing = parent[key];
  if (existing === undefined) {
    const next: MutableRecord = {};
    parent[key] = next;
    return next;
  }
  if (!isRecord(existing)) {
    throw new Error(`[config] TOML path "${key}" collides with a non-object value`);
  }
  return existing as MutableRecord;
}

function ensureChildArrayTable(parent: MutableRecord, key: string): MutableRecord {
  const existing = parent[key];
  if (existing === undefined) {
    const next: MutableRecord[] = [{}];
    parent[key] = next;
    return next[0];
  }
  if (!Array.isArray(existing)) {
    throw new Error(`[config] TOML array-table "${key}" collides with a non-array value`);
  }
  const next: MutableRecord = {};
  existing.push(next);
  return next;
}

function assignValueAtPath(target: MutableRecord, path: string[], value: TomlValue): void {
  let cursor: MutableRecord = target;
  for (let i = 0; i < path.length - 1; i++) {
    cursor = ensureChildRecord(cursor, path[i]);
  }
  cursor[path[path.length - 1]] = value;
}

function resolveHeaderTarget(root: MutableRecord, segments: string[], asArrayTable: boolean): MutableRecord {
  let cursor: MutableRecord = root;
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    const isLeaf = i === segments.length - 1;
    if (isLeaf && asArrayTable) {
      cursor = ensureChildArrayTable(cursor, segment);
      continue;
    }
    const existing = cursor[segment];
    if (Array.isArray(existing)) {
      const last = existing[existing.length - 1];
      if (!isRecord(last)) {
        throw new Error(`[config] TOML path "${segment}" points to an invalid array-table entry`);
      }
      cursor = last as MutableRecord;
      continue;
    }
    cursor = ensureChildRecord(cursor, segment);
  }
  return cursor;
}

export function parseTomlRecord(raw: string): Record<string, unknown> {
  const root: MutableRecord = {};
  let currentTarget: MutableRecord = root;
  const lines = raw.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const rawLine = lines[index];
    let line = stripTomlComment(rawLine);
    if (!line) {
      continue;
    }
    if (line.startsWith('[[') && line.endsWith(']]')) {
      const segments = parseKeyPath(line.slice(2, -2).trim());
      currentTarget = resolveHeaderTarget(root, segments, true);
      continue;
    }
    if (line.startsWith('[') && line.endsWith(']')) {
      const segments = parseKeyPath(line.slice(1, -1).trim());
      currentTarget = resolveHeaderTarget(root, segments, false);
      continue;
    }
    const eq = line.indexOf('=');
    if (eq <= 0) {
      throw new Error(`[config] invalid TOML assignment "${line}"`);
    }
    const keyPath = parseKeyPath(line.slice(0, eq).trim());
    let valueRaw = line.slice(eq + 1).trim();
    const collectionState = createCollectionState();
    advanceCollectionState(collectionState, valueRaw);
    while (!isCollectionBalanced(collectionState)) {
      index += 1;
      if (index >= lines.length) {
        throw new Error(`[config] unterminated TOML collection for key "${keyPath.join('.')}"`);
      }
      const nextLine = stripTomlComment(lines[index]);
      if (!nextLine) {
        continue;
      }
      valueRaw += ` ${nextLine}`;
      advanceCollectionState(collectionState, nextLine);
    }
    const value = parseTomlValue(valueRaw);
    assignValueAtPath(currentTarget, keyPath, value);
  }
  return root;
}

// --- TOML Serializer ---

function escapeTomlKey(key: string): string {
  if (/^[A-Za-z0-9_-]+$/.test(key)) {
    return key;
  }
  return `"${key}"`;
}

function serializeTomlPrimitive(value: TomlPrimitive): string {
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  if (typeof value === 'number') {
    if (Number.isInteger(value)) {
      return String(value);
    }
    return String(value);
  }
  return String(value);
}

function serializeTomlValue(value: TomlValue): string {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return serializeTomlPrimitive(value);
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return '[]';
    }
    const items = value.map(serializeTomlValue);
    return `[${items.join(', ')}]`;
  }
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value);
    if (entries.length === 0) {
      return '{}';
    }
    const pairs = entries.map(([k, v]) => `${escapeTomlKey(k)} = ${serializeTomlValue(v)}`);
    return `{ ${pairs.join(', ')} }`;
  }
  return String(value);
}

function serializeTableBody(
  obj: Record<string, unknown>,
  parentPath: string[],
  lines: string[]
): void {
  const scalarKeys: string[] = [];
  const tableKeys: string[] = [];
  const arrayTableKeys: string[] = [];

  for (const [key, val] of Object.entries(obj)) {
    if (Array.isArray(val) && val.length > 0 && val.every(item => isRecord(item))) {
      arrayTableKeys.push(key);
    } else if (isRecord(val) && !Array.isArray(val)) {
      tableKeys.push(key);
    } else {
      scalarKeys.push(key);
    }
  }

  // Write scalars first
  for (const key of scalarKeys) {
    lines.push(`${escapeTomlKey(key)} = ${serializeTomlValue(obj[key] as TomlValue)}`);
  }
  if (scalarKeys.length > 0 && (tableKeys.length > 0 || arrayTableKeys.length > 0)) {
    lines.push('');
  }

  // Write sub-tables
  for (const key of tableKeys) {
    const tablePath = [...parentPath, escapeTomlKey(key)];
    lines.push(`[${tablePath.join('.')}]`);
    serializeTableBody(obj[key] as Record<string, unknown>, tablePath, lines);
  }

  // Write array-of-tables
  for (const key of arrayTableKeys) {
    const arr = obj[key] as Array<Record<string, unknown>>;
    const tablePath = [...parentPath, escapeTomlKey(key)];
    for (const item of arr) {
      lines.push(`[[${tablePath.join('.')}]]`);
      serializeTableBody(item, tablePath, lines);
    }
  }
}

export function serializeTomlRecord(obj: Record<string, unknown>): string {
  const lines: string[] = [];
  serializeTableBody(obj, [], lines);
  return lines.join('\n') + '\n';
}
