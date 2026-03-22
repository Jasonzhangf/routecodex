type MappingType = 'string' | 'number' | 'boolean' | 'object' | 'array';
import { applyFieldMappingsWithNative } from '../../../router/virtual-router/engine-selection/native-compat-action-semantics.js';

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

export function applyFieldMappings(payload: UnknownRecord, mappings: FieldMapping[]): UnknownRecord {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return payload;
  }

  return applyFieldMappingsWithNative(
    payload,
    Array.isArray(mappings) ? mappings : []
  ) as UnknownRecord;
}
