#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const roots = ['src', 'sharedmodule/llmswitch-core/src'];
const includeExt = /\.(ts|tsx|js|mjs|cjs|rs)$/;
const args = new Set(process.argv.slice(2));
const failOnRisk = args.has('--fail-on-risk');
const jsonOutput = args.has('--json');

const NOISE_HINT_RE = /\b(ignore|best[- ]effort|non-blocking|swallow|fallback)\b/i;
const HAS_HANDLED_RE =
  /\b(throw|console\.(warn|error|info)|logger\.(warn|warning|error|info)|report\w*Error|logProcessLifecycle|log\w*NonBlocking|emit\w*|record\w*Error)\b/;

function walk(dir, out) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, out);
      continue;
    }
    if (includeExt.test(entry.name)) out.push(full);
  }
}

function lineOf(source, index) {
  let line = 1;
  for (let i = 0; i < index; i++) {
    if (source.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

function findBlockEnd(source, openBraceIndex) {
  let depth = 0;
  let inS = false;
  let inD = false;
  let inT = false;
  let escaped = false;
  let inLineComment = false;
  let inBlockComment = false;
  for (let i = openBraceIndex; i < source.length; i += 1) {
    const ch = source[i];
    const nx = source[i + 1];
    if (inLineComment) {
      if (ch === '\n') inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (ch === '*' && nx === '/') {
        inBlockComment = false;
        i += 1;
      }
      continue;
    }
    if (inS) {
      if (!escaped && ch === '\\') {
        escaped = true;
        continue;
      }
      if (!escaped && ch === "'") inS = false;
      escaped = false;
      continue;
    }
    if (inD) {
      if (!escaped && ch === '\\') {
        escaped = true;
        continue;
      }
      if (!escaped && ch === '"') inD = false;
      escaped = false;
      continue;
    }
    if (inT) {
      if (!escaped && ch === '\\') {
        escaped = true;
        continue;
      }
      if (!escaped && ch === '`') inT = false;
      escaped = false;
      continue;
    }
    if (ch === '/' && nx === '/') {
      inLineComment = true;
      i += 1;
      continue;
    }
    if (ch === '/' && nx === '*') {
      inBlockComment = true;
      i += 1;
      continue;
    }
    if (ch === "'") {
      inS = true;
      continue;
    }
    if (ch === '"') {
      inD = true;
      continue;
    }
    if (ch === '`') {
      inT = true;
      continue;
    }
    if (ch === '{') {
      depth += 1;
      continue;
    }
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

const files = [];
for (const root of roots) walk(root, files);

const catchRisk = [];
const promiseCatchRisk = [];
const catchRe = /catch\s*(\([^)]*\))?\s*\{/g;
const promiseCatchRe = /\.catch\(\s*(\([^)]*\)\s*=>\s*)?(\{\s*\}|undefined|null)?\s*\)/g;

for (const file of files) {
  const source = fs.readFileSync(file, 'utf8');

  let m;
  while ((m = catchRe.exec(source)) !== null) {
    const open = source.indexOf('{', m.index);
    if (open < 0) continue;
    const end = findBlockEnd(source, open);
    if (end < 0) continue;
    const body = source.slice(open + 1, end).trim();
    const hasHandled = HAS_HANDLED_RE.test(body);
    const noopOnly = /^(?:\/\*[\s\S]*?\*\/|\/\/.*|\s|;|return\s*;)*$/.test(body);
    const looksSwallow = !hasHandled && (noopOnly || NOISE_HINT_RE.test(body));
    if (looksSwallow) {
      catchRisk.push({
        file,
        line: lineOf(source, m.index),
        snippet: body.split('\n').slice(0, 3).join(' ').slice(0, 180)
      });
    }
    catchRe.lastIndex = end + 1;
  }

  while ((m = promiseCatchRe.exec(source)) !== null) {
    promiseCatchRisk.push({ file, line: lineOf(source, m.index), snippet: m[0] });
  }
}

const byFile = new Map();
for (const row of catchRisk) {
  byFile.set(row.file, (byFile.get(row.file) || 0) + 1);
}
const topFiles = [...byFile.entries()]
  .sort((a, b) => b[1] - a[1])
  .slice(0, 40)
  .map(([file, count]) => ({ file, count }));

const report = {
  roots,
  scannedFiles: files.length,
  catchRiskCount: catchRisk.length,
  promiseCatchRiskCount: promiseCatchRisk.length,
  topFiles,
  sample: catchRisk.slice(0, 120)
};

if (jsonOutput) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  console.log(`[silent-failure-audit] scanned files=${report.scannedFiles}`);
  console.log(
    `[silent-failure-audit] risky catch blocks=${report.catchRiskCount}, risky promise.catch=${report.promiseCatchRiskCount}`
  );
  console.log('[silent-failure-audit] top files:');
  for (const row of topFiles) {
    console.log(`  - ${row.count}  ${row.file}`);
  }
  console.log('[silent-failure-audit] sample:');
  for (const row of report.sample.slice(0, 30)) {
    console.log(`  - ${row.file}:${row.line}  ${row.snippet}`);
  }
}

if (failOnRisk && (report.catchRiskCount > 0 || report.promiseCatchRiskCount > 0)) {
  process.exit(2);
}
