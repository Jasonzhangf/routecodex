#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const repo = process.cwd();
const verifier = join(repo, 'scripts', 'verify-fast.mjs');
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
  { relative: 'package.json', contents: '{"scripts":{"verify:v4":"npm --prefix v4 run verify:ci"}}\n', v3: true, v4: true },
  { relative: 'scripts/ensure-cli-command-shim.mjs', contents: 'export const scopeFixture = true;\n', v3: true, v4: false },
  { relative: 'scripts/install-v3-cli.mjs', contents: 'export const scopeFixture = true;\n', v3: true, v4: false },
  { relative: 'tests/scripts/v3-cli-distribution.spec.mjs', contents: 'export const scopeFixture = true;\n', v3: true, v4: false },
  {
    relative: '.github/workflows/test.yml',
    contents: '  - name: V3 gate\n    run: npm run verify:v3\n',
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
const independentGateNames = [
  'Fallback and internal policy hardcode gate',
  'V3 Responses session admission',
  'V3 Responses session admission red fixtures',
  'V3 Responses session admission behavior',
  'File line-limit gate (<500)',
  'V3 file-size ratchet gate (<=1500)',
  'V3 and shared classifier file-size red fixtures',
  'V3 provider action gate',
  'V3 provider action architecture gate',
  'V3 provider action red fixtures',
  'V3 5520 duplicate response tool identity',
  'V3 Runtime timing observability',
  'V3 Runtime timing red fixtures',
  'V3 debug side-channel contract',
  'V3 debug payload budget',
  'V3 debug payload budget red fixtures',
  'V3 canonical verification stack',
  'V3 console request count red fixtures',
  'V3 route-classifier semantic gate',
  'Servertool Rust-only gate',
];
const independentStepCondition = "if: ${{ !cancelled() && needs.scope.outputs.v3 == 'true' }}";
for (const name of independentGateNames) {
  const start = workflow.indexOf(`      - name: ${name}\n`);
  const end = workflow.indexOf('\n      - ', start + 1);
  const block = start >= 0 ? workflow.slice(start, end >= 0 ? end : undefined) : '';
  if (!block.includes(independentStepCondition)) {
    failures.push(`workflow gate is not sibling-safe: ${name}`);
  }
}
for (const name of ['Build (release)', 'Install direct V3 CLI binary', 'Install built V3 CLI shim', 'Run host tests']) {
  const start = workflow.indexOf(`      - name: ${name}\n`);
  const end = workflow.indexOf('\n      - ', start + 1);
  const block = start >= 0 ? workflow.slice(start, end >= 0 ? end : undefined) : '';
  if (block.includes('!cancelled()')) {
    failures.push(`dependent step must retain success dependency: ${name}`);
  }
}

mkdirSync(join(repo, 'playground'), { recursive: true });
for (const { relative, contents, diffMode, v3, v4 } of cases) {
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
        ROUTECODEX_GATE_SCOPE_OUTPUT: outputPath,
        ...diffEnv,
      },
    });
    const output = `${result.stdout || ''}\n${result.stderr || ''}`;
    const scope = existsSync(outputPath) ? readFileSync(outputPath, 'utf8') : '<missing scope output>';
    if (result.status !== 0 || !scope.includes(`v3=${v3}\n`) || !scope.includes(`v4=${v4}\n`)) {
      failures.push(`${relative}: expected v3=${v3}, v4=${v4}, got status=${result.status}\n${output}`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (failures.length > 0) {
  console.error('[test:verify-fast-scope] failed');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`[test:verify-fast-scope] ok (${cases.length} scope contracts, including V3-only/V4-only/shared workflow changes)`);
