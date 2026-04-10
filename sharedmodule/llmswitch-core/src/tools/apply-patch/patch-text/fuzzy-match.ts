// fuzzy-match.ts - Multi-strategy fuzzy matching for apply_patch

export interface FuzzyMatchResult {
  startLine: number;
  endLine: number;
  strategy: string;
  similarity: number;
}

export interface FuzzyFindResult {
  newContent: string;
  matchCount: number;
  error?: string;
  strategyUsed?: string;
}

export function fuzzyFindAndReplace(
  content: string,
  oldString: string,
  newString: string,
  replaceAll: boolean = false
): FuzzyFindResult {
  if (!oldString) {
    return { newContent: content, matchCount: 0, error: 'old_string cannot be empty' };
  }
  if (oldString === newString) {
    return { newContent: content, matchCount: 0, error: 'old_string and new_string are identical' };
  }

  const strategies: Array<[string, (c: string, p: string) => FuzzyMatchResult[]]> = [
    ['exact', strategyExact],
    ['line_trimmed', strategyLineTrimmed],
    ['whitespace_normalized', strategyWhitespaceNormalized],
    ['indentation_flexible', strategyIndentationFlexible],
    ['escape_normalized', strategyEscapeNormalized],
    ['trimmed_boundary', strategyTrimmedBoundary],
    ['block_anchor', strategyBlockAnchor],
    ['context_aware', strategyContextAware],
  ];

  for (const [name, fn] of strategies) {
    const matches = fn(content, oldString);
    if (matches.length > 0) {
      if (matches.length > 1 && !replaceAll) {
        return { newContent: content, matchCount: 0, error: `Found ${matches.length} matches` };
      }
      return { newContent: applyReplacements(content, matches, newString), matchCount: matches.length, strategyUsed: name };
    }
  }
  return { newContent: content, matchCount: 0, error: 'No match found' };
}

export function fuzzyFindInLines(contentLines: string[], patternLines: string[], threshold = 0.10): FuzzyMatchResult[] {
  if (!patternLines.length || !contentLines.length) return [];

  const strategies: Array<[string, (l: string[], p: string[]) => FuzzyMatchResult[]]> = [
    ['exact', strategyLinesExact],
    ['line_trimmed', strategyLinesTrimmed],
    ['indentation_flexible', strategyLinesIndentationFlexible],
    ['block_anchor', strategyLinesBlockAnchor],
    ['context_aware', strategyLinesContextAware],
  ];

  for (const [, fn] of strategies) {
    const matches = fn(contentLines, patternLines);
    const filtered = matches.filter(m => m.similarity >= threshold);
    if (filtered.length > 0) return filtered;
  }
  return [];
}

function strategyExact(content: string, pattern: string): FuzzyMatchResult[] {
  const idx = content.indexOf(pattern);
  if (idx === -1) return [];
  const startLine = content.substring(0, idx).split('\n').length - 1;
  const endLine = startLine + pattern.split('\n').length;
  return [{ startLine, endLine, strategy: 'exact', similarity: 1.0 }];
}

function strategyLineTrimmed(content: string, pattern: string): FuzzyMatchResult[] {
  return strategyLinesTrimmed(content.split('\n'), pattern.split('\n'));
}

function strategyWhitespaceNormalized(content: string, pattern: string): FuzzyMatchResult[] {
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
  const cLines = content.split('\n').map(norm);
  const pLines = pattern.split('\n').map(norm);
  const matches = findExactLineSequence(cLines, pLines);
  return matches.map(m => ({ ...m, strategy: 'whitespace_normalized', similarity: 0.90 }));
}

function strategyIndentationFlexible(content: string, pattern: string): FuzzyMatchResult[] {
  return strategyLinesIndentationFlexible(content.split('\n'), pattern.split('\n'));
}

function strategyEscapeNormalized(content: string, pattern: string): FuzzyMatchResult[] {
  const decode = (s: string) => s.replace(/\\r\\n/g, '\n').replace(/\\r/g, '\n').replace(/\\n/g, '\n');
  if (!content.includes('\\n') && !pattern.includes('\\n')) return [];
  return strategyExact(decode(content), decode(pattern));
}

function strategyTrimmedBoundary(content: string, pattern: string): FuzzyMatchResult[] {
  const cLines = content.split('\n');
  const pLines = pattern.split('\n');
  if (pLines.length < 2) return [];
  const tc = cLines.map((l, i) => (i === 0 || i === cLines.length - 1) ? l.trim() : l);
  const tp = pLines.map((l, i) => (i === 0 || i === pLines.length - 1) ? l.trim() : l);
  return findExactLineSequence(tc, tp).map(m => ({ ...m, strategy: 'trimmed_boundary', similarity: 0.95 }));
}

function strategyBlockAnchor(content: string, pattern: string): FuzzyMatchResult[] {
  return strategyLinesBlockAnchor(content.split('\n'), pattern.split('\n'));
}

function strategyContextAware(content: string, pattern: string): FuzzyMatchResult[] {
  return strategyLinesContextAware(content.split('\n'), pattern.split('\n'));
}

function strategyLinesExact(cLines: string[], pLines: string[]): FuzzyMatchResult[] {
  return findExactLineSequence(cLines, pLines).map(m => ({ ...m, strategy: 'exact', similarity: 1.0 }));
}

function strategyLinesTrimmed(cLines: string[], pLines: string[]): FuzzyMatchResult[] {
  return findExactLineSequence(cLines.map(l => l.trim()), pLines.map(l => l.trim()))
    .map(m => ({ ...m, strategy: 'line_trimmed', similarity: 0.95 }));
}

function strategyLinesIndentationFlexible(cLines: string[], pLines: string[]): FuzzyMatchResult[] {
  return findExactLineSequence(cLines.map(l => l.trim()), pLines.map(l => l.trim()))
    .map(m => ({ ...m, strategy: 'indentation_flexible', similarity: 0.85 }));
}

function strategyLinesBlockAnchor(cLines: string[], pLines: string[]): FuzzyMatchResult[] {
  if (pLines.length < 2) return [];
  const firstP = pLines[0].trim();
  const lastP = pLines[pLines.length - 1].trim();
  const len = pLines.length;

  const potentials: number[] = [];
  for (let i = 0; i <= cLines.length - len; i++) {
    if (cLines[i].trim() === firstP && cLines[i + len - 1].trim() === lastP) potentials.push(i);
  }

  const results: FuzzyMatchResult[] = [];
  for (const start of potentials) {
    const sim = len <= 2 ? 1.0 : calculateSimilarity(
      cLines.slice(start + 1, start + len - 1).join('\n'),
      pLines.slice(1, -1).join('\n')
    );
    if (sim >= (potentials.length === 1 ? 0.10 : 0.30)) {
      results.push({ startLine: start, endLine: start + len, strategy: 'block_anchor', similarity: sim });
    }
  }
  return results;
}

function strategyLinesContextAware(cLines: string[], pLines: string[]): FuzzyMatchResult[] {
  const len = pLines.length;
  const results: FuzzyMatchResult[] = [];

  for (let i = 0; i <= cLines.length - len; i++) {
    const block = cLines.slice(i, i + len);
    let highSim = 0;
    for (let j = 0; j < len; j++) {
      if (calculateSimilarity(pLines[j].trim(), block[j].trim()) >= 0.80) highSim++;
    }
    if (highSim >= len * 0.5) {
      results.push({ startLine: i, endLine: i + len, strategy: 'context_aware', similarity: highSim / len });
    }
  }
  return results;
}

function findExactLineSequence(hay: string[], needle: string[]): Array<{ startLine: number; endLine: number }> {
  if (!needle.length) return [];
  const results: Array<{ startLine: number; endLine: number }> = [];
  for (let i = 0; i <= hay.length - needle.length; i++) {
    let match = true;
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) { match = false; break; }
    }
    if (match) results.push({ startLine: i, endLine: i + needle.length });
  }
  return results;
}

function applyReplacements(content: string, matches: FuzzyMatchResult[], newStr: string): string {
  const lines = content.split('\n');
  for (const m of [...matches].sort((a, b) => b.startLine - a.startLine)) {
    lines.splice(m.startLine, m.endLine - m.startLine, ...newStr.split('\n'));
  }
  return lines.join('\n');
}

function calculateSimilarity(a: string, b: string): number {
  if (a === b) return 1.0;
  if (!a || !b) return 0.0;
  const aChars = a.split('');
  const bChars = b.split('');
  const bSet = new Set(bChars);
  const intersectionSize = aChars.filter(c => bSet.has(c)).length;
  const aSetSize = new Set(aChars).size;
  const bSetSize = bSet.size;
  const unionSize = aSetSize + bSetSize - intersectionSize;
  return unionSize > 0 ? intersectionSize / unionSize : 0.0;
}
