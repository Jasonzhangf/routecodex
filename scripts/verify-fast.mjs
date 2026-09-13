#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

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

function writeChangedScopeOutputs(paths) {
  const outputPath = process.env.ROUTECODEX_GATE_SCOPE_OUTPUT;
  if (!outputPath) return;

  const has = (pattern) => paths.some((relative) => pattern.test(relative));
  const hasToken = (tokens) => paths.some((relative) => new RegExp(
    `(?:^|[/_.-])(?:${tokens.join('|')})(?=$|[/_.-])`,
    'iu',
  ).test(relative));
  const v3Architecture = has(/^(?:v3\/scripts\/architecture\/|v3\/tests\/scripts\/|scripts\/|\.github\/workflows\/|docs\/architecture\/)/u)
    || has(/^package(?:-lock)?\.json$/u);
  const v3Runtime = has(/^v3\/(?!scripts\/architecture\/|tests\/scripts\/)/u);
  const values = {
    changed: paths.length > 0,
    v3: v3Architecture || v3Runtime,
    v3_architecture: v3Architecture,
    v3_runtime: v3Runtime,
    v3_build: v3Runtime,
    v3_provider: hasToken(['provider', 'health', 'action', 'anthropic', 'openai', 'gemini', 'relay', 'sse', 'responses']),
    v3_compaction: hasToken(['compaction']),
    v3_session: hasToken(['session', 'admission', 'continuation']),
    v3_timing: hasToken(['timing', 'timeout']),
    v3_debug: hasToken(['debug']),
    v3_console: hasToken(['console']),
    v3_router: hasToken(['route', 'router', 'route-classifier', 'virtual-router']),
    v3_tool: hasToken(['tool', 'servertool']),
    v4: has(/^v4\//u),
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

process.stdout.write(`[verify:fast] PASS checked ${entries.length} file version(s); ${skippedFullCi}; affected Rust compile remains in build/affected-test scope\n`);
