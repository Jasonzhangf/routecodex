import { fuzzyFindInLines, FuzzyMatchResult } from './patch-text/fuzzy-match.js';

type UnknownRecord = Record<string, unknown>;

export type StructuredApplyPatchKind =
  | 'insert_after'
  | 'insert_before'
  | 'replace'
  | 'delete'
  | 'create_file'
  | 'delete_file';

export interface StructuredApplyPatchChange {
  file?: string;
  kind: StructuredApplyPatchKind | string;
  anchor?: string;
  target?: string;
  lines?: string[] | string;
  use_anchor_indent?: boolean;
}

export interface StructuredApplyPatchPayload extends Record<string, unknown> {
  instructions?: string;
  file?: string;
  changes: StructuredApplyPatchChange[];
}

export class StructuredApplyPatchError extends Error {
  reason: string;
  constructor(reason: string, message: string) {
    super(message);
    this.reason = reason;
  }
}

/**
 * Unicode 标准化：用于字符串比较
 * 兼容不同 Unicode 形式 (NFC/NFD) 和空白字符
 */
const normalizeForCompare = (line: string): string => {
  if (!line) return '';
  let normalized = line.normalize('NFC');

  // 1. 统一各种 Unicode 空白字符为普通空格
  // 扩展空白字符范围：包括不间断空格、各种空格宽度、行/段分隔符等
  normalized = normalized.replace(/[\u00A0\u2000-\u200B\u2028\u2029\u202F\u205F\u3000\uFEFF]/g, ' ');

  // 2. 处理尾部空白字符（空格、制表符等）
  // 注意：这里只修剪尾部，保留前导空白（缩进）
  // 这样可以避免因为尾部空格导致的匹配失败
  normalized = normalized.replace(/[ \t]+$/g, '');

  return normalized;
};

interface UpdateFileSection {
  type: 'update';
  hunks: string[][];
}

interface AddFileSection {
  type: 'add';
  lines: string[];
}

interface DeleteFileSection {
  type: 'delete';
}

interface ReplaceFileSection {
  type: 'replace';
  lines: string[];
}

type FileSection = UpdateFileSection | AddFileSection | DeleteFileSection | ReplaceFileSection;

const SUPPORTED_KINDS: StructuredApplyPatchKind[] = [
  'insert_after',
  'insert_before',
  'replace',
  'delete',
  'create_file',
  'delete_file'
];

const FILE_PATH_INVALID_RE = /[\r\n]/;

const decodeEscapedNewlinesIfObvious = (value: string): string => {
  if (!value) return value;
  if (value.includes('\n')) return value;
  const lower = value.toLowerCase();
  const looksEscaped =
    value.includes('\\r\\n') ||
    (value.includes('\\n') && /\\n[ \t]/.test(value)) ||
    lower.includes('\\u000a') ||
    lower.includes('\\u000d');
  if (!looksEscaped) {
    return value;
  }
  let out = value;
  out = out.replace(/\\r\\n/g, '\n');
  out = out.replace(/\\n/g, '\n');
  out = out.replace(/\\r/g, '\n');
  out = out.replace(/\\u000a/gi, '\n');
  out = out.replace(/\\u000d/gi, '\n');
  return out;
};

const toSafeString = (value: unknown, label: string): string => {
  const str = typeof value === 'string' ? value : '';
  if (!str.trim()) {
    throw new StructuredApplyPatchError('missing_field', `${label} is required`);
  }
  return str;
};

const normalizeFilePath = (raw: string, label: string): string => {
  let trimmed = raw.trim();
  if (!trimmed) {
    throw new StructuredApplyPatchError('invalid_file', `${label} must not be empty`);
  }
  if (FILE_PATH_INVALID_RE.test(trimmed)) {
    const firstLine = trimmed.split(/[\r\n]/)[0]?.trim() ?? '';
    if (!firstLine) {
      throw new StructuredApplyPatchError('invalid_file', `${label} must be a single-line path`);
    }
    trimmed = firstLine;
  }
  return trimmed.replace(/\\/g, '/');
};

const readStringish = (value: unknown): string | undefined => {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.length === 1 && typeof value[0] === 'string') return String(value[0]);
  if (value && typeof value === 'object') {
    const rec = value as Record<string, unknown>;
    const nested = readStringish(rec.path ?? rec.file ?? rec.filename ?? rec.filepath);
    if (nested) return nested;
  }
  return undefined;
};

const splitTextIntoLines = (input: string): string[] => {
  // 兼容性增强：检测并统一换行符
  let detected = input;
  const crlfCount = (input.match(/\r\n/g) || []).length;
  if (crlfCount > 0) {
    // 统一 CRLF 为 LF
    detected = input.replace(/\r\n/g, '\n');
  }

  const decoded = decodeEscapedNewlinesIfObvious(detected);
  const normalized = decoded.replace(/\r/g, '');
  const parts = normalized.split('\n');
  if (parts.length && parts[parts.length - 1] === '') {
    parts.pop();
  }
  return parts.length ? parts : [''];
};

const normalizeLines = (value: unknown, label: string): string[] => {
  if (Array.isArray(value)) {
    if (!value.length) {
      return [];
    }
    const out: string[] = [];
    for (const [idx, entry] of value.entries()) {
      if (typeof entry !== 'string') {
        if (entry === null || entry === undefined) {
          out.push('');
          continue;
        }
        out.push(String(entry));
        continue;
      }
      // Preserve intentional whitespace
      const normalized = entry.replace(/\r/g, '');
      const decoded = decodeEscapedNewlinesIfObvious(normalized);
      if (decoded.includes('\n')) {
        out.push(...splitTextIntoLines(decoded));
      } else {
        out.push(decoded);
      }
    }
    return out;
  }
  if (typeof value === 'string') {
    return splitTextIntoLines(value);
  }
  if (value === null || value === undefined) {
    throw new StructuredApplyPatchError('invalid_lines', `${label} must be an array of strings or a multi-line string`);
  }
  return [String(value)];
};

const buildContextLines = (raw: string): string[] => splitTextIntoLines(raw).map((line) => ` ${line}`);

const buildPrefixedLines = (lines: string[], prefix: string): string[] => lines.map((line) => `${prefix}${line}`);

const findSubsequence = (haystack: string[], needle: string[]): number => {
  if (!needle.length) return -1;
  const normalizedHaystack = haystack.map(normalizeForCompare);
  const normalizedNeedle = needle.map(normalizeForCompare);
  outer: for (let i = 0; i + needle.length <= haystack.length; i += 1) {
    for (let j = 0; j < needle.length; j += 1) {
      if (normalizedHaystack[i + j] !== normalizedNeedle[j]) continue outer;
    }
    return i;
  }
  return -1;
};


/**
 * Fuzzy-enhanced subsequence finder
 * Falls back to fuzzy matching strategies when exact match fails
 */
const findSubsequenceWithFuzzy = (haystack: string[], needle: string[]): { index: number; strategy?: string } => {
  const exactIndex = findSubsequence(haystack, needle);
  if (exactIndex >= 0) return { index: exactIndex, strategy: "exact" };

  // Fallback to fuzzy matching
  const fuzzyMatches = fuzzyFindInLines(haystack, needle, 0.15);
  if (fuzzyMatches.length === 1) {
    return { index: fuzzyMatches[0].startLine, strategy: fuzzyMatches[0].strategy };
  }
  if (fuzzyMatches.length > 1) {
    // Multiple fuzzy matches - pick the highest similarity
    const best = fuzzyMatches.reduce((a, b) => a.similarity > b.similarity ? a : b);
    return { index: best.startLine, strategy: best.strategy };
  }

  return { index: -1 };
};
const tryApplyToFileLines = (
  section: AddFileSection | ReplaceFileSection,
  kindRaw: StructuredApplyPatchKind,
  change: StructuredApplyPatchChange,
  changeRec: UnknownRecord,
  index: number
): boolean => {
  const lines = section.lines;

  if (kindRaw === 'insert_after' || kindRaw === 'insert_before') {
    const anchorSource =
      (change as any).anchor ??
      (change as any).target ??
      (change as any).context ??
      (change as any).from ??
      (change as any).old ??
      (change as any).oldText ??
      (change as any).old_text ??
      (change as any).beforeText ??
      (change as any).before_text;
    const anchor = toSafeString(anchorSource, `changes[${index}].anchor`);
    const anchorLines = splitTextIntoLines(anchor);
    const anchorResult = findSubsequenceWithFuzzy(lines, anchorLines);
    const anchorIndex = anchorResult.index;
    if (anchorResult.strategy !== "exact" && anchorResult.strategy) {
      console.log(`[apply_patch] fuzzy match applied for anchor: strategy=${anchorResult.strategy}`);
    }
    if (anchorIndex < 0) {
      // 兼容性增强：保持原语义（返回 false），避免抛异常
      return false;
    }

    const linesSource =
      changeRec.lines ??
      changeRec.text ??
      changeRec.content ??
      changeRec.body ??
      (changeRec as any).replacement ??
      (changeRec as any).newText ??
      (changeRec as any).new_text ??
      (changeRec as any).afterText ??
      (changeRec as any).after_text;
    const additions = normalizeLines(linesSource, `changes[${index}].lines`);
    if (!additions.length) {
      throw new StructuredApplyPatchError('invalid_lines', `changes[${index}].lines must include at least one line`);
    }
    const prepared =
      kindRaw === 'insert_after'
        ? applyAnchorIndent(additions, anchorLines, 'last', change.use_anchor_indent)
        : applyAnchorIndent(additions, anchorLines, 'first', change.use_anchor_indent);
    const insertAt = kindRaw === 'insert_after' ? anchorIndex + anchorLines.length : anchorIndex;
    lines.splice(insertAt, 0, ...prepared);
    return true;
  }

  if (kindRaw === 'replace' || kindRaw === 'delete') {
    const targetSource =
      (change as any).target ??
      (change as any).anchor ??
      (change as any).context ??
      (change as any).from ??
      (change as any).old ??
      (change as any).oldText ??
      (change as any).old_text ??
      (change as any).beforeText ??
      (change as any).before_text;
    const target = toSafeString(targetSource, `changes[${index}].target`);
    const targetLines = splitTextIntoLines(target);
    const targetResult = findSubsequenceWithFuzzy(lines, targetLines);
    const targetIndex = targetResult.index;
    if (targetResult.strategy !== "exact" && targetResult.strategy) {
      console.log(`[apply_patch] fuzzy match applied for target: strategy=${targetResult.strategy}`);
    }
    if (targetIndex < 0) {
      // 兼容性增强：保持原语义（返回 false），避免抛异常
      return false;
    }

    if (kindRaw === 'delete') {
      lines.splice(targetIndex, targetLines.length);
      return true;
    }

    const linesSource =
      changeRec.lines ??
      changeRec.text ??
      changeRec.content ??
      changeRec.body ??
      (changeRec as any).replacement ??
      (changeRec as any).newText ??
      (changeRec as any).new_text ??
      (changeRec as any).afterText ??
      (changeRec as any).after_text;
    let replacements: string[];
    if ((linesSource === null || linesSource === undefined) && typeof (change as any).anchor === 'string' && typeof (change as any).target === 'string') {
      replacements = splitTextIntoLines(String((change as any).anchor));
    } else {
      replacements = normalizeLines(linesSource, `changes[${index}].lines`);
    }
    lines.splice(targetIndex, targetLines.length, ...replacements);
    return true;
  }

  return false;
};

const detectIndentFromAnchor = (anchorLines: string[], mode: 'first' | 'last'): string => {
  const source = mode === 'first' ? anchorLines[0] ?? '' : anchorLines[anchorLines.length - 1] ?? '';
  const match = source.match(/^(\s*)/);
  return match ? match[1] ?? '' : '';
};

const applyAnchorIndent = (lines: string[], anchorLines: string[], position: 'first' | 'last', enabled: boolean | undefined): string[] => {
  if (!enabled) {
    return lines;
  }
  const indent = detectIndentFromAnchor(anchorLines, position);
  if (!indent) {
    return lines;
  }
  return lines.map((line) => {
    if (!line.trim()) {
      return line;
    }
    if (/^\s/.test(line)) {
      return line;
    }
    return `${indent}${line}`;
  });
};

export function buildStructuredPatch(payload: StructuredApplyPatchPayload): string {
  if (!payload || typeof payload !== 'object') {
    throw new StructuredApplyPatchError('missing_payload', 'apply_patch arguments must be a JSON object');
  }
  if (!Array.isArray(payload.changes) || payload.changes.length === 0) {
    throw new StructuredApplyPatchError('missing_changes', 'apply_patch requires a non-empty "changes" array');
  }

  const topLevelFile =
    typeof payload.file === 'string' && payload.file.trim()
      ? normalizeFilePath(payload.file, 'file')
      : typeof (payload as UnknownRecord).path === 'string' && String((payload as UnknownRecord).path).trim()
        ? normalizeFilePath(String((payload as UnknownRecord).path), 'path')
        : typeof (payload as UnknownRecord).filepath === 'string' && String((payload as UnknownRecord).filepath).trim()
          ? normalizeFilePath(String((payload as UnknownRecord).filepath), 'filepath')
          : typeof (payload as UnknownRecord).filename === 'string' && String((payload as UnknownRecord).filename).trim()
            ? normalizeFilePath(String((payload as UnknownRecord).filename), 'filename')
        : undefined;

  const sectionOrder: string[] = [];
  const fileSections = new Map<string, FileSection>();

  const ensureUpdateSection = (file: string): UpdateFileSection => {
    const existing = fileSections.get(file);
    if (existing) {
      if (existing.type !== 'update') {
        throw new StructuredApplyPatchError('invalid_change_sequence', `File "${file}" already marked as ${existing.type}`);
      }
      return existing;
    }
    const created: UpdateFileSection = { type: 'update', hunks: [] };
    sectionOrder.push(file);
    fileSections.set(file, created);
    return created;
  };

  for (const [index, change] of payload.changes.entries()) {
    if (!change || typeof change !== 'object') {
      throw new StructuredApplyPatchError('invalid_change', `Change at index ${index} must be an object`);
    }
    const changeRec = change as unknown as Record<string, unknown>;
    const kindRaw = typeof change.kind === 'string' ? change.kind.trim().toLowerCase() : '';
    if (!kindRaw) {
      throw new StructuredApplyPatchError('invalid_change_kind', `Change at index ${index} is missing "kind"`);
    }
    if (!SUPPORTED_KINDS.includes(kindRaw as StructuredApplyPatchKind)) {
      throw new StructuredApplyPatchError('invalid_change_kind', `Unsupported change kind "${change.kind}" at index ${index}`);
    }
    const fileSource =
      readStringish(changeRec.file) ??
      readStringish(changeRec.path) ??
      readStringish((changeRec as any).filepath) ??
      readStringish((changeRec as any).filename) ??
      readStringish((changeRec as any).file_path);
    const file = fileSource ? normalizeFilePath(fileSource, `changes[${index}].file`) : topLevelFile;
    if (!file) {
      throw new StructuredApplyPatchError('invalid_file', `Change at index ${index} is missing "file"`);
    }

    if (kindRaw === 'create_file') {
      const linesSource = changeRec.lines ?? changeRec.text ?? changeRec.content ?? changeRec.body ?? (changeRec as any).replacement;
      const lines = normalizeLines(linesSource, `changes[${index}].lines`);
      const existing = fileSections.get(file);
      if (!existing) {
        sectionOrder.push(file);
        fileSections.set(file, { type: 'add', lines });
      } else if (existing.type === 'delete') {
        // Common model behavior: delete_file + create_file for same path → treat as replace.
        fileSections.set(file, { type: 'replace', lines });
      } else if (existing.type === 'add') {
        // Idempotent: last create wins.
        fileSections.set(file, { type: 'add', lines });
      } else if (existing.type === 'replace') {
        fileSections.set(file, { type: 'replace', lines });
      } else {
        // Existing updates imply file existed; represent as delete+add to keep a single executable path.
        fileSections.set(file, { type: 'replace', lines });
      }
      continue;
    }

    if (kindRaw === 'delete_file') {
      const existing = fileSections.get(file);
      if (!existing) {
        sectionOrder.push(file);
        fileSections.set(file, { type: 'delete' });
        continue;
      }
      if (existing.type === 'add') {
        // create_file then delete_file → net no-op; drop the section entirely.
        fileSections.delete(file);
        const idx = sectionOrder.indexOf(file);
        if (idx >= 0) sectionOrder.splice(idx, 1);
        continue;
      }
      // update/replace/delete then delete_file → net delete.
      fileSections.set(file, { type: 'delete' });
      continue;
    }

    // Common shape: replace with lines but no target → treat as full-file replacement.
    if (kindRaw === 'replace') {
      const targetSource =
        (change as any).target ??
        (change as any).anchor ??
        (change as any).context ??
        (change as any).from ??
        (change as any).old ??
        (change as any).oldText ??
        (change as any).old_text ??
        (change as any).beforeText ??
        (change as any).before_text;
      const hasTarget = typeof targetSource === 'string' && targetSource.trim().length > 0;
      const linesSource =
        changeRec.lines ??
        changeRec.text ??
        changeRec.content ??
        changeRec.body ??
        (changeRec as any).replacement ??
        (changeRec as any).newText ??
        (changeRec as any).new_text ??
        (changeRec as any).afterText ??
        (changeRec as any).after_text;
      const hasReplacementBody = !(linesSource === null || linesSource === undefined);
      if (!hasTarget && hasReplacementBody) {
        const lines = normalizeLines(linesSource, `changes[${index}].lines`);
        const existing = fileSections.get(file);
        if (!existing) {
          sectionOrder.push(file);
        }
        // Prefer a deterministic executable output: delete+add (replace).
        fileSections.set(file, { type: 'replace', lines });
        continue;
      }
    }

    const existing = fileSections.get(file);
    // Shape fix: allow create_file + subsequent structured edits by applying edits to the created content in-memory.
    if (existing && (existing.type === 'add' || existing.type === 'replace')) {
      const applied = tryApplyToFileLines(existing, kindRaw as StructuredApplyPatchKind, change, changeRec, index);
      if (applied) {
        continue;
      }
      throw new StructuredApplyPatchError('invalid_change_sequence', `File "${file}" already marked as ${existing.type}`);
    }

    const section = ensureUpdateSection(file);
    switch (kindRaw) {
      case 'insert_after': {
        const anchorSource =
          (change as any).anchor ??
          (change as any).target ??
          (change as any).context ??
          (change as any).from ??
          (change as any).old ??
          (change as any).oldText ??
          (change as any).old_text ??
          (change as any).beforeText ??
          (change as any).before_text;
        const anchor = toSafeString(anchorSource, `changes[${index}].anchor`);
        const anchorLines = splitTextIntoLines(anchor);
        const linesSource =
          changeRec.lines ??
          changeRec.text ??
          changeRec.content ??
          changeRec.body ??
          (changeRec as any).replacement ??
          (changeRec as any).newText ??
          (changeRec as any).new_text ??
          (changeRec as any).afterText ??
          (changeRec as any).after_text;
        const additions = normalizeLines(linesSource, `changes[${index}].lines`);
        if (!additions.length) {
          throw new StructuredApplyPatchError('invalid_lines', `changes[${index}].lines must include at least one line`);
        }
        const prepared = applyAnchorIndent(additions, anchorLines, 'last', change.use_anchor_indent);
        const hunkBody = [...buildContextLines(anchor), ...buildPrefixedLines(prepared, '+')];
        section.hunks.push(hunkBody);
        break;
      }
      case 'insert_before': {
        const anchorSource =
          (change as any).anchor ??
          (change as any).target ??
          (change as any).context ??
          (change as any).from ??
          (change as any).old ??
          (change as any).oldText ??
          (change as any).old_text ??
          (change as any).beforeText ??
          (change as any).before_text;
        const anchor = toSafeString(anchorSource, `changes[${index}].anchor`);
        const anchorLines = splitTextIntoLines(anchor);
        const linesSource =
          changeRec.lines ??
          changeRec.text ??
          changeRec.content ??
          changeRec.body ??
          (changeRec as any).replacement ??
          (changeRec as any).newText ??
          (changeRec as any).new_text ??
          (changeRec as any).afterText ??
          (changeRec as any).after_text;
        const additions = normalizeLines(linesSource, `changes[${index}].lines`);
        if (!additions.length) {
          throw new StructuredApplyPatchError('invalid_lines', `changes[${index}].lines must include at least one line`);
        }
        const prepared = applyAnchorIndent(additions, anchorLines, 'first', change.use_anchor_indent);
        const hunkBody = [...buildPrefixedLines(prepared, '+'), ...buildContextLines(anchor)];
        section.hunks.push(hunkBody);
        break;
      }
      case 'replace': {
        // 兼容仅提供 anchor 的 replace 形态：将 anchor 视为 target 以尽可能保留用户意图。
        const targetSource =
          (change as any).target ??
          (change as any).anchor ??
          (change as any).context ??
          (change as any).from ??
          (change as any).old ??
          (change as any).oldText ??
          (change as any).old_text ??
          (change as any).beforeText ??
          (change as any).before_text;
        const target = toSafeString(targetSource, `changes[${index}].target`);
        const linesSource =
          changeRec.lines ??
          changeRec.text ??
          changeRec.content ??
          changeRec.body ??
          (changeRec as any).replacement ??
          (changeRec as any).newText ??
          (changeRec as any).new_text ??
          (changeRec as any).afterText ??
          (changeRec as any).after_text;
        let replacements: string[];
        if ((linesSource === null || linesSource === undefined) && typeof (change as any).anchor === 'string' && typeof (change as any).target === 'string') {
          // Common model mistake: provide { anchor: <new>, target: <old> } but omit lines.
          // Treat anchor as replacement body (shape fix only).
          replacements = splitTextIntoLines(String((change as any).anchor));
        } else {
          replacements = normalizeLines(linesSource, `changes[${index}].lines`);
        }
        const hunkBody = [
          ...buildPrefixedLines(splitTextIntoLines(target), '-'),
          ...buildPrefixedLines(replacements, '+')
        ];
        section.hunks.push(hunkBody);
        break;
      }
      case 'delete': {
        const targetSource =
          (change as any).target ??
          (change as any).anchor ??
          (change as any).context ??
          (change as any).from ??
          (change as any).old ??
          (change as any).oldText ??
          (change as any).old_text ??
          (change as any).beforeText ??
          (change as any).before_text;
        const target = toSafeString(targetSource, `changes[${index}].target`);
        const hunkBody = buildPrefixedLines(splitTextIntoLines(target), '-');
        section.hunks.push(hunkBody);
        break;
      }
      default: {
        throw new StructuredApplyPatchError('invalid_change_kind', `Unsupported change kind "${change.kind}" at index ${index}`);
      }
    }
  }

  if (!sectionOrder.length) {
    throw new StructuredApplyPatchError('missing_changes', 'apply_patch payload produced no file operations');
  }

  const lines: string[] = ['*** Begin Patch'];
  for (const file of sectionOrder) {
    const section = fileSections.get(file);
    if (!section) continue;
    if (section.type === 'add') {
      lines.push(`*** Add File: ${file}`);
      for (const line of section.lines) {
        lines.push(`+${line}`);
      }
    } else if (section.type === 'delete') {
      lines.push(`*** Delete File: ${file}`);
    } else if (section.type === 'replace') {
      lines.push(`*** Delete File: ${file}`);
      lines.push(`*** Add File: ${file}`);
      for (const line of section.lines) {
        lines.push(`+${line}`);
      }
    } else {
      lines.push(`*** Update File: ${file}`);
      const hunks = section.hunks || [];
      for (const hunk of hunks) {
        // 结构化补丁仅负责生成统一 diff 形态，不对多段 hunk 做逻辑裁剪；
        // 具体哪些 hunk 能成功应用由 apply_patch 客户端自行校验并返回错误信息。
        for (const entry of hunk) {
          if (!entry.startsWith('@@')) {
            lines.push(entry);
          }
        }
      }
    }
  }
  lines.push('*** End Patch');
  return lines.join('\n');
}

export function isStructuredApplyPatchPayload(candidate: unknown): candidate is StructuredApplyPatchPayload {
  if (!candidate || typeof candidate !== 'object') {
    return false;
  }
  const record = candidate as UnknownRecord;
  if (!Array.isArray(record.changes)) {
    return false;
  }
  return true;
}
