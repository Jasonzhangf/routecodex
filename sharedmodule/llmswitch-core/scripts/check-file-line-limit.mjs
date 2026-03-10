#!/usr/bin/env node
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const LIMIT = 500;
const EXTENSIONS = new Set(['.ts', '.rs']);

function changedFiles() {
  const tracked = execSync('git diff --name-only HEAD', { encoding: 'utf8' })
    .split('\n')
    .map((v) => v.trim())
    .filter(Boolean);
  const untracked = execSync('git ls-files --others --exclude-standard', { encoding: 'utf8' })
    .split('\n')
    .map((v) => v.trim())
    .filter(Boolean);
  return Array.from(new Set([...tracked, ...untracked]));
}

function shouldCheck(file) {
  const ext = path.extname(file).toLowerCase();
  if (!EXTENSIONS.has(ext)) return false;
  return file.startsWith('src/') || file.startsWith('rust-core/');
}

function countLines(absPath) {
  const content = fs.readFileSync(absPath, 'utf8');
  return content.split('\n').length;
}

function main() {
  const files = changedFiles().filter(shouldCheck);
  const violations = [];
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    const lines = countLines(file);
    if (lines > LIMIT) {
      violations.push({ file, lines });
    }
  }
  if (violations.length) {
    for (const item of violations) {
      console.error(`[line-limit] ${item.file} => ${item.lines} lines (limit ${LIMIT})`);
    }
    process.exit(1);
  }
  console.log(`[line-limit] PASS checked=${files.length} limit=${LIMIT}`);
}

main();

