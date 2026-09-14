import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';

const repoRoot = resolve(import.meta.dirname, '../..');
const checkerSource = readFileSync(join(repoRoot, 'scripts/ci/check-file-line-limit.mjs'), 'utf8');

function createRepo(limit, initialContent) {
  mkdirSync(join(repoRoot, 'playground'), { recursive: true });
  const tempRoot = mkdtempSync(join(repoRoot, 'playground', '.file-line-limit-test-'));
  mkdirSync(join(tempRoot, 'scripts/ci'), { recursive: true });
  mkdirSync(join(tempRoot, 'config'), { recursive: true });
  writeFileSync(join(tempRoot, 'scripts/ci/check-file-line-limit.mjs'), checkerSource);
  writeFileSync(
    join(tempRoot, 'config/file-line-limit-policy.json'),
    JSON.stringify({ limit, extensions: ['.mjs'], excludeDirs: [], allowList: [] })
  );
  writeFileSync(join(tempRoot, 'tracked.mjs'), initialContent);
  execFileSync('git', ['init', '-q'], { cwd: tempRoot });
  execFileSync('git', ['add', '.'], { cwd: tempRoot });
  execFileSync(
    'git',
    ['-c', 'user.name=Line Limit Test', '-c', 'user.email=line-limit@example.invalid', 'commit', '-qm', 'baseline'],
    { cwd: tempRoot }
  );
  return tempRoot;
}

function commitChange(tempRoot, relativePath, content) {
  writeFileSync(join(tempRoot, relativePath), content);
  execFileSync('git', ['add', relativePath], { cwd: tempRoot });
  execFileSync(
    'git',
    ['-c', 'user.name=Line Limit Test', '-c', 'user.email=line-limit@example.invalid', 'commit', '-qm', 'change'],
    { cwd: tempRoot }
  );
}

function renameAndCommit(tempRoot, from, to) {
  execFileSync('git', ['mv', from, to], { cwd: tempRoot });
  execFileSync(
    'git',
    ['-c', 'user.name=Line Limit Test', '-c', 'user.email=line-limit@example.invalid', 'commit', '-qm', 'rename'],
    { cwd: tempRoot }
  );
}

function runChecker(tempRoot) {
  return spawnSync(
    process.execPath,
    [join(tempRoot, 'scripts/ci/check-file-line-limit.mjs'), '--base=HEAD~1'],
    { cwd: tempRoot, encoding: 'utf8' }
  );
}

test('historical over-limit file without growth is warning-only', () => {
  const tempRoot = createRepo(6, 'a\nb\nc\nd\ne\nf\n');
  try {
    commitChange(tempRoot, 'tracked.mjs', 'a\nb\nc\nd\ne\n');
    const result = runChecker(tempRoot);
    const output = `${result.stdout}\n${result.stderr}`;
    if (result.status !== 0 || !output.includes('[file-line-limit] warn') || !output.includes('no growth')) {
      throw new Error(`expected warning-only result, got status=${result.status}\n${output}`);
    }
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('new growth in an already over-limit file is warning-only', () => {
  const tempRoot = createRepo(6, 'a\nb\nc\nd\ne\n');
  try {
    commitChange(tempRoot, 'tracked.mjs', 'a\nb\nc\nd\ne\nf\n');
    const result = runChecker(tempRoot);
    const output = `${result.stdout}\n${result.stderr}`;
    if (result.status !== 0 || !output.includes('[file-line-limit] warn') || !output.includes('modified-file-over-limit')) {
      throw new Error(`expected warning-only result, got status=${result.status}\n${output}`);
    }
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('new over-limit files remain blocking', () => {
  const tempRoot = createRepo(6, 'a\n');
  try {
    commitChange(tempRoot, 'new-file.mjs', 'a\nb\nc\nd\ne\nf\n');
    const result = runChecker(tempRoot);
    const output = `${result.stdout}\n${result.stderr}`;
    if (result.status !== 1 || !output.includes('new-file-over-limit')) {
      throw new Error(`expected new-file block, got status=${result.status}\n${output}`);
    }
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('renamed historical over-limit file without growth is warning-only', () => {
  const tempRoot = createRepo(6, 'a\nb\nc\nd\ne\nf\n');
  try {
    renameAndCommit(tempRoot, 'tracked.mjs', 'renamed.mjs');
    const result = runChecker(tempRoot);
    const output = `${result.stdout}\n${result.stderr}`;
    if (result.status !== 0 || !output.includes('[file-line-limit] warn') || !output.includes('no growth')) {
      throw new Error(`expected renamed warning-only result, got status=${result.status}\n${output}`);
    }
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
