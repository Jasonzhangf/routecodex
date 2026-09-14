#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import ts from 'typescript';
import { GATE_SEVERITY } from './gate-policy.mjs';

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

function changedWorkflowLines(relative, commit = null) {
  if (commit) {
    try {
      return execFileSync(
        'git',
        ['diff-tree', '--root', '--unified=0', '--no-commit-id', '-r', '-m', '--no-renames', '-p', commit, '--', relative],
        { cwd: root, encoding: 'utf8' },
      )
        .split('\n')
        .filter((line) => /^[+-](?![+-])/u.test(line))
        .map((line) => line.slice(1));
    } catch {
      return [];
    }
  }
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

function classifyWorkflowScope(entries) {
  let v3 = false;
  let v4 = false;
  const v3Marker = /\bV3\b|needs\.scope\.outputs\.v3|(?:^|[\s"'`/:])v3(?:[-_/.:]|[\s"'`]|$)/u;
  const v4Marker = /\bV4\b|needs\.scope\.outputs\.v4|(?:^|[\s"'`/:])v4(?:[-_/.:]|[\s"'`]|$)/u;

  for (const { commit, path: relative } of entries.filter(({ path }) => /^\.github\/workflows\//u.test(path))) {
    if (relative === '.github/workflows/release.yml') {
      v3 = true;
      continue;
    }
    if (relative !== '.github/workflows/test.yml') {
      v3 = true;
      v4 = true;
      continue;
    }
    const changedLines = changedWorkflowLines(relative, commit);
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

function isV3RootScript(relative) {
  const v3ArchitectureScripts = new Set([
    'scripts/architecture/verify-v3-resource-map.mjs',
    'scripts/architecture/architecture-wiki-lib.mjs',
    'scripts/architecture/audit-custom-payload-carrier-owner-queryability.mjs',
    'scripts/architecture/audit-function-map-canonical-builder-spread.mjs',
    'scripts/architecture/audit-resource-global-coverage.mjs',
    'scripts/architecture/compile-v3-build-admission.mjs',
    'scripts/architecture/custom-payload-carrier-owner-queryability-lib.mjs',
    'scripts/architecture/generate-mainline-chain-manifests.mjs',
    'scripts/architecture/mainline-call-map-lib.mjs',
    'scripts/architecture/render-architecture-wiki-html.mjs',
    'scripts/architecture/render-architecture-wiki-pages.mjs',
    'scripts/architecture/render-mainline-manifests.mjs',
    'scripts/architecture/render-mainline-mermaid.mjs',
    'scripts/architecture/v3-mainline-caller-flow-lib.mjs',
    'scripts/architecture/v3-provider-compat-module-boundary-lib.mjs',
    'scripts/architecture/v3-req04-tool-governance-review-lib.mjs',
    'scripts/architecture/v3-root-thin-dispatch-contract.mjs',
    'scripts/architecture/verify-architecture-fallback-denylist.mjs',
    'scripts/architecture/verify-architecture-mainline-call-map.mjs',
    'scripts/architecture/verify-architecture-mainline-manifest-sync.mjs',
    'scripts/architecture/verify-architecture-wiki-html-sync.mjs',
    'scripts/architecture/verify-direct-semantic-classification-design.mjs',
    'scripts/architecture/verify-error-pipeline-contract.mjs',
    'scripts/architecture/verify-function-map-compile-gate.mjs',
    'scripts/architecture/verify-install-release-contract.mjs',
    'scripts/architecture/verify-internal-error-numbering.mjs',
    'scripts/architecture/verify-internal-policy-hardcode.mjs',
    'scripts/architecture/verify-mainline-call-map-binding-state.mjs',
    'scripts/architecture/verify-no-fallback-diff.mjs',
    'scripts/architecture/verify-provider-response-errorerr-bypass-closeout.mjs',
    'scripts/architecture/verify-repository-filesystem-governance.mjs',
    'scripts/architecture/verify-responses-continuation-immutable-boundary.mjs',
    'scripts/architecture/verify-runtime-lifecycle-loop-gate-matrix.mjs',
    'scripts/architecture/verify-runtime-lifecycle-pid-rebase.mjs',
    'scripts/architecture/verify-runtime-responses-provider-compat.mjs',
    'scripts/architecture/verify-server-function-map-boundary.mjs',
    'scripts/architecture/verify-sse-architecture-boundary.mjs',
    'scripts/architecture/verify-v3-dependency-projection.mjs',
    'scripts/architecture/verify-v3-provider-compat-module-boundary.mjs',
    'scripts/architecture/verify-v3-responses-continuation-disabled.mjs',
    'scripts/architecture/verify-v3-simplified-user-config.mjs',
    'scripts/architecture/wiki-html-lib.mjs',
  ]);
  return /^scripts\/(?:run-v3-|verify-v3-)/u.test(relative)
    || /^(?:scripts\/verify-fast|scripts\/verify-servertool-rust-only)\.mjs$/u.test(relative)
    || v3ArchitectureScripts.has(relative)
    || relative === 'scripts/ci/check-file-line-limit.mjs'
    || relative === 'scripts/ci/repo-sanity.mjs'
    || relative === 'scripts/ci/mempalace-scan-artifact-audit.mjs'
    || relative === 'scripts/tests/repository-filesystem-governance-red-fixtures.mjs'
    || /^(?:scripts\/install-v3-cli|scripts\/ensure-cli-command-shim)\.mjs$/u.test(relative)
    || /^scripts\/tests\/v3-/u.test(relative)
    || /^tests\/scripts\/(?:v3-cli-distribution|install-v3-cli-target-cleanup)\.spec\.mjs$/u.test(relative)
    || /^scripts\/install-(?:global|release)\.sh$/u.test(relative)
    || relative === '.agents/skills/rcc-dev-skills/references/96-v3-selected-provider-model-binding-sop.md'
    || relative === 'sharedmodule/llmswitch-core/src/conversion/compat/provider-resolution-config.json';
}

function classifyV3FineScopes(paths, { rootPackageChanged, workflowScope }) {
  const scopes = new Set();
  const add = (...names) => names.forEach((name) => scopes.add(name));
  const sharedRootChanged = rootPackageChanged || paths.includes('scripts/verify-fast.mjs');
  if (sharedRootChanged || workflowScope.v3 && workflowScope.v4) {
    add(...[
      'v3_architecture',
      'v3_build',
      'v3_provider',
      'v3_session',
      'v3_debug',
      'v3_router',
      'v3_tool',
    ]);
    return scopes;
  }

  if (workflowScope.v3 && paths.some((path) => /^\.github\/workflows\//u.test(path))) {
    add('v3_architecture');
  }

  for (const path of paths) {
    const isV3Path = path.startsWith('v3/') || isV3RootScript(path);
    if (/^docs\/(?:architecture|design|goals|schemas)\//u.test(path)
        || isV3RootScript(path)) add('v3_architecture');
    if (/^v3\/(?:Cargo\.toml|Cargo\.lock|package(?:-lock)?\.json)$/u.test(path)
        || /^v3\/crates\//u.test(path)
        || /^scripts\/(?:install-v3-cli|ensure-cli-command-shim)\.mjs$/u.test(path)
        || /^scripts\/install-(?:global|release)\.sh$/u.test(path)) add('v3_build');
    if (isV3Path && /(?:^|[\/_-])provider(?:[\/_-]|$)/iu.test(path)) add('v3_provider');
    if (isV3Path && /(?:^|[\/_-])session(?:[\/_-]|$)|continuation/iu.test(path)) add('v3_session');
    if (isV3Path && /(?:^|[\/_-])debug(?:[\/_-]|$)/iu.test(path)) add('v3_debug');
    if (isV3Path && /(?:^|[\/_-])router(?:[\/_-]|$)|route-classifier/iu.test(path)) add('v3_router');
    if (isV3Path && /(?:^|[\/_-])tool(?:[\/_-]|$)|servertool/iu.test(path)) add('v3_tool');
  }
  return scopes;
}

function classifyV4FullScope(paths, { rootPackageChanged, workflowScope }) {
  if (rootPackageChanged || workflowScope.v4 || paths.includes('scripts/verify-fast.mjs')) return true;

  return paths.some((path) => {
    if (!path.startsWith('v4/')) return false;
    return !/^v4\/(?:crates\/[^/]+\/(?:src|tests|examples|benches)\/|cordis\/[^/]+\/(?:src|tests)\/)/u.test(path);
  });
}

function writeChangedScopeOutputs(entries) {
  const outputPath = process.env.ROUTECODEX_GATE_SCOPE_OUTPUT;
  if (!outputPath) return;

  const paths = [...new Set(entries.map(({ path }) => path))];
  const has = (pattern) => paths.some((relative) => pattern.test(relative));
  const workflowScope = classifyWorkflowScope(entries);
  const rootPackageChanged = has(/^package(?:-lock)?\.json$/u);
  const fineScopes = classifyV3FineScopes(paths, { rootPackageChanged, workflowScope });
  const v4FullScope = classifyV4FullScope(paths, { rootPackageChanged, workflowScope });
  const v3Scope = fineScopes.size > 0 || workflowScope.v3 || has(/^v3\//u)
    || paths.some((relative) => isV3RootScript(relative))
    || has(/^docs\/(?:architecture|design|goals|schemas)\//u)
    || rootPackageChanged;
  const values = {
    changed: paths.length > 0,
    v3: v3Scope,
    v3_architecture: fineScopes.has('v3_architecture'),
    v3_build: fineScopes.has('v3_build'),
    v3_provider: fineScopes.has('v3_provider'),
    v3_session: fineScopes.has('v3_session'),
    v3_debug: fineScopes.has('v3_debug'),
    v3_router: fineScopes.has('v3_router'),
    v3_tool: fineScopes.has('v3_tool'),
    v4: workflowScope.v4 || has(/^v4\//u) || rootPackageChanged || paths.includes('scripts/verify-fast.mjs'),
    v4_full: v4FullScope,
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
    fail(`required V3 Rust owner evidence unavailable; cargo metadata is required for affected compile checks: ${error.message}`);
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
    fail(`required V3 Rust owner evidence unavailable; file(s) are not owned by a V3 Cargo package: ${unmatched.join(', ')}`);
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
writeChangedScopeOutputs([
  ...entries,
  ...deleted.map((path) => ({ commit: null, path })),
]);
if (entries.length === 0 && deleted.length === 0) {
  process.stdout.write(`[verify:fast] PASS no changed files; ${skippedFullCi}\n`);
  process.exit(0);
}
if (deleted.length > 0) {
  process.stderr.write(`[verify:fast] INFO deleted file(s): ${deleted.join(', ')}\n`);
}

const changedRustFiles = [
  ...new Set([
    ...entries.map(({ path }) => path).filter((path) => path.endsWith('.rs')),
    ...deleted.filter((path) => path.endsWith('.rs')),
  ]),
];
const changedV3RustFiles = changedRustFiles.filter((path) => path.startsWith('v3/'));
const changedV4RustFiles = changedRustFiles.filter((path) => path.startsWith('v4/'));
const unsupportedRustFiles = changedRustFiles.filter((path) => !path.startsWith('v3/') && !path.startsWith('v4/'));
if (unsupportedRustFiles.length > 0) {
  fail(`affected Rust compile evidence unavailable; no declared fast-gate owner for: ${unsupportedRustFiles.join(', ')}`);
}

const semanticFiles = [...new Set(entries.map(({ path }) => path).filter((relative) => /\.(?:rs|toml|yaml|yml)$/u.test(relative)))];
if (semanticFiles.length > 0) {
  process.stderr.write(`[verify:fast] ${GATE_SEVERITY.WARN} semantic validation deferred for ${semanticFiles.length} Rust/config file(s): ${semanticFiles.join(', ')}\n`);
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

if (changedV4RustFiles.length > 0) {
  process.stderr.write(`[verify:fast] WARN V4 Rust compile deferred to its scoped workspace gate: ${changedV4RustFiles.join(', ')}\n`);
}
if (!scopeOnly && changedV3RustFiles.length > 0) {
  const affectedPackages = affectedCargoPackages(changedV3RustFiles);
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

const deferredCompileTargets = [
  ...(changedV3RustFiles.length > 0 ? ['scoped V3 test job'] : []),
  ...(changedV4RustFiles.length > 0 ? ['scoped V4 workspace job'] : []),
];
const compileEvidence = scopeOnly
  ? deferredCompileTargets.length > 0
    ? `affected Rust compile deferred to ${deferredCompileTargets.join(' and ')}`
    : 'no Rust compile applicable'
  : [
      ...(changedV3RustFiles.length > 0 ? ['affected V3 Rust compile checked'] : []),
      ...(changedV4RustFiles.length > 0 ? ['V4 workspace compile deferred'] : []),
    ].join('; ') || 'no Rust compile applicable';
process.stdout.write(`[verify:fast] PASS checked ${entries.length} file version(s); ${skippedFullCi}; ${compileEvidence}\n`);
