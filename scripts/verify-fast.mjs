#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

const root = process.cwd();
const staged = process.env.ROUTECODEX_GATE_DIFF_MODE === 'staged';
const base = process.env.ROUTECODEX_GATE_DIFF_BASE;
const head = process.env.ROUTECODEX_GATE_DIFF_HEAD;
const remoteName = process.env.ROUTECODEX_GATE_REMOTE_NAME;
const zeroSha = /^0{40}$/u;
const newRef = base && head && zeroSha.test(base);

function gitArgs(extra, filter = 'ACMRT') {
  if (staged) return ['diff', '--cached', `--diff-filter=${filter}`, ...extra];
  if (base && head) return ['diff', `--diff-filter=${filter}`, base, head, ...extra];
  return ['diff', `--diff-filter=${filter}`, ...extra];
}

function git(extra, filter) {
  return execFileSync('git', gitArgs(extra, filter), { cwd: root, encoding: 'utf8' });
}

function newRefCommits() {
  const args = ['rev-list', '--reverse', head];
  if (remoteName) args.push('--not', `--remotes=${remoteName}`);
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' })
    .split('\n')
    .map((commit) => commit.trim())
    .filter(Boolean);
}

let newCommits = [];

function newRefEntries() {
  const entries = [];
  for (const commit of newCommits) {
    const output = execFileSync('git', ['diff-tree', '--root', '--no-commit-id', '-r', '-m', '--no-renames', '--name-status', commit], {
      cwd: root,
      encoding: 'utf8',
    });
    for (const line of output.split('\n').map((entry) => entry.trim()).filter(Boolean)) {
      const [status, path] = line.split('\t', 2);
      if (status && path) entries.push({ commit, path, status: status[0] });
    }
  }
  return entries;
}

let allNewRefEntries = [];

function changedEntries() {
  if (newRef) return allNewRefEntries.filter((entry) => entry.status !== 'D');
  return git(['--name-only']).split('\n').map((file) => file.trim()).filter(Boolean).map((path) => ({ commit: null, path }));
}

function deletedFiles() {
  if (newRef) return allNewRefEntries.filter((entry) => entry.status === 'D').map((entry) => entry.path);
  return git(['--name-only'], 'D').split('\n').map((file) => file.trim()).filter(Boolean);
}

function contentFor(relative, commit) {
  if (commit) return execFileSync('git', ['show', `${commit}:${relative}`], { cwd: root, encoding: 'utf8' });
  if (staged) return execFileSync('git', ['show', `:${relative}`], { cwd: root, encoding: 'utf8' });
  if (base && head) return execFileSync('git', ['show', `${head}:${relative}`], { cwd: root, encoding: 'utf8' });
  return readFileSync(resolve(root, relative), 'utf8');
}

function fail(message) {
  process.stderr.write(`[verify:fast] FAIL ${message}\n`);
  process.exit(1);
}

function affectedCargoPackages(rustFiles) {
  let metadata;
  try {
    metadata = JSON.parse(
      execFileSync(
        'cargo',
        ['metadata', '--locked', '--no-deps', '--format-version', '1', '--manifest-path', 'v3/Cargo.toml'],
        {
          cwd: root,
          encoding: 'utf8',
          env: { ...process.env, CARGO_NET_OFFLINE: process.env.CARGO_NET_OFFLINE ?? 'true' },
        },
      ),
    );
  } catch (error) {
    process.stderr.write(
      `[verify:fast] WARN cargo metadata unavailable; skipped affected Rust compile check: ${error.message}\n`,
    );
    return [];
  }
  const packages = (metadata.packages ?? []).map((pkg) => ({
    name: pkg.name,
    dir: dirname(resolve(pkg.manifest_path)),
  }));
  const affected = new Set();
  const unmatched = [];
  for (const file of rustFiles) {
    const absolute = resolve(root, file);
    let best = null;
    for (const pkg of packages) {
      const path = relative(pkg.dir, absolute);
      if (path === '' || (!path.startsWith('..') && !isAbsolute(path))) {
        if (!best || pkg.dir.length > best.dir.length) best = pkg;
      }
    }
    if (best) affected.add(best.name);
    else unmatched.push(file);
  }
  if (unmatched.length > 0) {
    process.stderr.write(`[verify:fast] WARN Rust file(s) not owned by a v3 Cargo package: ${unmatched.join(', ')}\n`);
  }
  return [...affected].sort();
}

try {
  if (newRef) {
    newCommits = newRefCommits();
    allNewRefEntries = newRefEntries();
    for (const commit of newCommits) {
      execFileSync('git', ['diff-tree', '--root', '--check', '--no-commit-id', '-r', '-m', '--no-renames', commit], { cwd: root, stdio: 'inherit' });
    }
  } else {
    execFileSync('git', gitArgs(['--check']), { cwd: root, stdio: 'inherit' });
  }
} catch (error) {
  fail(`diff check failed: ${error.status ?? error.message}`);
}

const entries = changedEntries();
const deleted = deletedFiles();
const skippedFullCi = '[verify:ci] SKIPPED_FOR_REPAIR (not run)';
if (entries.length === 0 && deleted.length === 0) {
  process.stdout.write(`[verify:fast] PASS no changed files; ${skippedFullCi}\n`);
  process.exit(0);
}
if (deleted.length > 0) {
  process.stderr.write(`[verify:fast] INFO deleted file(s): ${deleted.join(', ')}\n`);
}

const semanticFiles = [...new Set(entries.map(({ path }) => path).filter((relative) => /\.(?:rs|toml|yaml|yml)$/u.test(relative)))];
if (semanticFiles.length > 0) {
  process.stderr.write(`[verify:fast] WARN semantic validation deferred for ${semanticFiles.length} Rust/config file(s): ${semanticFiles.join(', ')}\n`);
}

for (const { commit, path: relative } of entries) {
  let content;
  try {
    content = contentFor(relative, commit);
  } catch (error) {
    fail(`${relative} content could not be read from the selected diff: ${error.message}`);
  }

  if (/\.(?:mjs|js|cjs)$/u.test(relative)) {
    const syntaxArgs = relative.endsWith('.cjs')
      ? ['--check', '-']
      : ['--input-type=module', '--check', '-'];
    const result = spawnSync(process.execPath, syntaxArgs, { encoding: 'utf8', input: content });
    if (result.status !== 0) fail(`${relative} syntax check failed`);
    continue;
  }

  if (/\.json$/u.test(relative)) {
    try {
      JSON.parse(content);
    } catch (error) {
      fail(`${relative} JSON parse failed: ${error.message}`);
    }
    continue;
  }

  if (/\.sh$/u.test(relative) || relative === '.githooks/pre-commit' || relative === '.githooks/pre-push') {
    const result = spawnSync('sh', ['-n'], { encoding: 'utf8', input: content });
    if (result.status !== 0) fail(`${relative} shell syntax check failed`);
  }
}

const changedRustFiles = [
  ...new Set([
    ...entries.map(({ path }) => path).filter((path) => path.endsWith('.rs')),
    ...deleted.filter((path) => path.endsWith('.rs')),
  ]),
];
if (changedRustFiles.length > 0) {
  const affectedPackages = affectedCargoPackages(changedRustFiles);
  if (affectedPackages.length > 0) {
    const cargoArgs = [
      'check',
      '--locked',
      ...affectedPackages.flatMap((name) => ['-p', name]),
      '--manifest-path',
      'v3/Cargo.toml',
    ];
    try {
      execFileSync('cargo', cargoArgs, {
        cwd: root,
        env: { ...process.env, CARGO_NET_OFFLINE: process.env.CARGO_NET_OFFLINE ?? 'true' },
        stdio: 'inherit',
      });
    } catch (error) {
      fail(`affected cargo check failed (${affectedPackages.join(', ')}): ${error.status ?? error.message}`);
    }
  }
}

process.stdout.write(`[verify:fast] PASS checked ${entries.length} file version(s); ${skippedFullCi}; affected Rust compile checked\n`);
