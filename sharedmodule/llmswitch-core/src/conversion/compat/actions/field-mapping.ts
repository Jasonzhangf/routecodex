type MappingType = 'string' | 'number' | 'boolean' | 'object' | 'array';

export interface FieldMapping {
  sourcePath: string;
  targetPath: string;
  type: MappingType;
  transform?: string;
}

export interface FieldMappingConfig {
  incomingMappings: FieldMapping[];
  outgoingMappings: FieldMapping[];
}

type UnknownRecord = Record<string, unknown>;

const MODEL_PREFIX_NORMALIZATION: Record<string, string> = {
  'gpt-': 'glm-'
};

const FINISH_REASON_MAP: Record<string, string> = {
  tool_calls: 'tool_calls',
  stop: 'stop',
  length: 'length',
  sensitive: 'content_filter',
  network_error: 'error'
};

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function applyFieldMappings(payload: UnknownRecord, mappings: FieldMapping[]): UnknownRecord {
  const result: UnknownRecord = { ...payload };
  for (const mapping of mappings) {
    applySingleMapping(result, mapping);
  }
  return result;
}

function applySingleMapping(root: UnknownRecord, mapping: FieldMapping): void {
  const sourceValue = getNestedProperty(root, mapping.sourcePath);
  if (sourceValue === undefined) {
    return;
  }
  const transformed = convertType(applyTransform(sourceValue, mapping.transform), mapping.type);
  setNestedProperty(root, mapping.targetPath, transformed);
}

function applyTransform(value: unknown, transform?: string): unknown {
  if (!transform) {
    return value;
  }
  switch (transform) {
    case 'timestamp':
      return typeof value === 'number' ? value : Date.now();
    case 'lowercase':
      return typeof value === 'string' ? value.toLowerCase() : value;
    case 'uppercase':
      return typeof value === 'string' ? value.toUpperCase() : value;
    case 'normalizeModelName':
      if (typeof value === 'string') {
        for (const [prefix, replacement] of Object.entries(MODEL_PREFIX_NORMALIZATION)) {
          if (value.startsWith(prefix)) {
            return value.replace(prefix, replacement);
          }
        }
      }
      return value;
    case 'normalizeFinishReason':
      if (typeof value === 'string') {
        return FINISH_REASON_MAP[value] ?? value;
      }
      return value;
    default:
      return value;
  }
}

function convertType(value: unknown, targetType: MappingType): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  switch (targetType) {
    case 'string':
      return String(value);
    case 'number': {
      const num = Number(value);
      return Number.isNaN(num) ? 0 : num;
    }
    case 'boolean':
      return Boolean(value);
    case 'object':
      return isRecord(value) ? value : {};
    case 'array':
      return Array.isArray(value) ? value : [value];
    default:
      return value;
  }
}

function getNestedProperty(obj: UnknownRecord, pathExpression: string): unknown {
  const keys = pathExpression.split('.');
  if (pathExpression.includes('[*]')) {
    return getWildcardProperty(obj, keys);
  }
  return keys.reduce<unknown>((current, key) => {
    if (!isRecord(current)) {
      return undefined;
    }
    return current[key];
  }, obj);
}

function getWildcardProperty(obj: UnknownRecord, keys: string[]): unknown[] {
  const results: unknown[] = [];
  const processWildcard = (current: unknown, keyIndex: number): void => {
    if (keyIndex >= keys.length) {
      results.push(current);
      return;
    }
    const key = keys[keyIndex];
    if (key === '[*]') {
      if (Array.isArray(current)) {
        current.forEach(item => processWildcard(item, keyIndex + 1));
      }
      return;
    }
    if (isRecord(current) && current[key] !== undefined) {
      processWildcard(current[key], keyIndex + 1);
    }
  };
  processWildcard(obj, 0);
  return results;
}

function setNestedProperty(obj: UnknownRecord, pathExpression: string, value: unknown): void {
  const keys = pathExpression.split('.');
  if (pathExpression.includes('[*]')) {
    setWildcardProperty(obj, keys, value);
    return;
  }
  const lastKey = keys.pop();
  if (!lastKey) {
    return;
  }
  const target = keys.reduce<UnknownRecord>((current, key) => {
    if (!isRecord(current[key])) {
      current[key] = {};
    }
    return current[key] as UnknownRecord;
  }, obj);
  target[lastKey] = value;
}

function setWildcardProperty(obj: UnknownRecord, keys: string[], value: unknown): void {
  const processSetWildcard = (current: unknown, keyIndex: number): void => {
    if (keyIndex >= keys.length - 1) {
      const lastKey = keys[keys.length - 1].replace('[*]', '');
      if (Array.isArray(current)) {
        current.forEach(item => {
          if (isRecord(item)) {
            item[lastKey] = value;
          }
        });
      }
      return;
    }
    const key = keys[keyIndex];
    if (key === '[*]') {
      if (Array.isArray(current)) {
        current.forEach(item => processSetWildcard(item, keyIndex + 1));
      }
      return;
    }
    if (isRecord(current)) {
      processSetWildcard(current[key], keyIndex + 1);
    }
  };
  processSetWildcard(obj, 0);
}
