import { looksLikePatch } from './looks-like-patch.js';
import { convertGitDiffToApplyPatch } from './git-diff.js';
import { convertContextDiffToApplyPatch } from './context-diff.js';
import os from 'node:os';
import path from 'node:path';

const normalizeBeginEndMarkers = (input: string): string => {
  try {
    const lines = input.replace(/\r\n/g, '\n').split('\n');
    if (!lines.length) return input;
    const first = String(lines[0] ?? '').trim().toLowerCase();
    if (first.startsWith('*** begin patch')) {
      lines[0] = '*** Begin Patch';
    }
    const lastIndex = lines.length - 1;
    const last = String(lines[lastIndex] ?? '').trim().toLowerCase();
    if (last.startsWith('*** end patch')) {
      lines[lastIndex] = '*** End Patch';
    }
    return lines.join('\n');
  } catch {
    return input;
  }
};

const isLikelyPatchFilePath = (value: string): boolean => {
  const v = String(value || '').trim();
  if (!v) return false;
  if (v === '/dev/null') return true;
  if (/[\r\n]/.test(v)) return false;
  if (v.includes('@@') || v.includes('***')) return false;
  if (/^(?:index\s|---\s|\+\+\+\s)/.test(v)) return false;
  return true;
};

const normalizeDiffHeaderPath = (value: string): string => {
  let out = String(value || '').trim();
  if (!out) return '';
  out = out.split('\t')[0]?.trim() ?? '';
  out = out.replace(/\s+\*\*\*$/g, '').trim();

  // GNU diff headers may carry timestamp/metadata after two+ spaces.
  const tsSplit = out.match(
    /^(.+?)\s{2,}(?:\d{4}-\d{2}-\d{2}|\w{3}\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4}).*$/
  );
  if (tsSplit?.[1]) {
    out = tsSplit[1].trim();
  }

  const m = out.match(/^(?:a\/|b\/)?(.+)$/);
  out = (m && m[1] ? m[1] : out).trim();
  if (!isLikelyPatchFilePath(out)) return '';
  return out;
};

const convertUnifiedDiffToApplyPatchIfPossible = (text: string): string | null => {
  try {
    if (!text) return null;
    const normalizedText = text
      .replace(/^\+\+\+\+\s+/gm, '+++ ')
      .replace(/^@@@@(\s|$)/gm, '@@$1');
    if (normalizedText.includes('diff --git')) {
      return convertGitDiffToApplyPatch(normalizedText);
    }
    const minusMatch = normalizedText.match(/^---\s+(.*)$/m);
    const plusMatch = normalizedText.match(/^\+{3,4}\s+(.*)$/m);
    if (!minusMatch || !plusMatch) return null;
    const rawMinus = (minusMatch[1] || '').split('\t')[0] || '';
    const rawPlus = (plusMatch[1] || '').split('\t')[0] || '';
    const minusPath = normalizeDiffHeaderPath(rawMinus);
    const plusPath = normalizeDiffHeaderPath(rawPlus);
    const filePath = plusPath === '/dev/null' ? minusPath : plusPath;
    if (!filePath) return null;
    const synthetic = `diff --git a/${filePath} b/${filePath}\n${normalizedText}`;
    const converted = convertGitDiffToApplyPatch(synthetic);
    if (converted && converted.includes('*** Add File:')) {
      const hasAddedLine = converted.split('\n').some((line) => line.startsWith('+'));
      const sourceLines = normalizedText.split('\n');
      const sourceHasBodyWithoutPatchPrefix = sourceLines.slice(2).some((line) => {
        const trimmed = line.trim();
        if (!trimmed) return false;
        if (trimmed.startsWith('@@')) return false;
        if (trimmed.startsWith('+')) return false;
        return true;
      });
      if (!hasAddedLine && sourceHasBodyWithoutPatchPrefix) {
        return null;
      }
    }
    return converted;
  } catch {
    return null;
  }
};

const convertStarHeaderDiffToApplyPatchIfPossible = (text: string): string | null => {
  try {
    if (!text || text.includes('diff --git')) return null;
    const lines = text
      .replace(/\r\n/g, '\n')
      .replace(/^\+\+\+\+\s+/gm, '+++ ')
      .replace(/^@@@@(\s|$)/gm, '@@$1')
      .split('\n');
    if (lines.length < 3) return null;

    const first = String(lines[0] ?? '').trim();
    const second = String(lines[1] ?? '').trim();
    // 兼容性增强：支持 *** / --- (context diff) 和 --- / +++ (unified diff) 两种头部组合
    const isContextHeader = first.startsWith('*** ') && second.startsWith('--- ');
    const isUnifiedHeader = first.startsWith('--- ') && second.startsWith('+++ ');
    const isMalformedUnifiedHeader = first.startsWith('*** ') && second.startsWith('+++ ');
    if (!isContextHeader && !isUnifiedHeader && !isMalformedUnifiedHeader) return null;
    if (first.startsWith('*** Add File:') || first.startsWith('*** Update File:') || first.startsWith('*** Delete File:')) {
      return null;
    }
    if (!lines.some((line) => line.startsWith('@@'))) return null;

    // 兼容性增强：处理 --- a/file 格式（多一个空格）
    const extractPath = (line: string): string => {
      let path = line.trim();
      // 移除 --- 或 *** 前缀
      if (path.startsWith('--- ')) path = path.slice(4).trim();
      else if (path.startsWith('+++ ')) path = path.slice(4).trim();
      else if (path.startsWith('++++ ')) path = path.slice(5).trim();
      else if (path.startsWith('*** ')) path = path.slice(4).trim();
      // 移除 a/ 或 b/ 前缀
      if (path.startsWith('a/')) path = path.slice(2);
      else if (path.startsWith('b/')) path = path.slice(2);
      return normalizeDiffHeaderPath(path);
    };
    const oldPath = extractPath(first);
    const newPath = extractPath(second);
    const body = lines.slice(2);

    const out: string[] = ['*** Begin Patch'];
    if (oldPath === '/dev/null' && newPath && newPath !== '/dev/null') {
      out.push(`*** Add File: ${newPath}`);
      for (const line of body) {
        if (line.startsWith('@@')) continue;
        if (line.startsWith('+')) {
          out.push(line);
          continue;
        }
        out.push(`+${line}`);
      }
      out.push('*** End Patch');
      return out.join('\n');
    }

    if (newPath === '/dev/null' && oldPath && oldPath !== '/dev/null') {
      out.push(`*** Delete File: ${oldPath}`);
      out.push('*** End Patch');
      return out.join('\n');
    }

    const filePath = newPath || oldPath;
    if (!filePath) return null;
    out.push(`*** Update File: ${filePath}`);
    for (const line of body) {
      out.push(line);
    }
    out.push('*** End Patch');
    return out.join('\n');
  } catch {
    return null;
  }
};

const normalizeApplyPatchHeaderPath = (raw: string): string => {
  let out = String(raw ?? '').trim();
  if (!out) return out;
  if (
    (out.startsWith('"') && out.endsWith('"')) ||
    (out.startsWith("'") && out.endsWith("'")) ||
    (out.startsWith('`') && out.endsWith('`'))
  ) {
    out = out.slice(1, -1).trim();
  }
  const embeddedHomeMarker = out.indexOf('/~/');
  if (embeddedHomeMarker >= 0) {
    out = out.slice(embeddedHomeMarker + 1).trim();
  }
  if (out === '~') {
    out = os.homedir();
  } else if (out.startsWith('~/')) {
    out = path.join(os.homedir(), out.slice(2));
  }
  out = out.replace(/\s+\*\*\*$/g, '').trim();
  return out;
};

const normalizeApplyPatchFileHeader = (line: string): string => {
  const startMatch = line.match(/^\*\*\* Start File:\s*(.+?)(?:\s+\*\*\*)?\s*$/);
  if (startMatch && startMatch[1]) {
    const normalized = normalizeApplyPatchHeaderPath(startMatch[1]);
    if (!isLikelyPatchFilePath(normalized) || normalized === '/dev/null') return line;
    return `*** Update File: ${normalized}`;
  }
  const addMatch = line.match(/^\*\*\* Add File:\s*(.+?)(?:\s+\*\*\*)?\s*$/);
  if (addMatch && addMatch[1]) {
    const normalized = normalizeApplyPatchHeaderPath(addMatch[1]);
    if (!isLikelyPatchFilePath(normalized) || normalized === '/dev/null') return line;
    return `*** Add File: ${normalized}`;
  }
  const updateMatch = line.match(/^\*\*\* Update File:\s*(.+?)(?:\s+\*\*\*)?\s*$/);
  if (updateMatch && updateMatch[1]) {
    const normalized = normalizeApplyPatchHeaderPath(updateMatch[1]);
    if (!isLikelyPatchFilePath(normalized) || normalized === '/dev/null') return line;
    return `*** Update File: ${normalized}`;
  }
  const deleteMatch = line.match(/^\*\*\* Delete File:\s*(.+?)(?:\s+\*\*\*)?\s*$/);
  if (deleteMatch && deleteMatch[1]) {
    const normalized = normalizeApplyPatchHeaderPath(deleteMatch[1]);
    if (!isLikelyPatchFilePath(normalized) || normalized === '/dev/null') return line;
    return `*** Delete File: ${normalized}`;
  }
  return line;
};

const stripCodeFences = (text: string): string => {
  const trimmed = text.trim();
  // Only treat the entire payload as fenced when it *starts* with a code fence.
  // Patch bodies (especially added Markdown files) may legitimately contain ``` blocks;
  // we must not strip those.
  if (!trimmed.startsWith('```')) return text;
  const fenceRe = /^```(?:diff|patch|apply_patch|text|json)?[ \t]*\n([\s\S]*?)\n```/gmi;
  const candidates: string[] = [];
  let match: RegExpExecArray | null = null;
  while ((match = fenceRe.exec(trimmed))) {
    if (match[1]) candidates.push(match[1].trim());
  }
  if (!candidates.length) return text;
  for (const candidate of candidates) {
    if (
      candidate.includes('*** Begin Patch') ||
      candidate.includes('*** Update File:') ||
      candidate.includes('diff --git')
    ) {
      return candidate;
    }
  }
  return candidates[0] ?? text;
};

const decodeEscapedNewlinesIfNeeded = (value: string): string => {
  try {
    if (!value) return value;

    // 统计真实换行符数量
    const realNewlineCount = (value.match(/\n/g) || []).length;

    // 检查是否有任何转义的换行符
    const hasEscapedNewline =
      value.includes('\\n') ||
      value.includes('\\r') ||
      /\\u000[ad]/i.test(value) ||
      /\\x0[ad]/i.test(value);

    if (!hasEscapedNewline) return value;

    // 启发式判断：
    // 1. 如果没有真实换行符，肯定需要解码转义的换行符
    // 2. 如果有少量真实换行符（<=3），但有很多转义换行符，说明是混合内容，尝试解码
    // 3. 如果有大量真实换行符（>3），说明 patch 已经格式化好了，不处理转义的换行符
    //    （这种情况下的转义换行符可能是代码字符串字面量的一部分）
    if (realNewlineCount > 3) {
      // 已经有足够的真实换行符，不处理转义的换行符
      return value;
    }

    let decoded = value;

    // 1. 先处理组合的 \r\n（必须先处理，避免 \r 和 \n 被单独处理）
    decoded = decoded.replace(/\\r\\n/g, '\n');

    // 2. 处理独立的 \r 和 \n
    decoded = decoded.replace(/\\r/g, '\n');
    decoded = decoded.replace(/\\n/g, '\n');

    // 3. 处理 Unicode 转义序列（\u000a = LF, \u000d = CR）
    decoded = decoded.replace(/\\u000a/gi, '\n');
    decoded = decoded.replace(/\\u000d/gi, '\n');

    // 4. 处理十六进制转义序列（\x0a = LF, \x0d = CR）
    decoded = decoded.replace(/\\x0a/gi, '\n');
    decoded = decoded.replace(/\\x0d/gi, '\n');

    return decoded;
  } catch {
    return value;
  }
};

const stripConflictMarkers = (text: string): string => {
  try {
    const lines = text.replace(/\r\n/g, '\n').split('\n');
    const out: string[] = [];
    for (const line of lines) {
      if (line.startsWith('<<<<<<<') || line.startsWith('=======') || line.startsWith('>>>>>>>')) {
        continue;
      }
      out.push(line);
    }
    return out.join('\n');
  } catch {
    return text;
  }
};

const splitInlineBeginPatchFileHeader = (text: string): string => {
  if (!text) return text;
  return text.replace(
    /\*\*\*\s*Begin Patch(?:\s*\*\*\*)?\s*(Create|Add|Update|Delete)\s+File:\s*([^\n]+?)(?:\s+\*\*\*)?(?=\n|$)/gi,
    (_m, actionRaw: string, pathRaw: string) => {
      const action = String(actionRaw || '').trim().toLowerCase();
      const mappedAction = action === 'create' ? 'Add' : `${action.charAt(0).toUpperCase()}${action.slice(1)}`;
      const path = String(pathRaw || '').trim();
      return `*** Begin Patch\n*** ${mappedAction} File: ${path}`;
    }
  );
};

const repairMissingHunkHeaderSafely = (patchText: string): string => {
  try {
    const lines = patchText.split('\n');
    const out: string[] = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i] ?? '';
      const updateMatch = line.match(/^\*\*\* Update File:\s*(.+)$/);
      if (!updateMatch) {
        out.push(line);
        i += 1;
        continue;
      }

      const normalizedFilePath = normalizeApplyPatchHeaderPath(String(updateMatch[1] ?? '').trim());
      const sectionBody: string[] = [];
      i += 1;
      while (i < lines.length) {
        const next = lines[i] ?? '';
        if (
          next.startsWith('*** Update File:') ||
          next.startsWith('*** Add File:') ||
          next.startsWith('*** Delete File:') ||
          next.startsWith('*** End Patch')
        ) {
          break;
        }
        sectionBody.push(next);
        i += 1;
      }

      const hasHunk = sectionBody.some((entry) => entry.startsWith('@@'));
      if (hasHunk || !isLikelyPatchFilePath(normalizedFilePath) || normalizedFilePath === '/dev/null') {
        out.push(line, ...sectionBody);
        continue;
      }

      const meaningful = sectionBody.filter((entry) => entry.trim().length > 0);
      const hasAdd = meaningful.some((entry) => entry.startsWith('+') && !entry.startsWith('+++'));
      const hasDel = meaningful.some((entry) => entry.startsWith('-') && !entry.startsWith('---'));
      const onlyPatchPrefixed = meaningful.every((entry) => {
        if (entry.startsWith(' ') || entry.startsWith('@@')) return true;
        if (entry.startsWith('+') && !entry.startsWith('+++')) return true;
        if (entry.startsWith('-') && !entry.startsWith('---')) return true;
        return false;
      });

      // 安全白名单：仅当已经是“显式 +/- diff 行”但缺失 @@ 时，自动补 @@；
      // 不做整文件替换等语义猜测。
      if (hasAdd && hasDel && onlyPatchPrefixed) {
        out.push(`*** Update File: ${normalizedFilePath}`);
        out.push('@@');
        out.push(...sectionBody);
      } else {
        out.push(line, ...sectionBody);
      }
    }
    return out.join('\n');
  } catch {
    return patchText;
  }
};

const repairLegacyContextDiffHunksInsideApplyPatchEnvelope = (patchText: string): string => {
  try {
    const lines = patchText.split('\n');
    const out: string[] = [];
    const legacyOldHeaderRe = /^\*\*\*\s+\d+(?:,\d+)?(?:\s+\*{3,4})?\s*$/;
    const legacyNewHeaderRe = /^---\s+\d+(?:,\d+)?(?:\s+-{3,4})?\s*$/;
    const decodeLegacyOldLine = (raw: string): { kind: 'context' | 'delete'; text: string } => {
      const lineText = String(raw ?? '');
      const lead = lineText[0] ?? '';
      if (lead === '!' || lead === '-') {
        let rest = lineText.slice(1);
        if (rest.startsWith(' ')) rest = rest.slice(1);
        return { kind: 'delete', text: rest };
      }
      if (lead === ' ') {
        return { kind: 'context', text: lineText.slice(1) };
      }
      return { kind: 'context', text: lineText };
    };
    const decodeLegacyNewLine = (raw: string): { kind: 'context' | 'add'; text: string } => {
      const lineText = String(raw ?? '');
      const lead = lineText[0] ?? '';
      if (lead === '!' || lead === '+') {
        let rest = lineText.slice(1);
        if (rest.startsWith(' ')) rest = rest.slice(1);
        return { kind: 'add', text: rest };
      }
      if (lead === ' ') {
        return { kind: 'context', text: lineText.slice(1) };
      }
      return { kind: 'add', text: lineText };
    };
    let i = 0;
    while (i < lines.length) {
      const line = lines[i] ?? '';
      const updateMatch = line.match(/^\*\*\* Update File:\s*(.+)$/);
      if (!updateMatch) {
        out.push(line);
        i += 1;
        continue;
      }

      const filePath = normalizeApplyPatchHeaderPath(String(updateMatch[1] ?? '').trim());
      const sectionBody: string[] = [];
      i += 1;
      while (i < lines.length) {
        const next = lines[i] ?? '';
        if (
          next.startsWith('*** Update File:') ||
          next.startsWith('*** Add File:') ||
          next.startsWith('*** Delete File:') ||
          next.startsWith('*** End Patch')
        ) {
          break;
        }
        sectionBody.push(next);
        i += 1;
      }

      const hasModernHunk = sectionBody.some((entry) => entry.startsWith('@@'));
      const hasLegacyContextHeader = sectionBody.some((entry) => legacyOldHeaderRe.test(entry));
      const hasLegacyContextOtherSide = sectionBody.some((entry) => legacyNewHeaderRe.test(entry));
      if (!hasModernHunk && hasLegacyContextHeader && hasLegacyContextOtherSide && filePath && filePath !== '/dev/null') {
        const convertedSectionBody: string[] = [];
        let j = 0;
        let convertedAny = false;
        while (j < sectionBody.length) {
          const current = sectionBody[j] ?? '';
          if (!legacyOldHeaderRe.test(current)) {
            convertedSectionBody.push(current);
            j += 1;
            continue;
          }
          j += 1;
          const oldLines: string[] = [];
          while (j < sectionBody.length && !legacyNewHeaderRe.test(sectionBody[j] ?? '')) {
            if (legacyOldHeaderRe.test(sectionBody[j] ?? '')) break;
            oldLines.push(sectionBody[j] ?? '');
            j += 1;
          }
          if (j >= sectionBody.length || !legacyNewHeaderRe.test(sectionBody[j] ?? '')) {
            convertedSectionBody.push(current, ...oldLines);
            break;
          }
          j += 1;
          const newLines: string[] = [];
          while (j < sectionBody.length && !legacyOldHeaderRe.test(sectionBody[j] ?? '')) {
            newLines.push(sectionBody[j] ?? '');
            j += 1;
          }

          convertedSectionBody.push('@@');
          const oldOps = oldLines.map(decodeLegacyOldLine);
          const newOps = newLines.map(decodeLegacyNewLine);
          let oi = 0;
          let ni = 0;
          while (oi < oldOps.length || ni < newOps.length) {
            const o = oi < oldOps.length ? oldOps[oi] : null;
            const n = ni < newOps.length ? newOps[ni] : null;
            if (o && n && o.kind === 'context' && n.kind === 'context' && o.text === n.text) {
              convertedSectionBody.push(` ${o.text}`);
              oi += 1;
              ni += 1;
              continue;
            }
            if (o && o.kind === 'delete') {
              convertedSectionBody.push(`-${o.text}`);
              oi += 1;
              if (n && n.kind === 'add') {
                convertedSectionBody.push(`+${n.text}`);
                ni += 1;
              }
              continue;
            }
            if (n && n.kind === 'add') {
              convertedSectionBody.push(`+${n.text}`);
              ni += 1;
              continue;
            }
            if (o && o.kind === 'context') {
              convertedSectionBody.push(` ${o.text}`);
              oi += 1;
              continue;
            }
            if (n && n.kind === 'context') {
              convertedSectionBody.push(` ${n.text}`);
              ni += 1;
              continue;
            }
            if (o) oi += 1;
            if (n) ni += 1;
          }
          convertedAny = true;
        }
        if (convertedAny) {
          out.push(`*** Update File: ${filePath}`, ...convertedSectionBody);
          continue;
        }
      }

      out.push(line, ...sectionBody);
    }
    return out.join('\n');
  } catch {
    return patchText;
  }
};

const isIgnorableGitMetadataLineInUpdateSection = (line: string): boolean => {
  return (
    line.startsWith('diff --git ') ||
    line.startsWith('index ') ||
    line.startsWith('similarity index ') ||
    line.startsWith('dissimilarity index ') ||
    line.startsWith('old mode ') ||
    line.startsWith('new mode ') ||
    line.startsWith('deleted file mode ') ||
    line.startsWith('new file mode ')
  );
};

const extractRenameTargetFromGitMetadata = (line: string): string | null => {
  const renameToMatch = line.match(/^rename to\s+(.+)$/);
  if (!renameToMatch?.[1]) return null;
  const normalized = normalizeDiffHeaderPath(renameToMatch[1]);
  return normalized || null;
};

export const normalizeApplyPatchText = (raw: string): string => {
  if (!raw) return raw;
  let text = raw.replace(/\r\n/g, '\n');
  text = decodeEscapedNewlinesIfNeeded(text);
  text = stripCodeFences(text);
  text = text.trim();
  if (!text) return raw;

  text = stripConflictMarkers(text);
  text = splitInlineBeginPatchFileHeader(text);
  text = normalizeBeginEndMarkers(text);

  // Some models emit non-apply_patch diffs wrapped in apply_patch markers, e.g.:
  //   *** Begin Patch ***
  //   --- a/file
  //   +++ b/file
  //   @@ ...
  //   *** End Patch ***
  // or:
  //   *** Begin Patch
  //   *** a/file
  //   --- b/file
  //   ***************
  // Convert them to apply_patch format so the client tool can execute them.
  if (
    text.startsWith('*** Begin Patch') &&
    !text.includes('*** Update File:') &&
    !text.includes('*** Add File:') &&
    !text.includes('*** Delete File:')
  ) {
    const lines = text.split('\n');
    const inner = lines
      .filter((l, idx) => {
        if (idx === 0 && l.startsWith('*** Begin Patch')) return false;
        if (idx === lines.length - 1 && l.startsWith('*** End Patch')) return false;
        return true;
      })
      .join('\n')
      .trim();
    const converted =
      convertUnifiedDiffToApplyPatchIfPossible(inner) ||
      convertStarHeaderDiffToApplyPatchIfPossible(inner) ||
      convertContextDiffToApplyPatch(inner);
    if (converted) {
      text = converted;
    }
  }

  if (!text.includes('*** Begin Patch') && text.includes('diff --git')) {
    const converted = convertGitDiffToApplyPatch(text);
    if (converted) text = converted;
  } else if (!text.includes('*** Begin Patch') && !text.includes('diff --git')) {
    const converted = convertStarHeaderDiffToApplyPatchIfPossible(text);
    if (converted) text = converted;
  }

  if (
    !text.includes('*** Begin Patch') &&
    !text.includes('diff --git') &&
    text.includes('***************') &&
    /^\*\*\*\s+\S+/m.test(text) &&
    /^---\s+\S+/m.test(text)
  ) {
    // Support classic "context diff" format:
    //   *** path
    //   --- path
    //   ***************
    //   *** 1,2 ****
    //   --- 1,3 ----
    const converted = convertContextDiffToApplyPatch(text);
    if (converted) text = converted;
  } else if (!text.includes('*** Begin Patch') && !text.includes('diff --git')) {
    const converted = convertUnifiedDiffToApplyPatchIfPossible(text);
    if (converted) text = converted;
  }

  text = text.replace(/\*\*\* Create File:/g, '*** Add File:');
  text = text
    .split('\n')
    .map((line) => normalizeApplyPatchFileHeader(line))
    .join('\n');
  text = repairLegacyContextDiffHunksInsideApplyPatchEnvelope(text);

  let hasBegin = text.includes('*** Begin Patch');
  const hasEnd = text.includes('*** End Patch');
  if (hasBegin && !hasEnd) {
    text = `${text}\n*** End Patch`;
  }
  if (!hasBegin && /^\*\*\* (Add|Update|Delete) File:/m.test(text)) {
    text = `*** Begin Patch\n${text}\n*** End Patch`;
    hasBegin = true;
  }

  if (!text.includes('*** Begin Patch')) {
    return text;
  }

  let beginLineMatch = text.match(/^\s*\*\*\*\s*Begin Patch\b/m);
  if (!beginLineMatch) {
    const inlineBeginIndex = text.indexOf('*** Begin Patch');
    const inlineEndIndex = inlineBeginIndex >= 0 ? text.indexOf('*** End Patch', inlineBeginIndex) : -1;
    if (inlineBeginIndex >= 0 && inlineEndIndex > inlineBeginIndex) {
      const inlineCandidate = text.slice(inlineBeginIndex, inlineEndIndex + '*** End Patch'.length);
      if (
        inlineCandidate.includes('*** Add File:') ||
        inlineCandidate.includes('*** Update File:') ||
        inlineCandidate.includes('*** Delete File:')
      ) {
        text = inlineCandidate;
        beginLineMatch = text.match(/^\s*\*\*\*\s*Begin Patch\b/m);
      }
    }
  }
  if (!beginLineMatch) {
    return text;
  }
  const beginIndex = typeof beginLineMatch.index === 'number' ? beginLineMatch.index : 0;
  if (beginIndex > 0) {
    text = text.slice(beginIndex);
  }
  const endMarker = '*** End Patch';
  const firstEndIndex = text.indexOf(endMarker);
  const concatSignatures = [
    `${endMarker}","input":"*** Begin Patch`,
    `${endMarker}","patch":"*** Begin Patch`,
    `${endMarker}\\",\\"input\\":\\"*** Begin Patch`,
    `${endMarker}\\",\\"patch\\":\\"*** Begin Patch`
  ];
  const hasConcatenationSignal = concatSignatures.some((sig) => text.includes(sig));
  if (hasConcatenationSignal && firstEndIndex >= 0) {
    text = text.slice(0, firstEndIndex + endMarker.length);
  } else {
    const lastEndIndex = text.lastIndexOf(endMarker);
    if (lastEndIndex >= 0) {
      const afterEnd = text.slice(lastEndIndex + endMarker.length);
      if (afterEnd.trim().length > 0) {
        text = text.slice(0, lastEndIndex + endMarker.length);
      }
    }
  }

  // Fix missing prefix lines in Update File sections: treat as context (" ").
  const lines = text.split('\n');
  const output: string[] = [];
  let inUpdateSection = false;
  let inAddSection = false;
  let afterUpdateHeader = false;
  let currentHunkImplicitPrefix: '+' | '-' | ' ' | null = null;
  for (const line of lines) {
    if (line.startsWith('*** Begin Patch')) {
      output.push(line);
      inUpdateSection = false;
      inAddSection = false;
      afterUpdateHeader = false;
      currentHunkImplicitPrefix = null;
      continue;
    }
    if (line.startsWith('*** End Patch')) {
      output.push(line);
      inUpdateSection = false;
      inAddSection = false;
      afterUpdateHeader = false;
      currentHunkImplicitPrefix = null;
      continue;
    }
    if (line.startsWith('*** Update File:')) {
      output.push(line);
      inUpdateSection = true;
      inAddSection = false;
      afterUpdateHeader = true;
      currentHunkImplicitPrefix = null;
      continue;
    }
    if (line.startsWith('*** Add File:')) {
      output.push(line);
      inUpdateSection = false;
      inAddSection = true;
      afterUpdateHeader = false;
      currentHunkImplicitPrefix = null;
      continue;
    }
    if (inUpdateSection) {
      if (afterUpdateHeader && line.trim() === '') {
        continue;
      }
      afterUpdateHeader = false;

      if (line.startsWith('*** Move to:')) {
        output.push(line);
        continue;
      }

      const renameTarget = extractRenameTargetFromGitMetadata(line);
      if (renameTarget) {
        output.push(`*** Move to: ${renameTarget}`);
        continue;
      }

      if (line.startsWith('rename from ')) {
        continue;
      }

      if (isIgnorableGitMetadataLineInUpdateSection(line)) {
        continue;
      }

      // 兼容性增强：处理 Update File 块内的 GNU diff 格式
      // 如果遇到 ---/+++ 行，说明是 GNU diff 格式，跳过这些行
      if (line.match(/^---\s+(a\/)?(.+)$/)) {
        // Skip --- lines in Update File sections
        continue;
      }
      if (line.match(/^\+{3,4}\s+(b\/)?(.+)$/)) {
        // Skip +++ lines in Update File sections
        continue;
      }
      if (line.startsWith('@@')) {
        currentHunkImplicitPrefix = null;
        output.push(line);
      } else if (line.startsWith('+')) {
        currentHunkImplicitPrefix = '+';
        output.push(line);
      } else if (line.startsWith('-')) {
        currentHunkImplicitPrefix = '-';
        output.push(line);
      } else if (line.startsWith(' ')) {
        currentHunkImplicitPrefix = ' ';
        output.push(line);
      } else {
        const inferredPrefix = currentHunkImplicitPrefix === '+' || currentHunkImplicitPrefix === '-'
          ? currentHunkImplicitPrefix
          : ' ';
        output.push(`${inferredPrefix}${line}`);
      }
      continue;
    }
    if (inAddSection) {
      if (line.startsWith('+')) {
        output.push(line);
      } else {
        output.push(`+${line}`);
      }
      continue;
    }
    output.push(line);
  }
  // 严格语法模式：仅做格式归一，不推测业务语义（例如不猜测整文件替换）。
  // 安全白名单：仅修复“已有 +/- diff 但缺失 @@”的纯格式问题。
  return repairMissingHunkHeaderSafely(output.join('\n'));
};

export { looksLikePatch };
