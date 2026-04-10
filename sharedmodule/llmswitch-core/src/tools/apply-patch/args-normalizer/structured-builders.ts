import {
  buildStructuredPatch,
  StructuredApplyPatchError,
  type StructuredApplyPatchPayload,
  type StructuredApplyPatchChange
} from '../structured.js';
import { asString, type UnknownRecord } from '../validation/shared.js';

import type { ApplyPatchExtraction } from './types.js';

export function resolvePathAlias(record: UnknownRecord, fileFields: string[]): string | undefined {
  for (const field of fileFields) {
    const value = asString((record as Record<string, unknown>)[field]);
    if (value) {
      return value;
    }
  }
  return undefined;
}

function safeBuildStructuredPatch(payload: StructuredApplyPatchPayload): ApplyPatchExtraction {
  try {
    return { patchText: buildStructuredPatch(payload) };
  } catch (error) {
    if (!(error instanceof StructuredApplyPatchError)) {
      throw error;
    }
    return { failureReason: error.reason || 'structured_apply_patch_error' };
  }
}

export function buildPatchFromChangesArray(changesArray: UnknownRecord[]): ApplyPatchExtraction {
  if (!changesArray.length || !changesArray.some((change) => typeof (change as { kind?: unknown }).kind === 'string')) {
    return {};
  }
  const payload: StructuredApplyPatchPayload = {
    changes: changesArray as unknown as StructuredApplyPatchChange[]
  };
  return safeBuildStructuredPatch(payload);
}

export function buildPatchFromStructuredPayload(payload: StructuredApplyPatchPayload | undefined): ApplyPatchExtraction {
  if (!payload) {
    return {};
  }
  return safeBuildStructuredPatch(payload);
}

export function extractConflictPatchAsStructuredReplace(
  filePath: string | undefined,
  conflictText: string | undefined
): ApplyPatchExtraction {
  const safeFilePath = typeof filePath === 'string' ? filePath.trim() : '';
  const safeText = typeof conflictText === 'string' ? conflictText : '';
  if (!safeFilePath || !safeText) {
    return {};
  }

  const lines = safeText.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  let start = -1;
  let middle = -1;
  let end = -1;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (start < 0) {
      if (line.startsWith('<<<<<<<')) {
        start = index;
      }
      continue;
    }
    if (middle < 0) {
      if (line.startsWith('=======')) {
        middle = index;
      }
      continue;
    }
    if (line.startsWith('>>>>>>>')) {
      end = index;
      break;
    }
  }

  if (start < 0 || middle <= start || end <= middle) {
    return {};
  }

  const original = lines.slice(start + 1, middle).join('\n');
  const updated = lines.slice(middle + 1, end).join('\n');
  if (!original.trim() || !updated.trim()) {
    return {};
  }

  return safeBuildStructuredPatch({
    file: safeFilePath,
    changes: [
      {
        kind: 'replace',
        target: original,
        lines: updated
      }
    ]
  });
}
