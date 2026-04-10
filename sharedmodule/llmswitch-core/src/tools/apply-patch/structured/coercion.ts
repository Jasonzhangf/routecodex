import type { StructuredApplyPatchChange, StructuredApplyPatchPayload } from '../structured.js';
import { isStructuredApplyPatchPayload } from '../structured.js';
import { tryParseJson } from '../json/parse-loose.js';
import { asString, type UnknownRecord } from '../validation/shared.js';

const resolveTopLevelFile = (record: UnknownRecord): string | undefined => {
  const direct =
    asString((record as any).file) ??
    asString((record as any).path) ??
    asString((record as any).filepath) ??
    asString((record as any).filename);
  if (direct) return direct;
  // Shape fix: treat top-level target as file path when changes exist.
  const target = asString((record as any).target);
  if (target && Array.isArray((record as any).changes) && (record as any).changes.length > 0) {
    return target;
  }
  return undefined;
};

const buildSingleChangePayload = (record: UnknownRecord): StructuredApplyPatchPayload | undefined => {
  const kindRaw = asString(record.kind);
  if (!kindRaw) return undefined;
  const change: StructuredApplyPatchChange = {
    kind: kindRaw.toLowerCase(),
    lines: (record as any).lines ?? (record as any).text ?? (record as any).body,
    target: asString((record as any).target) ?? undefined,
    anchor: asString((record as any).anchor) ?? undefined
  } as StructuredApplyPatchChange;
  if (typeof (record as any).use_anchor_indent === 'boolean') {
    (change as any).use_anchor_indent = (record as any).use_anchor_indent;
  }
  const changeFile =
    asString((record as any).file) ??
    asString((record as any).path) ??
    asString((record as any).filepath) ??
    asString((record as any).filename);
  if (changeFile) {
    (change as any).file = changeFile;
  }
  return { ...(changeFile ? { file: changeFile } : {}), changes: [change] };
};

const coerceChangesArray = (value: unknown): StructuredApplyPatchChange[] | undefined => {
  const parsed = tryParseJson(value);
  if (!parsed) return undefined;
  if (Array.isArray(parsed)) {
    const items = parsed.filter((entry) => entry && typeof entry === 'object') as StructuredApplyPatchChange[];
    if (!items.length) return undefined;
    // Ensure at least one entry looks like a structured change.
    if (!items.some((c) => typeof (c as any).kind === 'string' && String((c as any).kind).trim())) return undefined;
    return items;
  }
  if (parsed && typeof parsed === 'object' && Array.isArray((parsed as any).changes)) {
    const items = (parsed as any).changes.filter((entry: any) => entry && typeof entry === 'object') as StructuredApplyPatchChange[];
    if (!items.length) return undefined;
    if (!items.some((c) => typeof (c as any).kind === 'string' && String((c as any).kind).trim())) return undefined;
    return items;
  }
  return undefined;
};

export const coerceStructuredPayload = (record: UnknownRecord): StructuredApplyPatchPayload | undefined => {
  const topLevelFile = resolveTopLevelFile(record);

  if (isStructuredApplyPatchPayload(record)) {
    if (topLevelFile && !asString((record as any).file)) {
      return { ...(record as StructuredApplyPatchPayload), file: topLevelFile };
    }
    return record as StructuredApplyPatchPayload;
  }
  if (Array.isArray((record as any).changes) && (record as any).changes.length === 0) {
    return undefined;
  }
  // Common shape error: { file, instructions: "[{...},{...}]" } where instructions contains JSON changes.
  if (!Array.isArray((record as any).changes)) {
    const changesFromInstructions = coerceChangesArray((record as any).instructions);
    if (changesFromInstructions) {
      return {
        ...(topLevelFile ? { file: topLevelFile } : {}),
        changes: changesFromInstructions
      } as StructuredApplyPatchPayload;
    }
    // Another common shape: changes is a JSON string.
    const changesFromString = coerceChangesArray((record as any).changes);
    if (changesFromString) {
      return {
        ...(topLevelFile ? { file: topLevelFile } : {}),
        changes: changesFromString
      } as StructuredApplyPatchPayload;
    }
    const editsFromString = coerceChangesArray((record as any).edits ?? (record as any).operations ?? (record as any).ops);
    if (editsFromString) {
      return {
        ...(topLevelFile ? { file: topLevelFile } : {}),
        changes: editsFromString
      } as StructuredApplyPatchPayload;
    }
  }
  const single = buildSingleChangePayload(record);
  if (single) return single;
  return undefined;
};
