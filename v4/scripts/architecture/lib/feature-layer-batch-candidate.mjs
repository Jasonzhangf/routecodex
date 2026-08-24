import path from 'node:path';
import {
  FORBIDDEN_CANDIDATE_PREFIXES,
  IMPLEMENTATION_EXTENSIONS,
  addFailure,
  isMachinePath,
  pathMatchesPattern,
  sameOrdered,
  sortedUnique,
} from './feature-layer-batch-contract.mjs';
import { FULL_COMMIT_PATTERN, SHA256_PATTERN } from './feature-layer-batch-git.mjs';

const CANDIDATE_KEYS = [
  'fix_candidate_id',
  'issue_id',
  'module_id',
  'worktree_id',
  'base_commit',
  'head_commit',
  'tree_hash',
  'diff_hash',
  'design_id',
  'owner',
  'scope_hash',
  'changed_paths',
  'verification_evidence_ids',
  'created_at',
  'batch_id',
  'task_ids',
];

// Registry projections are deliberately shared governance surfaces.  They
// are validated for exact candidate/current projection stability elsewhere;
// they are not implementation blobs owned by the lane's runtime module.
const SHARED_PROJECTION_PATHS = new Set([
  'v4/docs/architecture/maps/function-map.json',
  'v4/docs/architecture/maps/resource-map.json',
  'v4/docs/architecture/maps/verification-map.json',
  'v4/.appsdk/maps/module-registry.json',
]);

const GOVERNANCE_CLOSURE_PREFIXES = [
  'v4/Cargo.toml',
  'v4/Cargo.lock',
  'v4/crates/routecodex-v4-control/Cargo.toml',
  'v4/crates/routecodex-v4-error/Cargo.toml',
  'v4/contracts/',
  'v4/docs/evidence/feature-completion/',
  'v4/docs/architecture/',
  'v4/scripts/architecture/lib/feature-layer-batch-',
  'v4/crates/routecodex-v4-standard-plugins/src/lib.rs',
  'v4/crates/routecodex-v4-standard-plugins/src/response_inbound.rs',
  'v4/crates/routecodex-v4-standard-plugins/src/response_outbound.rs',
];

function isGovernanceClosurePath(relativePath) {
  return SHARED_PROJECTION_PATHS.has(relativePath)
    || GOVERNANCE_CLOSURE_PREFIXES.some((prefix) => relativePath.startsWith(prefix));
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function moduleOwnersForPath(moduleRegistry, relativePath) {
  const owners = (moduleRegistry.modules ?? []).filter((module) => module.status === 'active'
    && (module.owned_paths ?? []).some((pattern) => pathMatchesPattern(relativePath, pattern)));
  if (owners.length <= 1) return owners;
  const specificity = (module) => Math.max(...module.owned_paths
    .filter((pattern) => pathMatchesPattern(relativePath, pattern))
    .map((pattern) => pattern.replace(/\*\*/g, '').length));
  const max = Math.max(...owners.map(specificity));
  return owners.filter((module) => specificity(module) === max);
}

function escapedPattern(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sourceDefinesSymbol(sourcePath, source, symbol) {
  const name = escapedPattern(symbol.split('::').at(-1));
  const codeWithoutSingleQuotedStrings = source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/r(#+)?"[\s\S]*?"\1/g, ' ')
    .replace(/`(?:\\.|[^`\\])*`/g, ' ')
    .replace(/b?"(?:\\.|[^"\\])*"/g, ' ');
  const code = path.extname(sourcePath) === '.rs'
    ? codeWithoutSingleQuotedStrings
    : codeWithoutSingleQuotedStrings.replace(/b?'(?:\\.|[^'\\])*'/g, ' ');
  if (path.extname(sourcePath) === '.rs') {
    return new RegExp(`\\b(?:pub(?:\\([^)]*\\))?\\s+)?(?:async\\s+)?(?:fn|struct|enum|trait|type|const|static|mod)\\s+${name}\\b`)
      .test(code);
  }
  return new RegExp(`\\b(?:export\\s+)?(?:(?:async\\s+)?function|class|const|let|var)\\s+${name}\\b`)
    .test(code);
}

function functionBindings(task, functionMap, batch, failures) {
  const functions = [];
  for (const functionId of task.function_ids ?? []) {
    const matches = (functionMap.functions ?? []).filter((entry) => entry.function_id === functionId);
    if (matches.length !== 1) {
      addFailure(failures, 'TASK_FUNCTION_BINDING', `${task.task_id}: function ${functionId} must exist exactly once`);
      continue;
    }
    const fn = matches[0];
    if (fn.status !== 'active'
        || fn.feature_id !== task.task_id
        || !(batch.module_ids ?? []).includes(fn.owner)
        || !Array.isArray(fn.entry_symbols) || fn.entry_symbols.length === 0
        || !Array.isArray(fn.source_paths) || fn.source_paths.length === 0
        || !Array.isArray(fn.resource_ids) || fn.resource_ids.length === 0
        || !Array.isArray(fn.required_gates) || fn.required_gates.length === 0) {
      addFailure(failures, 'TASK_FUNCTION_BINDING', `${task.task_id}: function ${functionId} binding is incomplete or foreign`);
      continue;
    }
    functions.push(fn);
  }
  if (functions.length === 0) {
    addFailure(failures, 'TASK_FUNCTION_BINDING', `${task.task_id}: at least one active function binding is required`);
  }
  return functions;
}

function resourceBindings(task, resourceMap, batch, failures) {
  const resources = [];
  for (const resourceId of task.resource_ids ?? []) {
    const matches = (resourceMap.resources ?? []).filter((entry) => entry.resource_id === resourceId);
    if (matches.length !== 1) {
      addFailure(failures, 'TASK_RESOURCE_BINDING', `${task.task_id}: resource ${resourceId} must exist exactly once`);
      continue;
    }
    const resource = matches[0];
    const ownerMatchesModule = (batch.module_ids ?? []).some((moduleId) =>
      resource.owner === moduleId || resource.owner?.startsWith(`${moduleId}::`));
    if (resource.status !== 'active'
        || resource.feature_id !== task.task_id
        || !ownerMatchesModule
        || !isMachinePath(resource.truth_store)) {
      addFailure(failures, 'TASK_RESOURCE_BINDING', `${task.task_id}: resource ${resourceId} binding is incomplete or foreign`);
      continue;
    }
    resources.push(resource);
  }
  if (resources.length === 0) {
    addFailure(failures, 'TASK_RESOURCE_BINDING', `${task.task_id}: at least one active resource binding is required`);
  }
  return resources;
}

export function validateTaskRegistryProjection({
  task,
  batch,
  functionMap,
  resourceMap,
  gateMap,
  gateInputContract,
  truth,
  candidateCommit,
  failures,
}) {
  const functions = functionBindings(task, functionMap, batch, failures);
  const resources = resourceBindings(task, resourceMap, batch, failures);
  const derivedSourcePaths = sortedUnique(functions.flatMap((fn) => fn.source_paths ?? []));
  const derivedResourceIds = sortedUnique(functions.flatMap((fn) => fn.resource_ids ?? []));
  const derivedGates = sortedUnique(functions.flatMap((fn) => fn.required_gates ?? []));
  const gateInputPaths = new Set();
  if (!sameOrdered(sortedUnique(task.source_paths ?? []), derivedSourcePaths)) {
    addFailure(failures, 'TASK_SOURCE_PROJECTION_DRIFT', `${task.task_id}: source_paths must be derived from function map`);
  }
  if (!sameOrdered(sortedUnique(task.resource_ids ?? []), sortedUnique(derivedResourceIds))
      || !sameOrdered(sortedUnique(task.required_gate_ids ?? []), derivedGates)) {
    addFailure(failures, 'TASK_GATE_RESOURCE_PROJECTION_DRIFT', `${task.task_id}: gate/resource projections drifted`);
  }
  if (resources.length > 0
      && resources.some((resource) => !derivedResourceIds.includes(resource.resource_id))) {
    addFailure(failures, 'TASK_RESOURCE_BINDING', `${task.task_id}: function/resource bindings disagree`);
  }
  for (const gateId of derivedGates) {
    const gate = gateMap.get(gateId);
    if (!gate || gate.status !== 'active' || !Array.isArray(gate.argv) || gate.argv.length === 0) {
      addFailure(failures, 'TASK_GATE_BINDING', `${task.task_id}: gate ${gateId} is not active/executable`);
      continue;
    }
    const contractPaths = gateInputContract?.input_sets?.[gate.input_set_id];
    const inlinePaths = gate.input_paths;
    const contractBinding = isMachinePath(gate.input_contract_path)
      && gateInputContract?.schema_version === 1
      && gateInputContract?.status === 'active'
      && gateInputContract?.owner_module_id === gate.owner_module_id
      && gateInputContract?.gate_bindings?.[gateId] === gate.input_set_id
      && Array.isArray(contractPaths)
      && contractPaths.includes(gate.input_contract_path);
    const inlineBinding = Array.isArray(inlinePaths) && inlinePaths.length > 0
      && gate.input_contract_path === undefined && gate.input_set_id === undefined;
    const inputPaths = contractBinding ? contractPaths : inlineBinding ? inlinePaths : null;
    if (!nonEmptyString(gate.owner_module_id)
        || !(gate.feature_ids ?? []).includes(task.task_id)
        || !Array.isArray(inputPaths) || inputPaths.length === 0
        || (gate.argv[0] === 'node' && !inputPaths.includes(gate.argv[1]))) {
      addFailure(failures, 'TASK_GATE_INPUT_BINDING',
        `${task.task_id}: gate ${gateId} has no exact owner/feature/input closure`);
      continue;
    }
    for (const inputPath of inputPaths) {
      if (!isMachinePath(inputPath)
          || !truth.blobIdentity(candidateCommit, inputPath)
          || truth.ignored(inputPath)) {
        addFailure(failures, 'TASK_GATE_INPUT_NOT_TRACKED',
          `${task.task_id}:${gateId}:${inputPath} is not a governed regular input blob`);
        continue;
      }
      gateInputPaths.add(inputPath);
    }
  }
  for (const sourcePath of derivedSourcePaths) {
    if (!isMachinePath(sourcePath)
        || !IMPLEMENTATION_EXTENSIONS.has(path.extname(sourcePath))
        || !truth.trackedAt(candidateCommit, sourcePath)
        || truth.ignored(sourcePath)) {
      addFailure(failures, 'TASK_SOURCE_NOT_TRACKED', `${task.task_id}: ${sourcePath} is not a governed implementation blob`);
      continue;
    }
  }
  for (const fn of functions) {
    const sources = (fn.source_paths ?? []).map((sourcePath) => ({
      path: sourcePath,
      source: truth.blob(candidateCommit, sourcePath)?.toString('utf8') ?? '',
    }));
    for (const symbol of fn.entry_symbols ?? []) {
      if (!sources.some((entry) => sourceDefinesSymbol(entry.path, entry.source, symbol))) {
        addFailure(failures, 'TASK_ENTRY_SYMBOL_MISSING', `${task.task_id}: registered symbol ${symbol} is absent`);
      }
    }
  }
  return {
    functions,
    resources,
    sourcePaths: derivedSourcePaths,
    gateIds: derivedGates,
    gateInputPaths: sortedUnique([...gateInputPaths]),
  };
}

export function validateCandidateRecord({
  recordPath,
  record,
  batch,
  tasks,
  moduleRegistry,
  truth,
  integrationCommit,
  failures,
}) {
  const context = `batch ${batch.batch_id} candidate`;
  if (!isMachinePath(recordPath)
      || !recordPath.startsWith(`docs/evidence/feature-completion/`)
      || path.extname(recordPath) !== '.json'
      || !truth.trackedAt(integrationCommit, recordPath)
      || truth.ignored(recordPath)) {
    addFailure(failures, 'CANDIDATE_RECORD_PATH_INVALID', `${context}: record must be tracked in the evidence tree`);
    return null;
  }
  if (!record || typeof record !== 'object'
      || !sameOrdered(Object.keys(record).sort(), [...CANDIDATE_KEYS].sort())) {
    addFailure(failures, 'CANDIDATE_RECORD_SCHEMA', `${context}: record keys do not match the strict candidate schema`);
    return null;
  }
  const taskIds = sortedUnique(tasks.map((task) => task.task_id));
  const createdAt = Date.parse(record.created_at ?? '');
  if (record.batch_id !== batch.batch_id
      || !sameOrdered(sortedUnique(record.task_ids ?? []), taskIds)
      || !(batch.module_ids ?? []).includes(record.module_id)
      || record.owner !== record.module_id
      || typeof record.fix_candidate_id !== 'string' || record.fix_candidate_id.length === 0
      || typeof record.issue_id !== 'string' || record.issue_id.length === 0
      || typeof record.worktree_id !== 'string' || record.worktree_id.length === 0
      || typeof record.design_id !== 'string' || record.design_id.length === 0
      || !Number.isFinite(createdAt)
      || !FULL_COMMIT_PATTERN.test(record.base_commit ?? '')
      || !FULL_COMMIT_PATTERN.test(record.head_commit ?? '')
      || record.base_commit === record.head_commit
      || !FULL_COMMIT_PATTERN.test(record.tree_hash ?? '')
      || !SHA256_PATTERN.test(record.diff_hash ?? '')
      || !SHA256_PATTERN.test(record.scope_hash ?? '')
      || !Array.isArray(record.changed_paths) || record.changed_paths.length === 0
      || !sameOrdered(record.changed_paths, sortedUnique(record.changed_paths))
      || !Array.isArray(record.verification_evidence_ids)
      || !sameOrdered(record.verification_evidence_ids, sortedUnique(record.verification_evidence_ids))) {
    addFailure(failures, 'CANDIDATE_RECORD_IDENTITY', `${context}: owner/task/hash identity is invalid`);
    return null;
  }
  let derived;
  try {
    derived = truth.deriveCandidateIdentity({
      baseCommit: record.base_commit,
      headCommit: record.head_commit,
      binding: {
        schema: 'v4-feature-layer-candidate/v1',
        batch_id: batch.batch_id,
        module_id: record.module_id,
        task_ids: taskIds,
      },
    });
  } catch (error) {
    addFailure(failures, 'CANDIDATE_GIT_IDENTITY', `${context}: ${error.message}`);
    return null;
  }
  if (!derived
      || !truth.isAncestor(derived.base_commit, derived.head_commit)
      || !truth.isAncestor(derived.head_commit, integrationCommit)) {
    addFailure(failures, 'CANDIDATE_NOT_IN_INTEGRATION', `${context}: candidate object/ancestry is invalid`);
    return null;
  }
  for (const field of ['base_commit', 'head_commit', 'tree_hash', 'diff_hash', 'scope_hash']) {
    if (record[field] !== derived[field]) {
      addFailure(failures, 'CANDIDATE_GIT_IDENTITY', `${context}: ${field} does not match Git truth`);
    }
  }
  if (!sameOrdered(record.changed_paths, derived.changed_paths)) {
    addFailure(failures, 'CANDIDATE_CHANGED_PATHS_MISMATCH', `${context}: changed_paths are not the exact Git diff`);
  }
  const covered = sortedUnique(tasks.flatMap((task) => [
    ...(task.source_paths ?? []).map((item) => `v4/${item}`),
    ...(task.support_paths ?? []).map((item) => `v4/${item}`),
  ]).filter((candidatePath) => !isGovernanceClosurePath(candidatePath)));
  const laneChangedPaths = derived.changed_paths.filter((changedPath) => !isGovernanceClosurePath(changedPath));
  if (batch.batch_id !== 'G' && !sameOrdered(covered, laneChangedPaths)) {
    addFailure(failures, 'CANDIDATE_PATH_COVERAGE', `${context}: task source/support paths do not cover the exact candidate diff`);
  }
  const evidenceIds = sortedUnique(tasks.flatMap((task) => (task.evidence_refs ?? [])
    .map((ref) => path.basename(ref.path ?? '', '.json'))));
  if (!sameOrdered(sortedUnique(record.verification_evidence_ids ?? []), evidenceIds)) {
    addFailure(failures, 'CANDIDATE_EVIDENCE_SET_MISMATCH', `${context}: evidence ID set drifted`);
  }
  for (const changedPath of derived.changed_paths) {
    if (FORBIDDEN_CANDIDATE_PREFIXES.some((prefix) => changedPath.startsWith(prefix))) {
      addFailure(failures, 'CANDIDATE_FORBIDDEN_PATH', `${context}: forbidden path ${changedPath}`);
      continue;
    }
    const relativePath = changedPath.slice(3);
    const owners = moduleOwnersForPath(moduleRegistry, relativePath);
    if (!isGovernanceClosurePath(changedPath)
        && (owners.length !== 1 || owners[0].module_id !== record.module_id)) {
      addFailure(failures, 'CANDIDATE_MODULE_OWNER_MISMATCH', `${context}: ${changedPath} must have exactly one candidate module owner`);
    }
  }
  return derived;
}
