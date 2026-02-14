#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const repoRoot = process.cwd();
const policyPath = path.join(repoRoot, 'config', 'file-line-limit-policy.json');

function run(cmd) {
  return execSync(cmd, { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' }).trim();
}

function tryRun(cmd) {
  try {
    return run(cmd);
  } catch {
    return '';
  }
}

function loadPolicy() {
  const raw = fs.readFileSync(policyPath, 'utf8');
  const parsed = JSON.parse(raw);
  return {
    limit: Number(parsed.limit) > 0 ? Number(parsed.limit) : 500,
    extensions: Array.isArray(parsed.extensions) ? parsed.extensions.map((v) => String(v).toLowerCase()) : [],
    excludeDirs: Array.isArray(parsed.excludeDirs) ? parsed.excludeDirs.map((v) => String(v)) : [],
    allowList: Array.isArray(parsed.allowList) ? parsed.allowList.map((v) => String(v)) : []
  };
}

function resolveRange() {
  const argvBase = process.argv.find((arg) => arg.startsWith('--base='));
  if (argvBase) {
    const value = argvBase.slice('--base='.length).trim();
    if (value) {
      return `${value}...HEAD`;
    }
  }
  const envBase = String(process.env.ROUTECODEX_LINE_LIMIT_BASE || '').trim();
  if (envBase) {
    return `${envBase}...HEAD`;
  }
  const inCi = String(process.env.CI || '').toLowerCase() === 'true';
  const hasLocalChanges = Boolean(tryRun('git status --porcelain'));
  if (!inCi && hasLocalChanges) {
    return '';
  }
  const isPr = String(process.env.GITHUB_EVENT_NAME || '') === 'pull_request';
  const baseRef = String(process.env.GITHUB_BASE_REF || '').trim();
  if (isPr && baseRef) {
    return `origin/${baseRef}...HEAD`;
  }
  const hasHeadParent = tryRun('git rev-parse --verify --quiet HEAD~1');
  if (hasHeadParent) {
    return 'HEAD~1...HEAD';
  }
  return '';
}

function parseNameStatus(output) {
  if (!output) return [];
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split('\t');
      if (parts.length < 2) return null;
      const status = parts[0];
      if (status.startsWith('R')) {
        return { status: 'R', path: parts[2] || parts[1] };
      }
      return { status: status[0], path: parts[1] };
    })
    .filter((v) => v && typeof v.path === 'string');
}

function isExcluded(filePath, policy) {
  const normalized = filePath.replace(/\\/g, '/');
  if (policy.allowList.includes(normalized)) {
    return true;
  }
  return policy.excludeDirs.some((prefix) => normalized.startsWith(prefix));
}

function isCodeFile(filePath, policy) {
  const ext = path.extname(filePath).toLowerCase();
  return policy.extensions.includes(ext);
}

function countLines(filePath) {
  const content = fs.readFileSync(path.join(repoRoot, filePath), 'utf8');
  if (!content.length) return 0;
  return content.split(/\r?\n/).length;
}

function getChangedFiles(range) {
  const diffCmd = range
    ? `git diff --name-status --diff-filter=ACMR ${range}`
    : 'git diff --name-status --diff-filter=ACMR HEAD';
  return parseNameStatus(tryRun(diffCmd));
}

function main() {
  const policy = loadPolicy();
  const range = resolveRange();
  const changed = getChangedFiles(range);
  if (!changed.length) {
    console.log('[file-line-limit] no changed files; skip');
    return;
  }

  const violations = [];
  for (const entry of changed) {
    const filePath = entry.path;
    if (!filePath || !fs.existsSync(path.join(repoRoot, filePath))) {
      continue;
    }
    if (!isCodeFile(filePath, policy) || isExcluded(filePath, policy)) {
      continue;
    }
    const lines = countLines(filePath);
    if (lines < policy.limit) {
      continue;
    }
    const violationType = entry.status === 'A' ? 'new-file-over-limit' : 'modified-file-over-limit';
    violations.push({ type: violationType, path: filePath, lines });
  }

  if (!violations.length) {
    console.log(
      `[file-line-limit] pass (range=${range || 'HEAD'} limit=${policy.limit}, checked=${changed.length})`
    );
    return;
  }

  console.error(`[file-line-limit] fail (limit=${policy.limit}, range=${range || 'HEAD'})`);
  for (const violation of violations) {
    console.error(`- ${violation.type}: ${violation.path} (${violation.lines} lines)`);
  }
  console.error(
    'Fix: split by feature/function and extract reusable helpers; if temporary exemption is required, add path to config/file-line-limit-policy.json allowList with a tracked follow-up issue.'
  );
  process.exit(1);
}

main();
