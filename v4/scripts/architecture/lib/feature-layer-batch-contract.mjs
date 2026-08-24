export const MANIFEST_ID = 'V4-LAYER-GATE-001';
export const MANIFEST_SCHEMA_VERSION = 2;
export const OWNER_FEATURE_ID = 'v4.governance.feature_layer_batch_admission';
export const OWNER_MODULE_ID = 'routecodex-v4-governance';
export const RESOURCE_ID = 'feature_layer_batch_manifest';
export const FUNCTION_ID = OWNER_FEATURE_ID;
export const BASELINE_FEATURE_ID = 'V4-RUNTIME-007';
export const BASELINE_ANCHOR = 'ef3899f';
export const RUNTIME_MODULE_ID = 'routecodex-v4-runtime';
export const PREREQUISITE_FEATURE_ID = 'V4-RUNTIME-002';
export const TASK_READY_STATUS = 'source_green';
export const CONDITIONAL_NOT_NEEDED = 'not_needed_by_evidence';
export const REQUIRED_BATCH_IDS = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];
export const CONDITIONAL_BATCH_IDS = ['H'];
export const REQUIRED_EVIDENCE_ROLES = ['positive', 'red_gate', 'boundary_audit', 'plane_isolation'];
export const GATE_FILE = 'verify-v4-feature-layer-batches.mjs';
export const GATE_COMMAND = `node scripts/architecture/${GATE_FILE}`;
export const BUILD_GUARD_COMMAND = `${GATE_COMMAND} --build-guard`;
export const ADMISSION_COMMAND = `${GATE_COMMAND} --admission`;
export const SELF_TEST_COMMAND = `${GATE_COMMAND} --self-test`;
export const BOUNDARY_COMMAND = `${GATE_COMMAND} --boundary-self-test`;
export const RED_COMMAND = `${GATE_COMMAND} --red-self-test`;
export const PLAN_PATH = 'v4/docs/goals/v4-feature-completion-plan.md';
export const PLAN_HASH = 'sha256:38bd0cc551ca343dfb0c7091eca9f89a386cf54baf7251466333d17d571b7e4a';
export const PLAN_ANCHORS = [
  '# 28. `RUNTIME-007` 后的分层批量开发与接线计划',
  '同层独立任务全部达到 `source_green` 后才允许 production wiring',
  'A–G 全部 `source_green`，且 conditional H 为 `source_green` 或 `not_needed_by_evidence`',
  'review 状态不参与 `source_green` 判定',
];

export const GATE_IDS = {
  definition: 'v4_feature_layer_batches',
  buildGuard: 'v4_feature_layer_batch_build_guard',
  selfTest: 'v4_feature_layer_batches_self_test',
  admission: 'v4_feature_layer_batch_admission',
  boundary: 'v4_feature_layer_batches_boundary',
  red: 'v4_feature_layer_batches_red',
  plane: 'v4_parity_gate_plane_isolation',
  planeRed: 'v4_parity_gate_plane_isolation_red',
};

export const EXPECTED_TASKS = new Map([
  ['A', ['V4-PARITY-001', 'V4-PARITY-002', 'V4-PARITY-003', 'V4-PARITY-HARNESS-001']],
  ['B', ['V4-RUNTIME-003']],
  ['C', ['V4-RUNTIME-004']],
  ['D', ['V4-PLUGIN-001', 'V4-PLUGIN-002', 'V4-PLUGIN-003', 'V4-PLUGIN-004', 'V4-PLUGIN-005']],
  ['E', ['V4-PLUGIN-006', 'V4-PLUGIN-007', 'V4-PLUGIN-008']],
  ['F', ['V4-RUNTIME-005', 'V4-RUNTIME-006']],
  ['G', ['V4-GATE-001', 'V4-LAYER-GATE-001']],
  ['H', ['V4-RUNTIME-002']],
]);

export const ROLE_CONTRACTS = {
  positive: { phase: 'positive_intervention', kind: 'positive_test' },
  red_gate: { phase: 'negative_intervention', kind: 'red_test' },
  boundary_audit: { phase: 'development_whitebox', kind: 'gate', surface: 'development_whitebox' },
  plane_isolation: { phase: 'development_whitebox', kind: 'gate', surface: 'development_whitebox' },
  baseline_replay: { phase: 'baseline_reproduction', kind: 'sample_replay' },
  closure_audit: { phase: 'development_whitebox', kind: 'gate', surface: 'development_whitebox' },
  not_needed_decision: { phase: 'development_whitebox', kind: 'gate', surface: 'development_whitebox' },
};

export const REQUIRED_RESOURCE_RELATIONS = ['merge_queue_state', 'integration_candidate'];
export const FORBIDDEN_RESOURCE_RELATIONS = [
  'normal_payload',
  'review_as_source_completion',
  'cross_lane_source_dependency',
  'early_production_wiring',
];
export const GUARDED_WIRING_SURFACES = [
  'Cargo.toml',
  'scripts/build.mjs',
  'scripts/verify.mjs',
  'scripts/verify-ci.mjs',
  'scripts/install-rccv4.mjs',
  'scripts/compile-real-runtime-manifest.mjs',
  'contracts/real-runtime-admission.manifest.json',
  'contracts/active-link/frozen-consumer-registry.json',
  'docs/architecture/maps/mainline-call-map.json',
  'crates/routecodex-v4-runtime-bin/**',
];
export const FORBIDDEN_CANDIDATE_PREFIXES = [
  'v4/active/',
  'v4/generated/',
  'v4/protected/',
  'v4/target/',
  'v4/node_modules/',
];
export const IMPLEMENTATION_EXTENSIONS = new Set(['.rs', '.mjs', '.js', '.cjs', '.ts', '.tsx']);
export const GRAPH_SOURCE_EXTENSIONS = new Set(['.rs', '.mjs', '.js', '.cjs', '.ts', '.tsx', '.toml']);

export function addFailure(failures, code, message) {
  failures.push({ code, message });
}

export function sortedUnique(values) {
  return [...new Set(values)].sort();
}

export function sameMembers(actual, expected) {
  return JSON.stringify(sortedUnique(actual)) === JSON.stringify(sortedUnique(expected));
}

export function sameOrdered(actual, expected) {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

export function isMachinePath(value) {
  return typeof value === 'string'
    && value.length > 0
    && !value.startsWith('/')
    && !value.split('/').includes('..')
    && !/[\\\s{}?\[\]]/.test(value);
}

export function isOwnedPattern(value) {
  if (!isMachinePath(value)) return false;
  const starCount = [...value].filter((character) => character === '*').length;
  return starCount === 0 || (starCount === 2 && value.endsWith('/**'));
}

export function pathMatchesPattern(candidate, pattern) {
  if (!isMachinePath(candidate) || !isOwnedPattern(pattern)) return false;
  if (!pattern.endsWith('/**')) return candidate === pattern;
  const root = pattern.slice(0, -3);
  return candidate === root || candidate.startsWith(`${root}/`);
}

export function patternsOverlap(left, right) {
  if (!isOwnedPattern(left) || !isOwnedPattern(right)) return false;
  const leftRoot = left.endsWith('/**') ? left.slice(0, -3) : left;
  const rightRoot = right.endsWith('/**') ? right.slice(0, -3) : right;
  if (!left.endsWith('/**') && !right.endsWith('/**')) return left === right;
  if (left.endsWith('/**') && right.endsWith('/**')) {
    return leftRoot === rightRoot
      || leftRoot.startsWith(`${rightRoot}/`)
      || rightRoot.startsWith(`${leftRoot}/`);
  }
  const exact = left.endsWith('/**') ? right : left;
  const root = left.endsWith('/**') ? leftRoot : rightRoot;
  return exact === root || exact.startsWith(`${root}/`);
}

export function patternContains(ownerPattern, claimedPattern) {
  if (!isOwnedPattern(ownerPattern) || !isOwnedPattern(claimedPattern)) return false;
  if (!ownerPattern.endsWith('/**')) return ownerPattern === claimedPattern;
  const ownerRoot = ownerPattern.slice(0, -3);
  const claimedRoot = claimedPattern.endsWith('/**')
    ? claimedPattern.slice(0, -3)
    : claimedPattern;
  return claimedRoot === ownerRoot || claimedRoot.startsWith(`${ownerRoot}/`);
}

export function requireExactKeys(value, expected, failures, code, context) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    addFailure(failures, code, `${context} must be an object`);
    return false;
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (!sameOrdered(actual, wanted)) {
    addFailure(failures, code, `${context} keys ${actual.join(',')} != ${wanted.join(',')}`);
    return false;
  }
  return true;
}

export function duplicateIds(items, key) {
  const counts = new Map();
  for (const item of items ?? []) counts.set(item?.[key], (counts.get(item?.[key]) ?? 0) + 1);
  return [...counts.entries()].filter(([, count]) => count > 1).map(([id]) => id);
}

export function expectedBatchIds() {
  return [...REQUIRED_BATCH_IDS, ...CONDITIONAL_BATCH_IDS];
}
