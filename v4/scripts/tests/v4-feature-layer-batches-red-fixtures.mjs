import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  patternContains,
  patternsOverlap,
  sortedUnique,
} from '../architecture/lib/feature-layer-batch-contract.mjs';
import { parseCargoWorkspace } from '../architecture/lib/feature-layer-batch-cargo.mjs';
import { createGitTruth } from '../architecture/lib/feature-layer-batch-git.mjs';
import { validateTaskSourceGraph } from '../architecture/lib/feature-layer-batch-graph.mjs';
import { runAllReadyAdmissionFixture } from './feature-layer-batch-admission-fixture.mjs';

const fixtureV4Root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function result(passed, total, failures = []) {
  return { passed, total, failures };
}

function failure(code, message) {
  return { code, message };
}

function codes(failures) {
  return sortedUnique(failures.map((item) => item.code));
}

function sameCodes(actual, expected) {
  return JSON.stringify(codes(actual)) === JSON.stringify([...expected].sort());
}

function resetPendingGuard(input) {
  input.manifest.integration.enforcement_binding_status = 'pending_candidate';
  input.manifest.integration.guard_commit = null;
  for (const surface of input.manifest.integration.guarded_surfaces) surface.scope_hash = null;
}

function resetPendingBatch(input, batchId) {
  const batch = input.manifest.batches.find((candidate) => candidate.batch_id === batchId);
  if (!batch) throw new Error(`missing fixture batch ${batchId}`);
  batch.owner_binding_status = 'pending';
  batch.owner_function_id = null;
  batch.module_ids = [];
  batch.owned_paths = [];
  batch.status = 'pending';
  for (const task of batch.tasks) {
    task.status = 'pending';
    task.candidate_record = null;
    task.function_ids = [];
    task.resource_ids = [];
    task.source_paths = [];
    task.support_paths = [];
    task.required_gate_ids = [];
    task.evidence_refs = [];
  }
  return batch;
}

function run(command, args, cwd) {
  const receipt = spawnSync(command, args, { cwd, encoding: 'utf8' });
  if (receipt.error) throw receipt.error;
  if (receipt.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited ${receipt.status}: ${receipt.stderr}`);
  }
  return receipt.stdout.trim();
}

function write(relativeRoot, relativePath, source, mode = 0o644) {
  const absolute = path.join(relativeRoot, relativePath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, source);
  fs.chmodSync(absolute, mode);
}

function commit(repo, message) {
  run('git', ['add', '--all'], repo);
  run('git', ['commit', '-m', message], repo);
  return run('git', ['rev-parse', 'HEAD'], repo);
}

function withGitFixture(callback) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'v4-layer-gate-'));
  try {
    run('git', ['init', '--quiet'], repo);
    run('git', ['config', 'user.name', 'V4 Gate Fixture'], repo);
    run('git', ['config', 'user.email', 'v4-gate@example.invalid'], repo);
    write(repo, 'v4/Cargo.toml', '[workspace]\nmembers = ["crates/a"]\nresolver = "2"\n');
    write(repo, 'v4/crates/a/Cargo.toml',
      '[package]\nname = "a"\nversion = "0.1.0"\nedition = "2021"\n[dependencies]\n');
    write(repo, 'v4/crates/a/src/lib.rs', 'pub fn baseline() {}\n');
    const base = commit(repo, 'base');
    const truth = createGitTruth({ repoRoot: repo, v4Root: path.join(repo, 'v4') });
    return callback({ repo, base, truth });
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
}

function validateGitIdentity() {
  return withGitFixture(({ repo, base, truth }) => {
    write(repo, 'v4/crates/a/src/gate.rs', 'pub fn admitted() {}\n', 0o755);
    const head = commit(repo, 'candidate');
    const identity = truth.deriveCandidateIdentity({
      baseCommit: base,
      headCommit: head,
      binding: { schema: 'fixture/v1', batch_id: 'A', module_id: 'a', task_ids: ['T'] },
    });
    if (!identity
        || identity.base_commit !== base
        || identity.head_commit !== head
        || identity.changed_paths.join(',') !== 'v4/crates/a/src/gate.rs'
        || identity.blobs[0]?.mode !== '100755') {
      throw new Error('real Git candidate identity did not bind commit/path/mode');
    }
    if (!truth.controlledScopeClean(['v4/**'])) throw new Error('committed fixture is unexpectedly dirty');
    write(repo, 'v4/dirty-probe.txt', 'dirty\n');
    if (truth.controlledScopeClean(['v4/**'])) throw new Error('dirty V4 scope was accepted');
    fs.rmSync(path.join(repo, 'v4/dirty-probe.txt'));
    fs.chmodSync(path.join(repo, 'v4/crates/a/src/gate.rs'), 0o644);
    if (truth.currentPathEqualsCommit('crates/a/src/gate.rs', head)) {
      throw new Error('executable mode drift was not detected');
    }
    fs.chmodSync(path.join(repo, 'v4/crates/a/src/gate.rs'), 0o755);
    write(repo, 'outside-v4.txt', 'foreign\n');
    const foreignHead = commit(repo, 'foreign');
    let rejected = false;
    try {
      truth.deriveCandidateIdentity({
        baseCommit: head,
        headCommit: foreignHead,
        binding: { schema: 'fixture/v1', batch_id: 'A', module_id: 'a', task_ids: ['T'] },
      });
    } catch (error) {
      rejected = error.message.includes('non-V4 paths');
    }
    if (!rejected) throw new Error('non-V4 candidate path was accepted');
    return true;
  });
}

function validateCargoDependencyForms() {
  const rootSource = [
    '[workspace]',
    'members = ["crates/a", "crates/b", "crates/shared", "crates/table", "crates/quoted"]',
    '[workspace.dependencies]',
    'shared = { path = "crates/shared", package = "shared-real" }',
    '[workspace.dependencies.workspace_table]',
    'path = "crates/table"',
    'package = "table-real"',
    '',
  ].join('\n');
  const manifests = new Map([
    ['crates/a/Cargo.toml', [
      '[package]',
      'name = "a"',
      '[target.\'cfg(unix)\'.dependencies]',
      'shared = { workspace = true }',
      '[dependencies.b_alias]',
      'path = "../b"',
      'package = "b-real"',
      '[dependencies."quoted_alias"]',
      'path = "../quoted"',
      'package = "quoted-real"',
      '[build-dependencies.workspace_table]',
      'workspace = true',
      '',
    ].join('\n')],
    ['crates/b/Cargo.toml', '[package]\nname = "b-real"\n'],
    ['crates/shared/Cargo.toml', '[package]\nname = "shared-real"\n'],
    ['crates/table/Cargo.toml', '[package]\nname = "table-real"\n'],
    ['crates/quoted/Cargo.toml', '[package]\nname = "quoted-real"\n'],
  ]);
  const packages = parseCargoWorkspace(rootSource, manifests);
  const edges = packages.get('a')?.dependencies.map((dependency) =>
    `${dependency.dependency_name}:${dependency.manifest_path}`) ?? [];
  const expected = [
    'b-real:crates/b/Cargo.toml',
    'quoted-real:crates/quoted/Cargo.toml',
    'shared-real:crates/shared/Cargo.toml',
    'table-real:crates/table/Cargo.toml',
  ];
  if (JSON.stringify(edges) !== JSON.stringify(expected)) {
    throw new Error(`Cargo dependency forms drifted: ${edges.join(',')}`);
  }
  let rejected = false;
  try {
    parseCargoWorkspace('[workspace]\nmembers = ["crates/a"]\n', new Map([
      ['crates/a/Cargo.toml', '[package]\nname = "a"\n[dependencies]\nbad = { path =\n"../bad" }\n'],
    ]));
  } catch (error) {
    rejected = error.message.includes('unsupported local dependency syntax');
  }
  if (!rejected) throw new Error('unsupported local Cargo dependency syntax was accepted');
  for (const [name, root, source, expectedMessage] of [
    [
      'absolute local dependency',
      '[workspace]\nmembers = ["crates/a"]\n',
      '[package]\nname = "a"\n[dependencies]\nbad = { path = "/tmp/bad" }\n',
      'must remain relative inside V4',
    ],
    [
      'root patch dependency',
      '[workspace]\nmembers = ["crates/a"]\n[patch.crates-io]\nbad = { path = "crates/bad" }\n',
      '[package]\nname = "a"\n',
      'local patch/replace dependency syntax is forbidden',
    ],
    [
      'manifest replace dependency',
      '[workspace]\nmembers = ["crates/a"]\n',
      '[package]\nname = "a"\n[replace]\n"bad:1.0.0" = { path = "../bad" }\n',
      'local patch/replace dependency syntax is forbidden',
    ],
  ]) {
    let localRejected = false;
    try {
      parseCargoWorkspace(root, new Map([['crates/a/Cargo.toml', source]]));
    } catch (error) {
      localRejected = error.message.includes(expectedMessage);
    }
    if (!localRejected) throw new Error(`${name} was accepted`);
  }
  return true;
}

function validateCrossLaneSourceForms() {
  const sources = new Map([
    ['lane-a/dynamic.mjs', Buffer.from("export async function load() { return import('../lane-b/target.mjs'); }\n")],
    ['lane-a/computed.mjs', Buffer.from("export async function load(name) { return import('../lane-b/' + name); }\n")],
    ['lane-a/direct.rs', Buffer.from('pub fn call() { routecodex_v4_b::invoke(); }\n')],
    ['lane-b/target.mjs', Buffer.from('export const target = true;\n')],
  ]);
  const failures = [];
  validateTaskSourceGraph({
    manifest: {
      batches: [
        { batch_id: 'A', owner_binding_status: 'bound', module_ids: ['routecodex-v4-a'] },
        { batch_id: 'B', owner_binding_status: 'bound', module_ids: ['routecodex-v4-b'] },
      ],
    },
    moduleRegistry: {
      modules: [
        { module_id: 'routecodex-v4-a', status: 'active', owned_paths: ['lane-a/**'] },
        { module_id: 'routecodex-v4-b', status: 'active', owned_paths: ['lane-b/**'] },
      ],
    },
    batch: { batch_id: 'A' },
    task: { task_id: 'T-A', source_paths: ['lane-a/computed.mjs', 'lane-a/dynamic.mjs', 'lane-a/direct.rs'] },
    candidateCommit: '1'.repeat(40),
    truth: {
      blob(_commit, relativePath) { return sources.get(relativePath) ?? null; },
      cargoGraph() { return new Map(); },
      trackedAt(_commit, relativePath) { return sources.has(relativePath); },
    },
    failures,
  });
  const expected = ['CROSS_LANE_JS_IMPORT', 'CROSS_LANE_RUST_REFERENCE', 'JS_IMPORT_GRAPH_UNREADABLE'];
  if (!sameCodes(failures, expected)) {
    throw new Error(`cross-lane source forms: ${codes(failures).join(',') || 'PASS'}`);
  }
  const nonCodeSources = new Map([
    ['lane-a/non-code.rs', Buffer.from([
      '// routecodex_v4_b::comment_only();',
      'pub const TEXT: &str = "routecodex_v4_b::string_only";',
      'pub const RAW: &str = r#"routecodex_v4_b::raw_string_only"#;',
      '',
    ].join('\n'))],
  ]);
  const nonCodeFailures = [];
  validateTaskSourceGraph({
    manifest: {
      batches: [
        { batch_id: 'A', owner_binding_status: 'bound', module_ids: ['routecodex-v4-a'] },
        { batch_id: 'B', owner_binding_status: 'bound', module_ids: ['routecodex-v4-b'] },
      ],
    },
    moduleRegistry: {
      modules: [
        { module_id: 'routecodex-v4-a', status: 'active', owned_paths: ['lane-a/**'] },
        { module_id: 'routecodex-v4-b', status: 'active', owned_paths: ['lane-b/**'] },
      ],
    },
    batch: { batch_id: 'A' },
    task: { task_id: 'T-A-NON-CODE', source_paths: ['lane-a/non-code.rs'] },
    candidateCommit: '1'.repeat(40),
    truth: {
      blob(_commit, relativePath) { return nonCodeSources.get(relativePath) ?? null; },
      cargoGraph() { return new Map(); },
      trackedAt(_commit, relativePath) { return nonCodeSources.has(relativePath); },
    },
    failures: nonCodeFailures,
  });
  if (nonCodeFailures.length > 0) {
    throw new Error(`Rust comments/strings became graph edges: ${codes(nonCodeFailures).join(',')}`);
  }
  return true;
}

export function runFeatureLayerBatchSelfTest({
  canonicalInput,
  productionContext,
  validate,
}) {
  const failures = [];
  const definition = validate(clone(canonicalInput), productionContext, {
    mode: 'definition',
    allowPendingGuard: true,
  });
  if (definition.length > 0) {
    failures.push(failure('PENDING_DEFINITION_REJECTED',
      definition.map((item) => `${item.code}:${item.message}`).join(' | ')));
  }
  try {
    validateGitIdentity();
  } catch (error) {
    failures.push(failure('REAL_GIT_IDENTITY_SELF_TEST', error.message));
  }
  try {
    validateCargoDependencyForms();
  } catch (error) {
    failures.push(failure('CARGO_DEPENDENCY_FORMS_SELF_TEST', error.message));
  }
  try {
    validateCrossLaneSourceForms();
  } catch (error) {
    failures.push(failure('SOURCE_GRAPH_FORMS_SELF_TEST', error.message));
  }
  try {
    runAllReadyAdmissionFixture({ canonicalInput, validate, now: productionContext.now });
  } catch (error) {
    failures.push(failure('ALL_READY_ADMISSION_SELF_TEST', error.message));
  }
  return result(5 - failures.length, 5, failures);
}

export function runFeatureLayerBatchBoundarySelfTest({
  canonicalInput,
  productionContext,
  validate,
}) {
  const failures = [];
  const checks = [
    {
      name: 'owner glob contains nested task glob',
      pass: patternContains('scripts/**', 'scripts/architecture/lib/**'),
    },
    {
      name: 'exact owner cannot claim a subtree',
      pass: !patternContains('scripts/probe', 'scripts/**'),
    },
    {
      name: 'sibling subtrees do not overlap',
      pass: !patternsOverlap('crates/a/**', 'crates/b/**'),
    },
    {
      name: 'unknown validator mode fails closed',
      pass: sameCodes(validate(canonicalInput, productionContext, { mode: 'unknown' }), ['MODE_INVALID']),
    },
  ];
  for (const [args, marker] of [
    [['scripts/architecture/verify-v4-plane-isolation.mjs'],
      '[v4_parity_gate_plane_isolation] OK'],
    [['scripts/architecture/verify-v4-plane-isolation.mjs', '--red-self-test'],
      '[v4_parity_gate_plane_isolation_red] OK'],
  ]) {
    const receipt = spawnSync(process.execPath, args, { cwd: fixtureV4Root, encoding: 'utf8' });
    checks.push({
      name: `plane gate ${args.at(-1)}`,
      pass: receipt.status === 0 && receipt.stdout.includes(marker) && receipt.stderr === '',
    });
  }
  for (const args of [
    ['scripts/architecture/verify-v4-feature-layer-batches.mjs', '--unknown'],
    ['scripts/architecture/verify-v4-feature-layer-batches.mjs', '--self-test', '--red-self-test'],
  ]) {
    const receipt = spawnSync(process.execPath, args, { cwd: fixtureV4Root, encoding: 'utf8' });
    checks.push({
      name: `exact CLI mode ${args.slice(1).join(' ')}`,
      pass: receipt.status === 2 && receipt.stderr.includes('MODE_INVALID'),
    });
  }
  for (const args of [
    ['scripts/architecture/verify-v4-plane-isolation.mjs', 'definition'],
    ['scripts/architecture/verify-v4-plane-isolation.mjs', '--unknown'],
    ['scripts/architecture/verify-v4-plane-isolation.mjs', '--red-self-test', 'extra'],
  ]) {
    const receipt = spawnSync(process.execPath, args, { cwd: fixtureV4Root, encoding: 'utf8' });
    checks.push({
      name: `exact plane CLI mode ${args.slice(1).join(' ')}`,
      pass: receipt.status === 2 && receipt.stderr.includes('MODE_INVALID'),
    });
  }
  for (const check of checks) {
    if (!check.pass) failures.push(failure('BOUNDARY_SELF_TEST', check.name));
  }
  return result(checks.length - failures.length, checks.length, failures);
}

export function runFeatureLayerBatchRedFixtures({
  canonicalInput,
  productionContext,
  validate,
}) {
  const cases = [
    {
      name: 'unknown root field',
      expected: ['MANIFEST_SCHEMA'],
      mutate(input) { input.manifest.unknown = true; },
      options: { mode: 'definition', allowPendingGuard: true },
    },
    {
      name: 'canonical plan bytes drift',
      expected: ['CANONICAL_CONTRACT'],
      mutate(input) { input.planSource += '\nmutated\n'; },
      options: { mode: 'definition', allowPendingGuard: true },
    },
    {
      name: 'pending task claims candidate',
      expected: ['PENDING_OWNER_PRETENDS_BOUND', 'PENDING_TASK_CLAIMS_CANDIDATE'],
      mutate(input) {
        const batch = resetPendingBatch(input, 'A');
        batch.tasks.find((task) => task.task_id === 'V4-PARITY-001').candidate_record = 'records/fake.json';
      },
      options: { mode: 'definition', allowPendingGuard: true },
    },
    {
      name: 'review starts before wiring',
      expected: ['EARLY_OR_INVALID_REVIEW'],
      mutate(input) {
        resetPendingGuard(input);
        input.manifest.integration.wiring_started = false;
        input.manifest.integration.wiring_edges = [];
        input.manifest.review.status = 'pending';
      },
      options: { mode: 'definition', allowPendingGuard: true },
    },
    {
      name: 'unbound guard reaches production definition',
      expected: ['INTEGRATION_GUARD_UNBOUND'],
      mutate(input) { resetPendingGuard(input); },
      options: { mode: 'definition' },
    },
    {
      name: 'unknown production validator mode',
      expected: ['MODE_INVALID'],
      mutate() {},
      options: { mode: 'target' },
    },
    {
      name: 'build preflight removed',
      expected: ['BUILD_PREFLIGHT_BINDING'],
      mutate(input) {
        input.buildSource = input.buildSource.replace(
          "run('node scripts/architecture/verify-v4-feature-layer-batches.mjs --build-guard');\n",
          '',
        );
      },
      options: { mode: 'definition', allowPendingGuard: true },
    },
    {
      name: 'build side-effect import precedes preflight',
      expected: ['BUILD_PREFLIGHT_BINDING'],
      mutate(input) {
        input.buildSource = input.buildSource.replace(
          "import { run } from './_common.mjs';\n",
          "import { run } from './_common.mjs';\nimport './unsafe-side-effect.mjs';\n",
        );
      },
      options: { mode: 'definition', allowPendingGuard: true },
    },
    {
      name: 'verify preflight removed',
      expected: ['VERIFY_PREFLIGHT_BINDING'],
      mutate(input) {
        input.verifySource = input.verifySource.replace(
          "run('node scripts/architecture/verify-v4-feature-layer-batches.mjs --build-guard');\n",
          '',
        );
      },
      options: { mode: 'definition', allowPendingGuard: true },
    },
    {
      name: 'verify side effect precedes preflight',
      expected: ['VERIFY_PREFLIGHT_BINDING'],
      mutate(input) {
        input.verifySource = input.verifySource.replace(
          "run('node scripts/architecture/verify-v4-feature-layer-batches.mjs --build-guard');\n",
          "fs.writeFileSync('unsafe', 'unsafe');\n"
            + "run('node scripts/architecture/verify-v4-feature-layer-batches.mjs --build-guard');\n",
        );
      },
      options: { mode: 'definition', allowPendingGuard: true },
    },
    {
      name: 'verify ci preflight removed',
      expected: ['VERIFY_CI_PREFLIGHT_BINDING'],
      mutate(input) {
        input.verifyCiSource = input.verifyCiSource.replace(
          "run('node scripts/architecture/verify-v4-feature-layer-batches.mjs --build-guard');\n",
          '',
        );
      },
      options: { mode: 'definition', allowPendingGuard: true },
    },
    {
      name: 'install preflight removed',
      expected: ['INSTALL_PREFLIGHT_BINDING'],
      mutate(input) { input.installSource = input.installSource.replace("  '--admission',", "  '--bypass',"); },
      options: { mode: 'definition', allowPendingGuard: true },
    },
    {
      name: 'install side effect precedes preflight',
      expected: ['INSTALL_PREFLIGHT_BINDING'],
      mutate(input) {
        input.installSource = input.installSource.replace(
          'const admission = spawnSync(',
          "fs.existsSync(source);\nconst admission = spawnSync(",
        );
      },
      options: { mode: 'definition', allowPendingGuard: true },
    },
    {
      name: 'runtime manifest preflight removed',
      expected: ['MANIFEST_COMPILE_PREFLIGHT_BINDING'],
      mutate(input) {
        input.compileManifestSource = input.compileManifestSource.replace("  '--admission',", "  '--bypass',");
      },
      options: { mode: 'definition', allowPendingGuard: true },
    },
    {
      name: 'manifest compiler side effect precedes preflight',
      expected: ['MANIFEST_COMPILE_PREFLIGHT_BINDING'],
      mutate(input) {
        input.compileManifestSource = input.compileManifestSource.replace(
          'const admission = spawnSync(',
          "fs.readFileSync(source, 'utf8');\nconst admission = spawnSync(",
        );
      },
      options: { mode: 'definition', allowPendingGuard: true },
    },
    {
      name: 'package build bypasses guarded entrypoint',
      expected: ['PACKAGE_ENTRYPOINT_BINDING', 'PACKAGE_SCRIPT_FULL_BINDING'],
      mutate(input) { input.packageJson.scripts.build = 'cargo build'; },
      options: { mode: 'definition', allowPendingGuard: true },
    },
    {
      name: 'unrelated package gate is deleted',
      expected: ['PACKAGE_SCRIPT_FULL_BINDING'],
      mutate(input) { delete input.packageJson.scripts['verify:v4-active-link']; },
      options: { mode: 'definition', allowPendingGuard: true },
    },
    {
      name: 'gate input closure is weakened',
      expected: ['CANDIDATE_GATE_INPUT_CONTRACT_DRIFT', 'GATE_INPUT_CONTRACT_BINDING'],
      mutate(input) { input.gateInputContract.input_sets.layer.pop(); },
      options: { mode: 'definition', allowPendingGuard: true },
    },
    {
      name: 'registered gate redirects its input set',
      expected: ['GATE_REGISTRY_BINDING'],
      mutate(input) {
        input.verificationMap.gates
          .find((gate) => gate.gate_id === 'v4_feature_layer_batches_self_test').input_set_id = 'plane';
      },
      options: { mode: 'definition', allowPendingGuard: true },
    },
    {
      name: 'wiring opens while source batches are pending',
      expected: ['EARLY_WIRING'],
      mutate(input) {
        resetPendingGuard(input);
        resetPendingBatch(input, 'A');
        input.manifest.integration.wiring_started = true;
        input.manifest.integration.wiring_edges = ['synthetic:early'];
      },
      options: { mode: 'definition', allowPendingGuard: true },
    },
    {
      name: 'plane mutation suite unregistered',
      expected: ['GATE_MATRIX_BINDING', 'GATE_MATRIX_FULL_BINDING'],
      mutate(input) {
        input.redSuites = input.redSuites.filter(([file]) => file !== 'verify-v4-plane-isolation.mjs');
      },
      options: { mode: 'definition', allowPendingGuard: true },
    },
    {
      name: 'unrelated architecture gate is deleted',
      expected: ['GATE_MATRIX_FULL_BINDING'],
      mutate(input) {
        input.architectureGates = input.architectureGates
          .filter((file) => file !== 'verify-v4-active-link.mjs');
      },
      options: { mode: 'definition', allowPendingGuard: true },
    },
  ];
  const failures = [];
  let passed = 0;
  for (const testCase of cases) {
    const input = clone(canonicalInput);
    testCase.mutate(input);
    const observed = validate(input, productionContext, testCase.options);
    if (sameCodes(observed, testCase.expected)) {
      passed += 1;
    } else {
      failures.push(failure('RED_FIXTURE_CODE_MISMATCH',
        `${testCase.name}: ${codes(observed).join(',') || 'PASS'} != ${testCase.expected.join(',')}`));
    }
  }
  return result(passed, cases.length, failures);
}
