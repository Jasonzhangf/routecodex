#!/usr/bin/env node
/**
 * V4-LAYER-GATE-001
 *
 * Default mode validates the machine definition without requiring every lane to
 * be ready. Explicit admission binds committed candidates, evidence, real gate
 * executions and observed production wiring. Build guard admits independent
 * source builds only while guarded product wiring is unchanged.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ARCHITECTURE_GATES, RED_SUITES } from '../_gate-matrix.mjs';
import { addFailure } from './lib/feature-layer-batch-contract.mjs';
import { validateFeatureLayerDefinition } from './lib/feature-layer-batch-definition.mjs';
import { validateFeatureLayerAdmission } from './lib/feature-layer-batch-admission.mjs';
import { observeWiring } from './lib/feature-layer-batch-graph.mjs';
import { createGitTruth } from './lib/feature-layer-batch-git.mjs';
import {
  runFeatureLayerBatchBoundarySelfTest,
  runFeatureLayerBatchRedFixtures,
  runFeatureLayerBatchSelfTest,
} from '../tests/v4-feature-layer-batches-red-fixtures.mjs';

const gatePath = fileURLToPath(import.meta.url);
const v4Root = path.resolve(path.dirname(gatePath), '..', '..');
const repoRoot = path.resolve(v4Root, '..');
const MANIFEST_PATH = 'contracts/feature-completion-layer-batches.manifest.json';
const VALID_MODES = new Set([
  'definition',
  'admission',
  'build-guard',
  'self-test',
  'boundary-self-test',
  'red-self-test',
]);

function readText(relativePath) {
  return fs.readFileSync(path.join(v4Root, relativePath), 'utf8');
}

function readJson(relativePath) {
  return JSON.parse(readText(relativePath));
}

function createIo() {
  return { readText, readJson };
}

export function loadCanonicalInput() {
  return {
    manifest: readJson(MANIFEST_PATH),
    functionMap: readJson('.appsdk/maps/function-map.json'),
    moduleRegistry: readJson('.appsdk/maps/module-registry.json'),
    resourceMap: readJson('.appsdk/maps/resource-map.json'),
    verificationMap: readJson('.appsdk/maps/verification-map.json'),
    mainlineMap: readJson('.appsdk/maps/mainline-call-map.json'),
    gateInputContract: readJson('contracts/feature-layer-gate-inputs.contract.json'),
    packageJson: readJson('package.json'),
    planSource: readText('docs/goals/v4-feature-completion-plan.md'),
    buildSource: readText('scripts/build.mjs'),
    verifySource: readText('scripts/verify.mjs'),
    verifyCiSource: readText('scripts/verify-ci.mjs'),
    installSource: readText('scripts/install-rccv4.mjs'),
    compileManifestSource: readText('scripts/compile-real-runtime-manifest.mjs'),
    architectureGates: [...ARCHITECTURE_GATES],
    redSuites: RED_SUITES.map((entry) => [...entry]),
  };
}

export function createProductionContext() {
  return {
    io: createIo(),
    truth: createGitTruth({ repoRoot, v4Root }),
    now: Date.now(),
  };
}

export function validateFeatureLayerBatchAdmission(input, context, options = {}) {
  const mode = options.mode ?? 'definition';
  const failures = [];
  if (!VALID_MODES.has(mode) || ['self-test', 'boundary-self-test', 'red-self-test'].includes(mode)) {
    addFailure(failures, 'MODE_INVALID', `validator mode ${mode} is not a production validation mode`);
    return failures;
  }
  failures.push(...validateFeatureLayerDefinition(input, context, {
    allowPendingGuard: options.allowPendingGuard === true,
  }));
  if (mode === 'admission') {
    validateFeatureLayerAdmission(input, context, failures);
  } else if (mode === 'build-guard') {
    let observed;
    try {
      observed = observeWiring(input.manifest, context);
    } catch (error) {
      addFailure(failures, 'WIRING_GRAPH_UNREADABLE', error.message);
      return failures;
    }
    if (!observed.readable) {
      addFailure(failures, 'WIRING_GUARD_UNBOUND', 'build guard requires an exact source candidate');
    } else if (observed.wiring_edges.length > 0) {
      validateFeatureLayerAdmission(input, context, failures, {
        requireIntegrationRecords: false,
      });
    }
  }
  return failures;
}

function printFailures(label, failures) {
  console.error(`[V4-LAYER-GATE-001] ${label} FAIL`);
  for (const item of failures) console.error(`${item.code}: ${item.message}`);
}

function modeFromArgs(args) {
  if (args.length === 0) return 'definition';
  if (args.length !== 1) return null;
  const modes = {
    '--admission': 'admission',
    '--build-guard': 'build-guard',
    '--self-test': 'self-test',
    '--boundary-self-test': 'boundary-self-test',
    '--red-self-test': 'red-self-test',
  };
  return modes[args[0]] ?? null;
}

function runProductionMode(mode) {
  const failures = validateFeatureLayerBatchAdmission(
    loadCanonicalInput(),
    createProductionContext(),
    { mode, allowPendingGuard: mode !== 'admission' },
  );
  if (failures.length > 0) {
    printFailures(mode.toUpperCase(), failures);
    process.exit(1);
  }
  if (mode === 'admission') {
    console.log('[V4-LAYER-GATE-001] ADMISSION READY exact candidates/evidence/gates/wiring accepted');
  } else if (mode === 'build-guard') {
    console.log('[V4-LAYER-GATE-001] BUILD GUARD OK independent source or admitted wiring');
  } else {
    console.log('[V4-LAYER-GATE-001] DEFINITION OK layer contract and preflight bindings locked');
  }
}

function runSelfTestMode(mode) {
  const canonicalInput = loadCanonicalInput();
  const context = createProductionContext();
  const runner = mode === 'self-test'
    ? runFeatureLayerBatchSelfTest
    : mode === 'boundary-self-test'
      ? runFeatureLayerBatchBoundarySelfTest
      : runFeatureLayerBatchRedFixtures;
  const result = runner({
    canonicalInput,
    productionContext: context,
    validate: validateFeatureLayerBatchAdmission,
  });
  if (result.failures.length > 0 || result.passed !== result.total) {
    printFailures(mode.toUpperCase(), result.failures);
    process.exit(1);
  }
  console.log(`[V4-LAYER-GATE-001] ${mode.toUpperCase()} OK ${result.passed}/${result.total}`);
}

const direct = process.argv[1] && path.resolve(process.argv[1]) === gatePath;
if (direct) {
  const mode = modeFromArgs(process.argv.slice(2));
  if (!mode) {
    console.error(`[V4-LAYER-GATE-001] MODE_INVALID ${process.argv.slice(2).join(' ') || '(empty)'}`);
    process.exit(2);
  }
  if (['self-test', 'boundary-self-test', 'red-self-test'].includes(mode)) {
    runSelfTestMode(mode);
  } else {
    runProductionMode(mode);
  }
}
