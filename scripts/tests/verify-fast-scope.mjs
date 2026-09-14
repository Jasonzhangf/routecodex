#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const repo = process.cwd();
const verifier = join(repo, 'scripts', 'verify-fast.mjs');
const fineScopes = [
  'v3_architecture',
  'v3_build',
  'v3_provider',
  'v3_session',
  'v3_debug',
  'v3_router',
  'v3_tool',
];
const cases = [
  { relative: 'docs/design/v3-gate.md', v3: true, v4: false },
  { relative: 'docs/goals/v3-gate.md', v3: true, v4: false },
  { relative: 'docs/schemas/v3-gate.yml', v3: true, v4: false },
  { relative: '.agents/skills/gate/SKILL.md', v3: false, v4: false },
  { relative: 'scripts/unrelated-tool.mjs', contents: 'export const scopeFixture = true;\n', v3: false, v4: false },
  { relative: 'scripts/architecture/verify-v3-dependency-projection.mjs', contents: 'export const scopeFixture = true;\n', v3: true, v4: false },
  { relative: 'scripts/architecture/architecture-wiki-lib.mjs', contents: 'export const scopeFixture = true;\n', v3: true, v4: false },
  { relative: 'scripts/architecture/verify-architecture-mainline-call-map.mjs', contents: 'export const scopeFixture = true;\n', v3: true, v4: false },
  { relative: 'scripts/architecture/verify-runtime-responses-provider-compat.mjs', contents: 'export const scopeFixture = true;\n', v3: true, v4: false },
  { relative: 'scripts/architecture/verify-sse-architecture-boundary.mjs', contents: 'export const scopeFixture = true;\n', v3: true, v4: false },
  { relative: 'scripts/architecture/verify-agent-collab-protocol.mjs', contents: 'export const scopeFixture = true;\n', v3: false, v4: false },
  { relative: 'scripts/architecture/verify-agent-p0-payload-control-guard.mjs', contents: 'export const scopeFixture = true;\n', v3: false, v4: false },
  { relative: 'scripts/install-global.sh', contents: '#!/bin/sh\ntrue\n', v3: true, v4: false },
  { relative: 'scripts/install-release.sh', contents: '#!/bin/sh\ntrue\n', v3: true, v4: false },
  { relative: 'scripts/run-v3-cargo-test.mjs', contents: 'export const scopeFixture = true;\n', v3: true, v4: false },
  { relative: 'scripts/tests/v3-scope-fixture.mjs', contents: 'export const scopeFixture = true;\n', v3: true, v4: false },
  { relative: '.agents/skills/rcc-dev-skills/references/96-v3-selected-provider-model-binding-sop.md', v3: true, v4: false },
  { relative: 'sharedmodule/llmswitch-core/src/conversion/compat/provider-resolution-config.json', contents: '{}\n', v3: true, v4: false },
  { relative: 'scripts/ci/unrelated-check.mjs', contents: 'export const scopeFixture = true;\n', v3: false, v4: false },
  { relative: 'scripts/ci/check-file-line-limit.mjs', contents: 'export const scopeFixture = true;\n', v3: true, v4: false },
  { relative: 'scripts/ci/repo-sanity.mjs', contents: 'export const scopeFixture = true;\n', v3: true, v4: false },
  { relative: 'scripts/ci/mempalace-scan-artifact-audit.mjs', contents: 'export const scopeFixture = true;\n', v3: true, v4: false },
  { relative: 'scripts/tests/repository-filesystem-governance-red-fixtures.mjs', contents: 'export const scopeFixture = true;\n', v3: true, v4: false },
  { relative: 'scripts/tests/agent-collab-protocol-red-fixtures.mjs', contents: 'export const scopeFixture = true;\n', v3: false, v4: false },
  { relative: 'scripts/tests/agent-p0-payload-control-guard-red-fixtures.mjs', contents: 'export const scopeFixture = true;\n', v3: false, v4: false },
  { relative: 'package.json', contents: '{"scripts":{"verify:v4":"npm --prefix v4 run verify:ci"}}\n', fine: Object.fromEntries(fineScopes.map((name) => [name, true])), v3: true, v4: true },
  { relative: 'scripts/verify-fast.mjs', contents: 'export const scopeFixture = true;\n', fine: Object.fromEntries(fineScopes.map((name) => [name, true])), v3: true, v4: true },
  { relative: 'scripts/ensure-cli-command-shim.mjs', contents: 'export const scopeFixture = true;\n', v3: true, v4: false },
  { relative: 'scripts/install-v3-cli.mjs', contents: 'export const scopeFixture = true;\n', v3: true, v4: false },
  { relative: 'tests/scripts/v3-cli-distribution.spec.mjs', contents: 'export const scopeFixture = true;\n', v3: true, v4: false },
  { relative: 'v3/crates/routecodex-v3-provider-responses/src/lib.rs', contents: 'pub const SCOPE_FIXTURE: bool = true;\n', fine: { v3_build: true, v3_provider: true }, v3: true, v4: false },
  { relative: 'v3/crates/routecodex-v3-runtime/src/session_admission.rs', contents: 'pub const SCOPE_FIXTURE: bool = true;\n', fine: { v3_build: true, v3_session: true }, v3: true, v4: false },
  { relative: 'v3/crates/routecodex-v3-debug/src/lib.rs', contents: 'pub const SCOPE_FIXTURE: bool = true;\n', fine: { v3_build: true, v3_debug: true }, v3: true, v4: false },
  { relative: 'v3/crates/routecodex-v3-virtual-router/src/lib.rs', contents: 'pub const SCOPE_FIXTURE: bool = true;\n', fine: { v3_build: true, v3_router: true }, v3: true, v4: false },
  {
    relative: '.github/workflows/test.yml',
    contents: '  - name: V3 gate\n    run: npm run verify:v3\n',
    fine: { v3_architecture: true },
    v3: true,
    v4: false,
  },
  {
    relative: '.github/workflows/test.yml',
    contents: '  - name: V4 gate\n    run: npm --prefix v4 run verify:ci\n',
    v3: false,
    v4: true,
  },
  {
    relative: '.github/workflows/test.yml',
    contents: '  timeout-minutes: 10\n',
    fine: Object.fromEntries(fineScopes.map((name) => [name, true])),
    v3: true,
    v4: true,
  },
  {
    relative: '.github/workflows/test.yml',
    contents: '  - name: V4 gate\n    run: npm --prefix v4 run verify:ci\n',
    diffMode: 'new-ref',
    v3: false,
    v4: true,
  },
];
const failures = [];

const workflow = readFileSync(join(repo, '.github', 'workflows', 'test.yml'), 'utf8');
const v3Verify = readFileSync(join(repo, 'v3', 'scripts', 'verify.mjs'), 'utf8');
const directArchitectureRuns = (workflow.match(/^\s*run: npm run verify:v3-architecture-ci\s*$/gmu) ?? []).length;
const canonicalArchitectureRuns = (v3Verify.match(/label: 'architecture-ci'/gu) ?? []).length;
if (directArchitectureRuns !== 0) {
  failures.push(`workflow duplicates canonical architecture-ci gate: ${directArchitectureRuns} direct invocation(s)`);
}
if (canonicalArchitectureRuns !== 1) {
  failures.push(`v3 verify:ci must retain exactly one canonical architecture-ci gate: ${canonicalArchitectureRuns}`);
}
const independentGateScopes = {
  'Fallback and internal policy hardcode gate': 'v3',
  'V3 Responses session admission behavior': 'v3_session',
  'File line-limit gate (<500)': 'v3',
  'V3 provider action gate': 'v3_provider',
  'V3 provider action architecture gate': 'v3_provider',
  'V3 provider action red fixtures': 'v3_provider',
  'V3 5520 duplicate response tool identity': 'v3_tool',
  'V3 debug side-channel contract': 'v3_debug',
  'V3 debug payload budget': 'v3_debug',
  'V3 debug payload budget red fixtures': 'v3_debug',
  'V3 route-classifier semantic gate': 'v3_router',
  'Servertool Rust-only gate': 'v3_tool',
};
for (const [name, scope] of Object.entries(independentGateScopes)) {
  const start = workflow.indexOf(`      - name: ${name}\n`);
  const end = workflow.indexOf('\n      - ', start + 1);
  const block = start >= 0 ? workflow.slice(start, end >= 0 ? end : undefined) : '';
  if (!block.includes(`needs.scope.outputs.${scope} == 'true'`)) {
    failures.push(`workflow gate is not sibling-safe: ${name}`);
  }
}
for (const name of ['Build (release)', 'Install direct V3 CLI binary', 'Install built V3 CLI shim', 'Run host tests after install']) {
  const start = workflow.indexOf(`      - name: ${name}\n`);
  const end = workflow.indexOf('\n      - ', start + 1);
  const block = start >= 0 ? workflow.slice(start, end >= 0 ? end : undefined) : '';
  if (block.includes('!cancelled()')) {
    failures.push(`dependent step must retain success dependency: ${name}`);
  }
}

mkdirSync(join(repo, 'playground'), { recursive: true });
for (const { relative, contents, diffMode, fine, v3, v4 } of cases) {
  const root = mkdtempSync(join(repo, 'playground', '.verify-fast-scope-'));
  try {
    const target = join(root, relative);
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, contents ?? 'scope fixture\n');
    symlinkSync(join(repo, 'node_modules'), join(root, 'node_modules'), 'dir');
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['add', relative], { cwd: root });
    const diffEnv = {};
    if (diffMode === 'new-ref') {
      execFileSync('git', ['-c', 'user.name=Scope Test', '-c', 'user.email=scope@example.invalid', 'commit', '-qm', 'scope fixture'], { cwd: root });
      diffEnv.ROUTECODEX_GATE_DIFF_BASE = '0'.repeat(40);
      diffEnv.ROUTECODEX_GATE_DIFF_HEAD = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    }
    const outputPath = join(root, 'scope-output.txt');
    const result = spawnSync(process.execPath, [verifier], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        ...(diffMode === 'new-ref' ? {} : { ROUTECODEX_GATE_DIFF_MODE: 'staged' }),
        ROUTECODEX_GATE_SCOPE_ONLY: '1',
        ROUTECODEX_GATE_SCOPE_OUTPUT: outputPath,
        ...diffEnv,
      },
    });
    const output = `${result.stdout || ''}\n${result.stderr || ''}`;
    const scope = existsSync(outputPath) ? readFileSync(outputPath, 'utf8') : '<missing scope output>';
    const expectedFine = fine && Object.fromEntries(fineScopes.map((name) => [name, fine[name] === true]));
    const fineMatches = !fine || fineScopes.every((name) => scope.includes(`${name}=${expectedFine[name]}\n`));
    if (result.status !== 0 || !scope.includes(`v3=${v3}\n`) || !scope.includes(`v4=${v4}\n`) || !fineMatches) {
      failures.push(`${relative}: expected v3=${v3}, v4=${v4}, got status=${result.status}\n${output}`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const missingRustOwnerRoot = mkdtempSync(join(repo, 'playground', '.verify-fast-rust-owner-'));
try {
  const manifestPath = join(missingRustOwnerRoot, 'v3', 'Cargo.toml');
  const knownManifestPath = join(missingRustOwnerRoot, 'v3', 'crates', 'known-owner', 'Cargo.toml');
  const knownSourcePath = join(missingRustOwnerRoot, 'v3', 'crates', 'known-owner', 'src', 'lib.rs');
  mkdirSync(join(manifestPath, '..'), { recursive: true });
  mkdirSync(join(knownManifestPath, '..'), { recursive: true });
  mkdirSync(join(knownSourcePath, '..'), { recursive: true });
  writeFileSync(manifestPath, '[workspace]\nmembers = ["crates/known-owner"]\nresolver = "2"\n');
  writeFileSync(knownManifestPath, '[package]\nname = "known-owner"\nversion = "0.1.0"\nedition = "2021"\n');
  writeFileSync(knownSourcePath, 'pub const KNOWN_OWNER: bool = true;\n');
  writeFileSync(join(missingRustOwnerRoot, 'v3', 'Cargo.lock'), '# This file is automatically @generated by Cargo.\nversion = 3\n');
  const rustPath = join(missingRustOwnerRoot, 'v3', 'crates', 'missing-owner', 'src', 'lib.rs');
  mkdirSync(join(rustPath, '..'), { recursive: true });
  writeFileSync(rustPath, 'pub const OWNER_FIXTURE: bool = true;\n');
  symlinkSync(join(repo, 'node_modules'), join(missingRustOwnerRoot, 'node_modules'), 'dir');
  execFileSync('git', ['init', '-q'], { cwd: missingRustOwnerRoot });
  execFileSync('git', ['add', 'v3/crates/missing-owner/src/lib.rs'], { cwd: missingRustOwnerRoot });
  const result = spawnSync(process.execPath, [verifier], {
    cwd: missingRustOwnerRoot,
    encoding: 'utf8',
    env: { ...process.env, ROUTECODEX_GATE_DIFF_MODE: 'staged' },
  });
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  if (result.status === 0 || !output.includes('file(s) are not owned by a V3 Cargo package') || !output.includes('v3/crates/missing-owner/src/lib.rs')) {
    failures.push(`missing Rust owner evidence must fail fast, got status=${result.status}\n${output}`);
  }
} finally {
  rmSync(missingRustOwnerRoot, { recursive: true, force: true });
}

const v4RustRoot = mkdtempSync(join(repo, 'playground', '.verify-fast-v4-rust-'));
try {
  const rustPath = join(v4RustRoot, 'v4', 'crates', 'routecodex-v4-config', 'src', 'lib.rs');
  mkdirSync(join(rustPath, '..'), { recursive: true });
  writeFileSync(rustPath, 'pub const V4_OWNER_FIXTURE: bool = true;\n');
  symlinkSync(join(repo, 'node_modules'), join(v4RustRoot, 'node_modules'), 'dir');
  execFileSync('git', ['init', '-q'], { cwd: v4RustRoot });
  execFileSync('git', ['add', 'v4/crates/routecodex-v4-config/src/lib.rs'], { cwd: v4RustRoot });
  const result = spawnSync(process.execPath, [verifier], {
    cwd: v4RustRoot,
    encoding: 'utf8',
    env: { ...process.env, ROUTECODEX_GATE_DIFF_MODE: 'staged' },
  });
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  if (result.status !== 0 || !output.includes('V4 workspace compile deferred')) {
    failures.push(`V4 Rust owner must defer to its workspace gate, got status=${result.status}\n${output}`);
  }
  const scopedResult = spawnSync(process.execPath, [verifier], {
    cwd: v4RustRoot,
    encoding: 'utf8',
    env: { ...process.env, ROUTECODEX_GATE_DIFF_MODE: 'staged', ROUTECODEX_GATE_SCOPE_ONLY: '1' },
  });
  const scopedOutput = `${scopedResult.stdout || ''}\n${scopedResult.stderr || ''}`;
  if (scopedResult.status !== 0 || !scopedOutput.includes('scoped V4 workspace job') || scopedOutput.includes('scoped V3 test job')) {
    failures.push(`V4 scope-only compile must name the V4 workspace gate, got status=${scopedResult.status}\n${scopedOutput}`);
  }
} finally {
  rmSync(v4RustRoot, { recursive: true, force: true });
}

const unsupportedRustRoot = mkdtempSync(join(repo, 'playground', '.verify-fast-unsupported-rust-'));
try {
  const rustPath = join(unsupportedRustRoot, 'sharedmodule', 'unknown-core', 'rust-core', 'src', 'lib.rs');
  mkdirSync(join(rustPath, '..'), { recursive: true });
  writeFileSync(rustPath, 'pub const UNSUPPORTED_OWNER: bool = true;\n');
  symlinkSync(join(repo, 'node_modules'), join(unsupportedRustRoot, 'node_modules'), 'dir');
  execFileSync('git', ['init', '-q'], { cwd: unsupportedRustRoot });
  execFileSync('git', ['add', 'sharedmodule/unknown-core/rust-core/src/lib.rs'], { cwd: unsupportedRustRoot });
  const result = spawnSync(process.execPath, [verifier], {
    cwd: unsupportedRustRoot,
    encoding: 'utf8',
    env: { ...process.env, ROUTECODEX_GATE_DIFF_MODE: 'staged', ROUTECODEX_GATE_SCOPE_ONLY: '1' },
  });
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  if (result.status === 0 || !output.includes('affected Rust compile evidence unavailable') || output.includes('deferred')) {
    failures.push(`unsupported Rust owner must fail closed, got status=${result.status}\n${output}`);
  }
} finally {
  rmSync(unsupportedRustRoot, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error('[test:verify-fast-scope] failed');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`[test:verify-fast-scope] ok (${cases.length} scope contracts, including V3-only/V4-only/shared workflow changes)`);
