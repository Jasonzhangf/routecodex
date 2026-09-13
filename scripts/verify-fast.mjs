#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import ts from 'typescript';

const root = process.cwd();
const staged = process.env.ROUTECODEX_GATE_DIFF_MODE === 'staged';
const base = process.env.ROUTECODEX_GATE_DIFF_BASE;
const head = process.env.ROUTECODEX_GATE_DIFF_HEAD;
const remoteName = process.env.ROUTECODEX_GATE_REMOTE_NAME;
const scopeOnly = process.env.ROUTECODEX_GATE_SCOPE_ONLY === '1';
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

function changedWorkflowLines(relative) {
  if (newRef) return [];
  try {
    return execFileSync('git', gitArgs(['--unified=0', '--', relative]), { cwd: root, encoding: 'utf8' })
      .split('\n')
      .filter((line) => /^[+-](?![+-])/u.test(line))
      .map((line) => line.slice(1));
  } catch {
    return [];
  }
}

function classifyWorkflowScope(paths) {
  let v3 = false;
  let v4 = false;
  const v3Marker = /\bV3\b|needs\.scope\.outputs\.v3|(?:^|[\s"'`/:])v3(?:[-_/.:]|[\s"'`]|$)/u;
  const v4Marker = /\bV4\b|needs\.scope\.outputs\.v4|(?:^|[\s"'`/:])v4(?:[-_/.:]|[\s"'`]|$)/u;

  for (const relative of paths.filter((file) => /^\.github\/workflows\//u.test(file))) {
    if (relative === '.github/workflows/release.yml') {
      v3 = true;
      continue;
    }
    if (relative !== '.github/workflows/test.yml') {
      v3 = true;
      v4 = true;
      continue;
    }
    const changedLines = changedWorkflowLines(relative);
    const touchesV3 = changedLines.some((line) => v3Marker.test(line));
    const touchesV4 = changedLines.some((line) => v4Marker.test(line));
    if (touchesV3 && !touchesV4) v3 = true;
    else if (touchesV4 && !touchesV3) v4 = true;
    else {
      v3 = true;
      v4 = true;
    }
  }
  return { v3, v4 };
}

function writeChangedScopeOutputs(paths) {
  const outputPath = process.env.ROUTECODEX_GATE_SCOPE_OUTPUT;
  if (!outputPath) return;

  const has = (pattern) => paths.some((relative) => pattern.test(relative));
  const workflowScope = classifyWorkflowScope(paths);
  const v3Scope = workflowScope.v3 || has(/^(?:v3\/|scripts\/|docs\/(?:architecture|design|goals|schemas)\/)/u)
    || has(/^package(?:-lock)?\.json$/u);
  const values = {
    changed: paths.length > 0,
    v3: v3Scope,
    v3_architecture: v3Scope,
    v3_runtime: v3Scope,
    v3_build: v3Scope,
    v3_provider: v3Scope,
    v3_compaction: v3Scope,
    v3_session: v3Scope,
    v3_timing: v3Scope,
    v3_debug: v3Scope,
    v3_console: v3Scope,
    v3_router: v3Scope,
    v3_tool: v3Scope,
    v4: workflowScope.v4 || has(/^v4\//u),
  };

  appendFileSync(
    outputPath,
    Object.entries(values).map(([key, value]) => `${key}=${value ? 'true' : 'false'}\n`).join(''),
  );
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

const jsoncFiles = new Set(['tsconfig.json']);
function parseJsonFile(relativePath, content) {
  if (!jsoncFiles.has(relativePath)) return JSON.parse(content);
  const result = ts.parseConfigFileTextToJson(relativePath, content);
  if (result.error) {
    throw new Error(ts.flattenDiagnosticMessageText(result.error.messageText, '\n'));
  }
  return result.config;
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
if (process.env.ROUTECODEX_GATE_SCOPE_OUTPUT && !staged && (!base || !head)) {
  fail('changed-scope base/head is missing; refusing empty CI scope');
}
writeChangedScopeOutputs([...new Set([...entries.map(({ path }) => path), ...deleted])]);
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
      parseJsonFile(relative, content);
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
if (!scopeOnly && changedRustFiles.length > 0) {
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

const compileEvidence = scopeOnly
  ? 'affected Rust compile deferred to scoped V3 test job'
  : 'affected Rust compile checked';
process.stdout.write(`[verify:fast] PASS checked ${entries.length} file version(s); ${skippedFullCi}; ${compileEvidence}\n`);
