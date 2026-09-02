import {
  ADMISSION_COMMAND,
  BOUNDARY_COMMAND,
  BUILD_GUARD_COMMAND,
  FORBIDDEN_RESOURCE_RELATIONS,
  FUNCTION_ID,
  GATE_COMMAND,
  GATE_FILE,
  GATE_IDS,
  OWNER_FEATURE_ID,
  OWNER_MODULE_ID,
  RED_COMMAND,
  REQUIRED_RESOURCE_RELATIONS,
  RESOURCE_ID,
  SELF_TEST_COMMAND,
  addFailure,
  duplicateIds,
  sameMembers,
} from './feature-layer-batch-contract.mjs';
import { canonicalJson, sha256 } from './feature-layer-batch-git.mjs';

const NODE_PRODUCER = (identity) => ({ adapter: 'node', identity });
const PREFLIGHT_MARKER = '// V4-LAYER-PREFLIGHT-END\n';
export const GATE_INPUT_CONTRACT_PATH = 'contracts/feature-layer-gate-inputs.contract.json';
export const GATE_INPUT_SETS = {
  layer: [
    'docs/architecture/maps/function-map.json',
    'docs/architecture/maps/mainline-call-map.json',
    '.appsdk/maps/module-registry.json',
    'docs/architecture/maps/resource-map.json',
    'docs/architecture/maps/verification-map.json',
    'Cargo.toml',
    'contracts/active-link/frozen-consumer-registry.json',
    'contracts/feature-completion-layer-batches.manifest.json',
    GATE_INPUT_CONTRACT_PATH,
    'docs/goals/v4-feature-completion-plan.md',
    'package-lock.json',
    'package.json',
    'scripts/_gate-matrix.mjs',
    'scripts/architecture/lib/feature-layer-batch-admission.mjs',
    'scripts/architecture/lib/feature-layer-batch-candidate.mjs',
    'scripts/architecture/lib/feature-layer-batch-cargo.mjs',
    'scripts/architecture/lib/feature-layer-batch-contract.mjs',
    'scripts/architecture/lib/feature-layer-batch-definition.mjs',
    'scripts/architecture/lib/feature-layer-batch-evidence.mjs',
    'scripts/architecture/lib/feature-layer-batch-git.mjs',
    'scripts/architecture/lib/feature-layer-batch-graph.mjs',
    'scripts/architecture/lib/feature-layer-batch-integration.mjs',
    'scripts/architecture/lib/feature-layer-batch-registry.mjs',
    'scripts/architecture/lib/feature-layer-batch-source.mjs',
    'scripts/architecture/verify-v4-feature-layer-batches.mjs',
    'scripts/architecture/verify-v4-plane-isolation.mjs',
    'scripts/build.mjs',
    'scripts/compile-real-runtime-manifest.mjs',
    'scripts/install-rccv4.mjs',
    'scripts/tests/v4-feature-layer-batches-red-fixtures.mjs',
    'scripts/verify-ci.mjs',
    'scripts/verify.mjs',
  ],
  plane: [
    'contracts/data-control-boundary.contract.json',
    GATE_INPUT_CONTRACT_PATH,
    'crates/routecodex-v4-control/src/lib.rs',
    'crates/routecodex-v4-control/tests/l2_control.rs',
    'crates/routecodex-v4-standard-plugins/src/lib.rs',
    'crates/routecodex-v4-standard-plugins/src/response_inbound.rs',
    'crates/routecodex-v4-standard-plugins/src/response_outbound.rs',
    'docs/architecture/v4-resource-operation-map.yml',
    'package-lock.json',
    'package.json',
    'scripts/architecture/verify-v4-plane-isolation.mjs',
  ],
};
const GATE_MATRIX_HASHES = {
  architecture: 'sha256:a6b16df227a079e439ef85e573be43fc9996cf2ec52101cfd873abd15255b6cb',
  red: 'sha256:ea2a2cce946eb9eee7343bed6cecddd4567f17e0eafe39c464f0d78a76203b5d',
  packageScripts: 'sha256:36b7f79182f3f55d2ce5efc885880ffe3daa9f25334a2117d4e305d814a96762',
};
const PREFLIGHT_PREFIXES = new Map([
  ['build', ['buildSource', 'sha256:fb028d2b084eeb78e4afc9d45c954af15536ecc47379660a4a6dc5ccd42461b5', 'BUILD_PREFLIGHT_BINDING']],
  ['verify', ['verifySource', 'sha256:31ab72a58d8f945368e561a2ca092afe974a7e2dde5556f3324ce040400edbdf', 'VERIFY_PREFLIGHT_BINDING']],
  ['verify:ci', ['verifyCiSource', 'sha256:9e0a411e9da19f2cc39f81c54c22b695118768cdc80887dce879cf59bbff24b7', 'VERIFY_CI_PREFLIGHT_BINDING']],
  ['install', ['installSource', 'sha256:e9f37bb003682cfcd5f535b759d8cb0a727b654929cebe6e2107c1ec64de3029', 'INSTALL_PREFLIGHT_BINDING']],
  ['manifest compile', ['compileManifestSource', 'sha256:ac1a1c53ea6748f21046bf4508cd81928a374150d580ece41a494856802ff973', 'MANIFEST_COMPILE_PREFLIGHT_BINDING']],
]);

function validatePreflightPrefixes(input, failures) {
  for (const [name, [sourceKey, expectedHash, code]] of PREFLIGHT_PREFIXES) {
    const source = input[sourceKey];
    const markerIndex = typeof source === 'string' ? source.indexOf(PREFLIGHT_MARKER) : -1;
    if (markerIndex < 0
        || source.indexOf(PREFLIGHT_MARKER, markerIndex + 1) >= 0
        || sha256(source.slice(0, markerIndex + PREFLIGHT_MARKER.length)) !== expectedHash) {
      addFailure(failures, code,
        name + ' must execute the canonical layer preflight before any product action');
    }
  }
}

const gateInputBinding = (inputSetId) => ({
  owner_module_id: OWNER_MODULE_ID,
  feature_ids: ['V4-LAYER-GATE-001'],
  input_contract_path: GATE_INPUT_CONTRACT_PATH,
  input_set_id: inputSetId,
});

export const EXPECTED_GATES = new Map([
  [GATE_IDS.definition, {
    ...gateInputBinding('layer'),
    command: GATE_COMMAND,
    argv: ['node', `scripts/architecture/${GATE_FILE}`],
    producer: NODE_PRODUCER(GATE_IDS.definition),
    evidence_role: null,
    required_for: ['routecodex-v4-governance:architecture_stable'],
  }],
  [GATE_IDS.buildGuard, {
    ...gateInputBinding('layer'),
    command: BUILD_GUARD_COMMAND,
    argv: ['node', `scripts/architecture/${GATE_FILE}`, '--build-guard'],
    producer: NODE_PRODUCER(GATE_IDS.buildGuard),
    evidence_role: null,
    required_for: ['independent_source_build', 'integration_build'],
  }],
  [GATE_IDS.selfTest, {
    ...gateInputBinding('layer'),
    command: SELF_TEST_COMMAND,
    argv: ['node', `scripts/architecture/${GATE_FILE}`, '--self-test'],
    producer: NODE_PRODUCER(GATE_IDS.selfTest),
    evidence_role: 'positive',
    required_for: ['source_green'],
  }],
  [GATE_IDS.admission, {
    ...gateInputBinding('layer'),
    command: ADMISSION_COMMAND,
    argv: ['node', `scripts/architecture/${GATE_FILE}`, '--admission'],
    producer: NODE_PRODUCER(GATE_IDS.admission),
    evidence_role: null,
    required_for: ['integration_build', 'product_wiring'],
  }],
  [GATE_IDS.boundary, {
    ...gateInputBinding('layer'),
    command: BOUNDARY_COMMAND,
    argv: ['node', `scripts/architecture/${GATE_FILE}`, '--boundary-self-test'],
    producer: NODE_PRODUCER(GATE_IDS.boundary),
    evidence_role: 'boundary_audit',
    required_for: ['source_green'],
  }],
  [GATE_IDS.red, {
    ...gateInputBinding('layer'),
    command: RED_COMMAND,
    argv: ['node', `scripts/architecture/${GATE_FILE}`, '--red-self-test'],
    producer: NODE_PRODUCER(GATE_IDS.red),
    evidence_role: 'red_gate',
    required_for: ['source_green', 'routecodex-v4-governance:architecture_stable'],
  }],
  [GATE_IDS.plane, {
    ...gateInputBinding('plane'),
    command: 'node scripts/architecture/verify-v4-plane-isolation.mjs',
    argv: ['node', 'scripts/architecture/verify-v4-plane-isolation.mjs'],
    producer: NODE_PRODUCER(GATE_IDS.plane),
    evidence_role: 'plane_isolation',
    required_for: ['source_green', 'routecodex-v4-governance:architecture_stable'],
  }],
  [GATE_IDS.planeRed, {
    ...gateInputBinding('plane'),
    command: 'node scripts/architecture/verify-v4-plane-isolation.mjs --red-self-test',
    argv: ['node', 'scripts/architecture/verify-v4-plane-isolation.mjs', '--red-self-test'],
    producer: NODE_PRODUCER(GATE_IDS.planeRed),
    evidence_role: null,
    required_for: ['routecodex-v4-governance:architecture_stable'],
  }],
]);

function uniqueMap(items, key, failures, code) {
  const duplicates = duplicateIds(items, key);
  if (duplicates.length > 0) addFailure(failures, code, `duplicate ${key}: ${duplicates.join(',')}`);
  return new Map((items ?? []).map((item) => [item[key], item]));
}

export function validateRegistryBindings(input, failures) {
  const expectedGateBindings = Object.fromEntries([...EXPECTED_GATES]
    .map(([gateId, gate]) => [gateId, gate.input_set_id]));
  if (!input.gateInputContract
      || input.gateInputContract.schema_version !== 1
      || input.gateInputContract.contract_id !== 'v4-feature-layer-gate-input-closure'
      || input.gateInputContract.status !== 'active'
      || input.gateInputContract.owner_module_id !== OWNER_MODULE_ID
      || canonicalJson(input.gateInputContract.input_sets) !== canonicalJson(GATE_INPUT_SETS)
      || canonicalJson(input.gateInputContract.gate_bindings) !== canonicalJson(expectedGateBindings)) {
    addFailure(failures, 'GATE_INPUT_CONTRACT_BINDING',
      'gate input sets/bindings must match the canonical executable closure');
  }
  const modules = uniqueMap(input.moduleRegistry.modules, 'module_id', failures, 'DUPLICATE_MODULE_ID');
  const functions = uniqueMap(input.functionMap.functions, 'function_id', failures, 'DUPLICATE_FUNCTION_ID');
  const resources = uniqueMap(input.resourceMap.resources, 'resource_id', failures, 'DUPLICATE_RESOURCE_ID');
  const gates = uniqueMap(input.verificationMap.gates, 'gate_id', failures, 'DUPLICATE_GATE_ID');
  const governance = modules.get(OWNER_MODULE_ID);
  if (!governance
      || governance.status !== 'active'
      || governance.owner !== OWNER_MODULE_ID
      || !['.appsdk/**', 'contracts/**', 'docs/**', 'scripts/**', 'package.json']
        .every((ownedPath) => (governance.owned_paths ?? []).includes(ownedPath))
      || !['active/lib/**', 'protected/**', 'generated/**']
        .every((forbiddenPath) => (governance.forbidden_paths ?? []).includes(forbiddenPath))
      || ![...EXPECTED_GATES.keys()].every((gateId) => (governance.verification_gates ?? []).includes(gateId))) {
    addFailure(failures, 'OWNER_MODULE_BINDING', `${OWNER_MODULE_ID} owner/path/gate binding drifted`);
  }
  const resource = resources.get(RESOURCE_ID);
  const mergeQueueState = resources.get('merge_queue_state');
  const integrationCandidate = resources.get('integration_candidate');
  if (!resource
      || resource.status !== 'active'
      || resource.feature_id !== 'V4-LAYER-GATE-001'
      || resource.owner !== OWNER_MODULE_ID
      || resource.truth_store !== 'contracts/feature-completion-layer-batches.manifest.json'
      || !sameMembers(resource.allowed_operations ?? [], ['read', 'validate', 'write'])
      || !sameMembers(resource.relations?.must_reference ?? [], REQUIRED_RESOURCE_RELATIONS)
      || !sameMembers(resource.forbidden_relations ?? [], FORBIDDEN_RESOURCE_RELATIONS)) {
    addFailure(failures, 'RESOURCE_MAP_BINDING', `${RESOURCE_ID} machine relations/owner/status drifted`);
  }
  if (!mergeQueueState
      || mergeQueueState.owner !== 'appsdk::merge_queue'
      || mergeQueueState.truth_store !== '.appsdk/records/merge-queue-state.json'
      || !integrationCandidate
      || integrationCandidate.owner !== 'appsdk::merge_queue'
      || integrationCandidate.truth_store !== '.appsdk/records/integration-record-<integration_id>.json') {
    addFailure(failures, 'RESOURCE_RELATION_TARGET_INVALID',
      'merge_queue_state/integration_candidate relation targets are not canonical AppSDK resources');
  }
  const fn = functions.get(FUNCTION_ID);
  const requiredFunctionGates = [
    GATE_IDS.definition, GATE_IDS.selfTest, GATE_IDS.boundary, GATE_IDS.red,
    GATE_IDS.plane, GATE_IDS.planeRed,
  ];
  if (!fn
      || fn.status !== 'active'
      || fn.feature_id !== 'V4-LAYER-GATE-001'
      || fn.owner !== OWNER_MODULE_ID
      || !(fn.entry_symbols ?? []).includes('validateFeatureLayerBatchAdmission')
      || !(fn.resource_ids ?? []).includes(RESOURCE_ID)
      || !Array.isArray(fn.source_paths) || fn.source_paths.length === 0
      || !sameMembers(fn.required_gates ?? [], requiredFunctionGates)) {
    addFailure(failures, 'FUNCTION_MAP_BINDING', `${FUNCTION_ID} source/resource/gate binding drifted`);
  }
  for (const [gateId, expected] of EXPECTED_GATES) {
    const gate = gates.get(gateId);
    if (!gate
        || gate.status !== 'active'
        || gate.command !== expected.command
        || JSON.stringify(gate.argv) !== JSON.stringify(expected.argv)
        || JSON.stringify(gate.producer) !== JSON.stringify(expected.producer)
        || gate.evidence_role !== expected.evidence_role
        || gate.owner_module_id !== expected.owner_module_id
        || !sameMembers(gate.feature_ids ?? [], expected.feature_ids)
        || gate.input_contract_path !== expected.input_contract_path
        || gate.input_set_id !== expected.input_set_id
        || !sameMembers(gate.required_for ?? [], expected.required_for)) {
      addFailure(failures, 'GATE_REGISTRY_BINDING', `${gateId} executable/producer/role binding drifted`);
    }
  }
  if (!input.architectureGates.includes(GATE_FILE)
      || !input.redSuites.some(([file, flag]) => file === GATE_FILE && flag === '--red-self-test')
      || !input.redSuites.some(([file, flag]) => file === 'verify-v4-plane-isolation.mjs' && flag === '--red-self-test')) {
    addFailure(failures, 'GATE_MATRIX_BINDING', 'definition and both mutation suites must be in the canonical matrices');
  }
  const architectureProjection = [...input.architectureGates].sort();
  const redProjection = input.redSuites.map((entry) => [...entry])
    .sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
  if (sha256(canonicalJson(architectureProjection)) !== GATE_MATRIX_HASHES.architecture
      || sha256(canonicalJson(redProjection)) !== GATE_MATRIX_HASHES.red) {
    addFailure(failures, 'GATE_MATRIX_FULL_BINDING',
      'the complete architecture/red gate matrix must match its protected semantic projection');
  }
  const scripts = input.packageJson.scripts ?? {};
  const expectedScripts = {
    build: 'node scripts/build.mjs',
    'install:global': 'node scripts/install-rccv4.mjs',
    verify: 'node scripts/verify.mjs',
    'verify:ci': 'node scripts/verify-ci.mjs',
    'verify:v4-feature-layer-batches': GATE_COMMAND,
    'verify:v4-feature-layer-batches-self-test': SELF_TEST_COMMAND,
    'verify:v4-feature-layer-batches-admission': ADMISSION_COMMAND,
    'verify:v4-feature-layer-batches-boundary': BOUNDARY_COMMAND,
    'verify:v4-feature-layer-batches-red': RED_COMMAND,
  };
  if (Object.entries(expectedScripts).slice(0, 4)
    .some(([name, command]) => scripts[name] !== command)) {
    addFailure(failures, 'PACKAGE_ENTRYPOINT_BINDING',
      'build/verify/verify:ci/install:global must dispatch to canonical guarded entrypoints');
  }
  if (Object.entries(expectedScripts).slice(4)
    .some(([name, command]) => scripts[name] !== command)) {
    addFailure(failures, 'PACKAGE_SCRIPT_BINDING', 'V4 package layer-gate scripts drifted');
  }
  if (sha256(canonicalJson(scripts)) !== GATE_MATRIX_HASHES.packageScripts) {
    addFailure(failures, 'PACKAGE_SCRIPT_FULL_BINDING',
      'the complete V4 package script surface must match its protected semantic projection');
  }
  const buildLines = input.buildSource.split(/\r?\n/);
  const importIndex = buildLines.findIndex((line) => line.trim() === "import { run } from './_common.mjs';");
  const firstExecutionIndex = buildLines.findIndex((line, index) =>
    index > importIndex && line.trim().length > 0);
  const cargoIndex = buildLines.findIndex((line) => line.trim().startsWith("run('cargo "));
  if (importIndex < 0
      || firstExecutionIndex < 0
      || buildLines[firstExecutionIndex].trim() !== `run('${BUILD_GUARD_COMMAND}');`
      || cargoIndex < 0
      || firstExecutionIndex > cargoIndex) {
    addFailure(failures, 'BUILD_PREFLIGHT_BINDING', 'build guard must run before the first Cargo/link action');
  }
  const verifyGuard = input.verifySource.indexOf(`run('${BUILD_GUARD_COMMAND}');`);
  const verifyFirstRun = input.verifySource.indexOf('run(');
  const verifyFirstMutation = input.verifySource.indexOf('fs.rmSync(');
  if (verifyGuard < 0 || verifyGuard !== verifyFirstRun
      || verifyFirstMutation < 0 || verifyGuard > verifyFirstMutation) {
    addFailure(failures, 'VERIFY_PREFLIGHT_BINDING',
      'verify build guard must be the first execution before build or fixture mutation');
  }
  const installAdmission = input.installSource.indexOf("'--admission'");
  const installFirstEffect = input.installSource.indexOf('fs.existsSync(source)');
  if (installAdmission < 0 || installFirstEffect < 0 || installAdmission > installFirstEffect) {
    addFailure(failures, 'INSTALL_PREFLIGHT_BINDING',
      'install admission must run before reading or mutating the install surface');
  }
  const compileAdmission = input.compileManifestSource.indexOf("'--admission'");
  const compileFirstRead = input.compileManifestSource.indexOf('fs.readFileSync(source');
  if (compileAdmission < 0 || compileFirstRead < 0 || compileAdmission > compileFirstRead) {
    addFailure(failures, 'MANIFEST_COMPILE_PREFLIGHT_BINDING',
      'runtime manifest admission must run before reading or writing product artifacts');
  }
  validatePreflightPrefixes(input, failures);
  for (const edge of input.mainlineMap.edges ?? []) {
    if (JSON.stringify(edge).includes(OWNER_FEATURE_ID)) {
      addFailure(failures, 'SYNTHETIC_MAINLINE_EDGE', 'source gate must not fabricate an AppSDK mainline edge');
    }
  }
  return { modules, functions, resources, gates };
}
