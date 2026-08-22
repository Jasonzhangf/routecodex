import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = process.cwd();
const configPath = path.join(root, 'docs/architecture/no-fallback-diff-rules.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const argv = process.argv.slice(2);
const filesFlagIndex = argv.indexOf('--files');
const scanAll = argv.includes('--all');
const requestedFiles =
  filesFlagIndex >= 0
    ? new Set(argv.slice(filesFlagIndex + 1).map((entry) => normalizeRel(entry)))
    : null;

function runGit(args) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
}

function normalizeRel(filePath) {
  return filePath.split(path.sep).join('/');
}

function isTargetFile(relFile) {
  const normalized = normalizeRel(relFile);
  if (requestedFiles) {
    return requestedFiles.has(normalized);
  }
  const ext = path.extname(normalized);
  return config.extensions.includes(ext) && !config.ignorePaths.some((prefix) => normalized.startsWith(prefix));
}

function parseUnifiedDiff(diffText) {
  const added = new Map();
  let currentFile = null;
  let nextNewLine = 0;

  for (const rawLine of diffText.split('\n')) {
    if (rawLine.startsWith('+++ b/')) {
      const relFile = rawLine.slice('+++ b/'.length).trim();
      currentFile = isTargetFile(relFile) ? relFile : null;
      continue;
    }

    if (rawLine.startsWith('@@')) {
      const match = rawLine.match(/\+(\d+)(?:,(\d+))?/);
      nextNewLine = match ? Number(match[1]) : 0;
      continue;
    }

    if (!currentFile || !nextNewLine) continue;

    if (rawLine.startsWith('+') && !rawLine.startsWith('+++')) {
      if (!added.has(currentFile)) added.set(currentFile, new Set());
      added.get(currentFile).add(nextNewLine);
      nextNewLine += 1;
      continue;
    }

    if (rawLine.startsWith('-') && !rawLine.startsWith('---')) {
      continue;
    }

    nextNewLine += 1;
  }

  return added;
}

function addUntrackedFiles(added) {
  const output = runGit(['ls-files', '--others', '--exclude-standard']);
  for (const relFileRaw of output.split('\n')) {
    const relFile = relFileRaw.trim();
    if (!relFile || !isTargetFile(relFile)) continue;
    const absFile = path.join(root, relFile);
    if (!fs.existsSync(absFile)) continue;
    const lineCount = fs.readFileSync(absFile, 'utf8').split('\n').length;
    const set = added.get(relFile) ?? new Set();
    for (let lineNo = 1; lineNo <= lineCount; lineNo += 1) {
      set.add(lineNo);
    }
    added.set(relFile, set);
  }
}

function collectAllTargetFiles() {
  const out = new Map();
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const nextAbs = path.join(current, entry.name);
      const relFile = normalizeRel(path.relative(root, nextAbs));
      if (entry.isDirectory()) {
        if (config.ignorePaths.some((prefix) => relFile.startsWith(prefix.replace(/\/$/, '')))) continue;
        stack.push(nextAbs);
        continue;
      }
      if (!isTargetFile(relFile)) continue;
      const lineCount = fs.readFileSync(nextAbs, 'utf8').split('\n').length;
      const lineSet = new Set();
      for (let lineNo = 1; lineNo <= lineCount; lineNo += 1) {
        lineSet.add(lineNo);
      }
      out.set(relFile, lineSet);
    }
  }
  return out;
}

function isAllowed(relFile, lineText, ruleId) {
  const normalizedLineText = lineText.toLowerCase();
  return (config.allowlist || []).some(
    (entry) =>
      relFile.includes(entry.pathContains) &&
      normalizedLineText.includes((entry.textContains || '').toLowerCase()) &&
      (!entry.ruleId || entry.ruleId === ruleId)
  );
}

function hasRecentCatch(lines, lineIndex, lookbackLines) {
  const start = Math.max(0, lineIndex - lookbackLines);
  for (let idx = lineIndex - 1; idx >= start; idx -= 1) {
    const probe = lines[idx].trim();
    if (probe.length === 0) continue;
    if (/^catch\s*(\([^)]*\))?\s*\{?$/.test(probe)) return true;
    if (/^\}\s*catch\s*(\([^)]*\))?\s*\{?$/.test(probe)) return true;
    if (probe === '}' || probe === '};' || probe === '},') return false;
    if (probe.endsWith('{')) continue;
    if (probe.includes('try')) continue;
  }
  return false;
}

function scanAddedLines(added) {
  const failures = [];
  const linePatterns = config.linePatterns.map((entry) => ({
    ...entry,
    regex: new RegExp(entry.pattern, 'i'),
  }));

  for (const [relFile, lineNumbers] of added.entries()) {
    const absFile = path.join(root, relFile);
    if (!fs.existsSync(absFile)) continue;
    const lines = fs.readFileSync(absFile, 'utf8').split('\n');
    const sortedLines = [...lineNumbers].sort((a, b) => a - b);

    for (const lineNo of sortedLines) {
      const lineText = lines[lineNo - 1] ?? '';
      const trimmed = lineText.trim();
      if (!trimmed) continue;
      if (/^(\/\/|\/\*|\*|\*\/)/.test(trimmed)) continue;

      for (const rule of linePatterns) {
        if (!rule.regex.test(lineText)) continue;
        if (isAllowed(relFile, lineText, rule.id)) continue;
        failures.push({
          relFile,
          lineNo,
          ruleId: rule.id,
          lineText: trimmed,
        });
      }

      for (const rule of config.contextRules || []) {
        if (rule.type !== 'catch-return-or-continue') continue;
        if (!/\b(return|continue)\b/.test(lineText)) continue;
        if (!hasRecentCatch(lines, lineNo - 1, rule.lookbackLines ?? 6)) continue;
        if (isAllowed(relFile, lineText, rule.id)) continue;
        failures.push({
          relFile,
          lineNo,
          ruleId: rule.id,
          lineText: trimmed,
        });
      }
    }
  }

  return failures;
}

const added = scanAll
  ? collectAllTargetFiles()
  : (() => {
      const diffText = runGit(['diff', '--no-ext-diff', '--unified=0', '--relative', 'HEAD', '--']);
      const changed = parseUnifiedDiff(diffText);
      addUntrackedFiles(changed);
      return changed;
    })();
const failures = scanAddedLines(added);

if (failures.length > 0) {
  console.error('[verify:no-fallback] failed');
  for (const failure of failures.slice(0, 80)) {
    console.error(`- ${normalizeRel(failure.relFile)}:${failure.lineNo} [${failure.ruleId}] ${failure.lineText}`);
  }
  if (failures.length > 80) {
    console.error(`- ... ${failures.length - 80} more`);
  }
  process.exit(1);
}

console.log('[verify:no-fallback] ok');
console.log(`- scanned changed files: ${added.size}`);
console.log(`- rules: ${config.linePatterns.length + (config.contextRules || []).length}`);
if (scanAll) {
  console.log('- mode: all-files');
}
