import type { ProcessedRequest, StandardizedRequest } from '../types/standardized.js';
import type { TargetMetadata } from '../../../router/virtual-router/types.js';
import {
  applyTargetMetadataWithNative,
  applyTargetToSubjectWithNative,
  extractTargetModelIdWithNative
} from '../../../router/virtual-router/engine-selection/native-hub-pipeline-target-semantics.js';

function replaceRecord(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const key of Object.keys(target)) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) {
      delete target[key];
    }
  }
  Object.assign(target, source);
}

export function applyTargetMetadata(
  metadata: Record<string, unknown> | undefined,
  target: TargetMetadata,
  routeName?: string,
  originalModel?: string
): void {
  if (!metadata || typeof metadata !== 'object') {
    return;
  }
  const updated = applyTargetMetadataWithNative(
    metadata,
    target as unknown as Record<string, unknown>,
    routeName,
    originalModel
  );
  replaceRecord(metadata, updated);
}

export function applyTargetToSubject(
  subject: StandardizedRequest | ProcessedRequest,
  target: TargetMetadata,
  originalModel?: string
): void {
  if (!subject || typeof subject !== 'object') {
    return;
  }
  const updated = applyTargetToSubjectWithNative(
    subject as unknown as Record<string, unknown>,
    target as unknown as Record<string, unknown>,
    originalModel
  );
  replaceRecord(subject as unknown as Record<string, unknown>, updated);
}

export function extractModelFromTarget(target: TargetMetadata): string | null {
  return extractTargetModelIdWithNative(target);
}
