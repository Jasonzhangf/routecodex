import type { StructuredApplyPatchPayload } from '../structured.js';
import { coerceStructuredPayload } from '../structured/coercion.js';
import { tryParseJsonLoose } from '../json/parse-loose.js';
import { looksLikePatch } from '../patch-text/normalize.js';
import { asString, isRecord, type UnknownRecord } from '../validation/shared.js';

import { DEFAULT_APPLY_PATCH_NORMALIZE_ACTIONS } from './default-actions.js';
import { extractNormalizedPatch } from './extract-patch.js';
import {
  buildPatchFromChangesArray,
  buildPatchFromStructuredPayload,
  extractConflictPatchAsStructuredReplace,
  resolvePathAlias
} from './structured-builders.js';
import type {
  ApplyPatchExtraction,
  ApplyPatchNormalizeAction,
  ApplyPatchNormalizeOptions,
  ApplyPatchNormalizeResult,
  ApplyPatchNormalizeState
} from './types.js';

function getActionList(options?: ApplyPatchNormalizeOptions): ApplyPatchNormalizeAction[] {
  if (Array.isArray(options?.actions) && options?.actions.length > 0) {
    return options.actions;
  }
  return DEFAULT_APPLY_PATCH_NORMALIZE_ACTIONS;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}

function runRecordActions(
  record: UnknownRecord,
  state: ApplyPatchNormalizeState,
  actions: ApplyPatchNormalizeAction[],
  runNested: (argsString: string, rawArgs: unknown, depth: number) => ApplyPatchExtraction,
  isFinalPass: boolean
): ApplyPatchExtraction {
  for (const action of actions) {
    if (action.action === 'record_text_fields') {
      for (const field of action.fields) {
        const value = asString((record as Record<string, unknown>)[field]);
        const extracted = extractNormalizedPatch(value);
        if (extracted.patchText || extracted.failureReason) {
          return extracted;
        }
      }
      continue;
    }

    if (action.action === 'record_conflict_patch') {
      const patchFieldValue = asString((record as Record<string, unknown>)[action.patchField]);
      const pathAlias = resolvePathAlias(record, action.fileFields);
      const extracted = extractConflictPatchAsStructuredReplace(pathAlias, patchFieldValue ?? undefined);
      if (extracted.patchText || extracted.failureReason) {
        return extracted;
      }
      continue;
    }

    if (action.action === 'record_raw_envelope') {
      const rawEnvelope = asString((record as Record<string, unknown>)[action.field]);
      if (!rawEnvelope) {
        continue;
      }

      const fromEnvelope = extractNormalizedPatch(rawEnvelope.trim());
      if (fromEnvelope.patchText || fromEnvelope.failureReason) {
        return fromEnvelope;
      }

      if (action.parseJson === false) {
        continue;
      }

      const maxDepth = typeof action.maxDepth === 'number' ? action.maxDepth : 2;
      if (state.depth >= maxDepth) {
        continue;
      }

      const parsed = tryParseJsonLoose(rawEnvelope.trim());
      if (isRecord(parsed) || Array.isArray(parsed)) {
        const nested = runNested(rawEnvelope.trim(), parsed, state.depth + 1);
        if (nested.patchText || nested.failureReason) {
          return nested;
        }
      }
      continue;
    }

    if (action.action === 'record_object_envelope') {
      const maxDepth = typeof action.maxDepth === 'number' ? action.maxDepth : 2;
      if (state.depth >= maxDepth) {
        continue;
      }
      for (const field of action.fields) {
        const envelope = (record as Record<string, unknown>)[field];
        if (isRecord(envelope) || Array.isArray(envelope)) {
          const nestedJson = safeStringify(envelope);
          const nested = runNested(nestedJson, envelope, state.depth + 1);
          if (nested.patchText || nested.failureReason) {
            return nested;
          }
          continue;
        }
        if (action.parseJsonString === true) {
          const envelopeText = asString(envelope);
          if (!envelopeText) {
            continue;
          }
          const fromEnvelope = extractNormalizedPatch(envelopeText);
          if (fromEnvelope.patchText || fromEnvelope.failureReason) {
            return fromEnvelope;
          }
          const parsed = tryParseJsonLoose(envelopeText.trim());
          if (isRecord(parsed) || Array.isArray(parsed)) {
            const nested = runNested(envelopeText.trim(), parsed, state.depth + 1);
            if (nested.patchText || nested.failureReason) {
              return nested;
            }
          }
        }
      }
      continue;
    }

    if (action.action === 'record_structured_payload') {
      const payload = coerceStructuredPayload(record);
      const extracted = buildPatchFromStructuredPayload(payload as StructuredApplyPatchPayload | undefined);
      if (extracted.patchText || extracted.failureReason) {
        return extracted;
      }
      continue;
    }

    if (action.action === 'invalid_json_guard' && isFinalPass) {
      if (
        state.looksJsonContainer &&
        isRecord(state.rawArgs) &&
        Object.keys(state.rawArgs).length === 0 &&
        state.rawTrimmed.length > 0 &&
        !looksLikePatch(state.rawTrimmed)
      ) {
        return { failureReason: 'invalid_json' };
      }
    }
  }

  return {};
}

function runActions(
  state: ApplyPatchNormalizeState,
  actions: ApplyPatchNormalizeAction[],
  runNested: (argsString: string, rawArgs: unknown, depth: number) => ApplyPatchExtraction,
  isFinalPass: boolean
): ApplyPatchExtraction {
  for (const action of actions) {
    if (action.action === 'raw_non_json_patch') {
      if (!state.looksJsonContainer) {
        const extracted = extractNormalizedPatch(state.rawTrimmed);
        if (extracted.patchText || extracted.failureReason) {
          return extracted;
        }
      }
      continue;
    }

    if (action.action === 'json_container_patch_fallback') {
      if (state.looksJsonContainer && isRecord(state.rawArgs) && Object.keys(state.rawArgs).length === 0) {
        const extracted = extractNormalizedPatch(state.rawTrimmed);
        if (extracted.patchText || extracted.failureReason) {
          return extracted;
        }
      }
      continue;
    }

    if (action.action === 'array_structured_payload') {
      if (!Array.isArray(state.rawArgs) || state.rawArgs.length === 0) {
        continue;
      }

      const firstRecord = state.rawArgs.find((entry) => isRecord(entry)) as UnknownRecord | undefined;
      if (firstRecord && Array.isArray((firstRecord as { changes?: unknown }).changes)) {
        const extracted = runRecordActions(firstRecord, state, actions, runNested, isFinalPass);
        if (extracted.patchText || extracted.failureReason) {
          return extracted;
        }
        continue;
      }

      const changesArray = state.rawArgs.filter((entry) => isRecord(entry)) as UnknownRecord[];
      const extracted = buildPatchFromChangesArray(changesArray);
      if (extracted.patchText || extracted.failureReason) {
        return extracted;
      }
      continue;
    }

    if (action.action === 'raw_string_patch') {
      if (typeof state.rawArgs === 'string') {
        const extracted = extractNormalizedPatch(state.rawArgs);
        if (extracted.patchText || extracted.failureReason) {
          return extracted;
        }
      }
      continue;
    }

    if (isRecord(state.rawArgs)) {
      const extracted = runRecordActions(state.rawArgs, state, [action], runNested, isFinalPass);
      if (extracted.patchText || extracted.failureReason) {
        return extracted;
      }
    }
  }

  return {};
}

function normalizeState(argsString: string, rawArgs: unknown, depth: number): ApplyPatchNormalizeState {
  const rawTrimmed = typeof argsString === 'string' ? argsString.trim() : '';
  return {
    argsString,
    rawArgs,
    rawTrimmed,
    looksJsonContainer: rawTrimmed.startsWith('{') || rawTrimmed.startsWith('['),
    depth
  };
}

function resolveExtraction(
  argsString: string,
  rawArgs: unknown,
  actions: ApplyPatchNormalizeAction[],
  depth: number,
  isFinalPass: boolean
): ApplyPatchExtraction {
  const state = normalizeState(argsString, rawArgs, depth);
  const runNested = (nextArgsString: string, nextRawArgs: unknown, nextDepth: number): ApplyPatchExtraction => {
    return resolveExtraction(nextArgsString, nextRawArgs, actions, nextDepth, false);
  };
  return runActions(state, actions, runNested, isFinalPass);
}

export function normalizeApplyPatchArgs(
  argsString: string,
  rawArgs: unknown,
  options?: ApplyPatchNormalizeOptions
): ApplyPatchNormalizeResult {
  const actions = getActionList(options);
  const extracted = resolveExtraction(argsString, rawArgs, actions, 0, true);

  if (extracted.patchText) {
    return { ok: true, patchText: extracted.patchText };
  }
  if (extracted.failureReason) {
    return { ok: false, reason: extracted.failureReason };
  }
  return { ok: false, reason: 'missing_changes' };
}
