import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const workflow = readFileSync('.github/workflows/test.yml', 'utf8');
const rootPackage = JSON.parse(readFileSync('package.json', 'utf8'));
const v3Package = JSON.parse(readFileSync('v3/package.json', 'utf8'));
const verifyCi = readFileSync('v3/scripts/verify-ci.mjs', 'utf8');
const verify = readFileSync('v3/scripts/verify.mjs', 'utf8');
const architectureCi = readFileSync('v3/scripts/architecture/verify-v3-architecture-ci.mjs', 'utf8');
const verifyRed = readFileSync('v3/scripts/verify-red.mjs', 'utf8');

const namedGates = {
  'file-size': {
    positive: 'verify:v3-file-size',
    negative: 'test:v3-file-size-red-fixtures',
    negativePath: 'scripts/tests/v3-file-size-red-fixtures.mjs',
  },
  'console-request-count': {
    positive: 'verify:v3-console-request-count-visibility',
    negative: 'test:v3-console-request-count-visibility-red-fixtures',
    negativePath: 'scripts/tests/v3-console-request-count-visibility-red-fixtures.mjs',
  },
  'responses-session-admission': {
    positive: 'verify:v3-responses-session-admission',
    negative: 'test:v3-responses-session-admission-red-fixtures',
    negativePath: 'scripts/tests/v3-responses-session-admission-red-fixtures.mjs',
  },
};

function count(text, fragment) {
  return text.split(fragment).length - 1;
}

function workflowCommandCount(script) {
  return count(workflow, script);
}

function transitiveGateCount(script) {
  let total = workflowCommandCount(script);
  if (workflow.includes('npm run test:v3-workspace')) {
    total += count(rootPackage.scripts['test:v3-workspace'] ?? '', script);
  }
  if (workflow.includes('npm --prefix v3 run verify:ci')) {
    if (verifyCi.includes('scripts/verify.mjs') && verify.includes('scripts/architecture/verify-v3-architecture-ci.mjs')) {
      total += count(architectureCi, script);
      if (architectureCi.includes('verify:v3-architecture-docs')) {
        total += count(v3Package.scripts['verify:v3-architecture-docs'] ?? '', script);
      }
    }
    if (verifyCi.includes('scripts/verify-red.mjs')) {
      const gate = Object.values(namedGates).find((candidate) => candidate.negative === script);
      if (gate) total += count(verifyRed, gate.negativePath);
    }
  }
  return total;
}

test('V3 CI keeps named gate wiring within canonical V3 verification', () => {
  const counts = {};
  for (const [name, gate] of Object.entries(namedGates)) {
    counts[name] = {
      positive: transitiveGateCount(gate.positive),
      negative: transitiveGateCount(gate.negative),
    };
  }
  // file-size's two red executions are an existing duplicate inside the
  // unmodified V3 deep stack: architecture-ci and verify-red. The workflow
  // owner must not add another execution; all other named paths are singular.
  assert.deepEqual(counts, {
    'file-size': { positive: 1, negative: 2 },
    'console-request-count': { positive: 1, negative: 1 },
    'responses-session-admission': { positive: 1, negative: 1 },
  }, `unexpected V3 CI gate execution: ${JSON.stringify(counts)}`);
  assert.equal(transitiveGateCount('verify:v3-runtime-timing-observability'), 1);
  assert.match(architectureCi, /'verify:v3-architecture-docs'/);
  assert.match(v3Package.scripts['verify:v3-architecture-docs'], /verify:v3-runtime-timing-observability/);
  assert.doesNotMatch(verifyRed, /v3-runtime-timing-observability-red-fixtures\.mjs/);
  assert.match(workflow, /npm --prefix v3 run verify:ci/);
  const canonicalStackStart = workflow.indexOf('      - name: V3 canonical verification stack\n');
  const canonicalStackEnd = workflow.indexOf('\n      - name: ', canonicalStackStart + 1);
  const canonicalStack = workflow.slice(canonicalStackStart, canonicalStackEnd);
  assert.match(canonicalStack, /needs\.scope\.outputs\.v3_architecture == 'true'/);
  assert.doesNotMatch(canonicalStack, /needs\.scope\.outputs\.v3 == 'true'/);
  assert.match(workflow, /BUILD_MODE: release/);
  assert.match(workflow, /node v3\/scripts\/run-v3-cargo-test\.mjs --workspace -- --nocapture/);
  assert.doesNotMatch(workflow, /RUSTUP_TOOLCHAIN=stable|run-v3-cargo-test\.mjs \+stable/);
  assert.ok(workflow.indexOf('npm --prefix v3 run verify:ci') < workflow.indexOf('run: npm run build:min'));
});

test('V3 Clippy keeps ordinary lints non-blocking while compile failures remain errors', () => {
  assert.doesNotMatch(v3Package.scripts['verify:v3-clippy'], /-D warnings/);
  assert.match(verify, /command: 'npm',[\s\S]*args: \['run', 'verify:v3-clippy'\]/);
});
