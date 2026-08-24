import path from 'node:path';
import {
  GRAPH_SOURCE_EXTENSIONS,
  addFailure,
  pathMatchesPattern,
  sameOrdered,
  sortedUnique,
} from './feature-layer-batch-contract.mjs';

function moduleForPath(moduleRegistry, relativePath) {
  const matches = (moduleRegistry.modules ?? []).filter((module) => module.status === 'active'
    && (module.owned_paths ?? []).some((pattern) => pathMatchesPattern(relativePath, pattern)));
  return { module_id: matches.length === 1 ? matches[0].module_id : null, count: matches.length };
}

function batchOwnership(manifest) {
  const owners = new Map();
  for (const batch of manifest.batches ?? []) {
    if (batch.owner_binding_status !== 'bound') continue;
    for (const moduleId of batch.module_ids ?? []) owners.set(moduleId, batch.batch_id);
  }
  return owners;
}

function rustModuleReferences(source) {
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/r(#+)?"[\s\S]*?"\1/g, ' ')
    .replace(/b?"(?:\\.|[^"\\])*"/g, ' ')
    .replace(/b?'(?:\\.|[^'\\])'/g, ' ');
  return sortedUnique([...code.matchAll(/\broutecodex_v4_[a-z0-9_]+\b/g)]
    .map((match) => match[0].replaceAll('_', '-')));
}

function jsSpecifiers(source) {
  const specifiers = [];
  const callSites = [...source.matchAll(/\b(?:require|import)\s*\(/g)].length;
  const literalCalls = [...source.matchAll(/\brequire\(\s*['"][^'"]+['"]\s*\)|\bimport\(\s*['"][^'"]+['"]\s*\)/g)].length;
  if (callSites !== literalCalls) {
    throw new Error('computed or non-canonical dynamic import/require is forbidden');
  }
  const pattern = /\b(?:import|export)\s+(?:[^'"\n]*?\s+from\s+)?['"]([^'"]+)['"]|\brequire\(\s*['"]([^'"]+)['"]\s*\)|\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const match of source.matchAll(pattern)) specifiers.push(match[1] ?? match[2] ?? match[3]);
  return sortedUnique(specifiers.filter(Boolean));
}

function resolveJsImport(truth, commit, sourcePath, specifier) {
  if (!specifier.startsWith('.')) return null;
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(sourcePath), specifier));
  const candidates = path.posix.extname(base)
    ? [base]
    : [base, ...['.mjs', '.js', '.cjs', '.ts', '.tsx'].map((extension) => `${base}${extension}`),
      ...['.mjs', '.js', '.cjs', '.ts', '.tsx'].map((extension) => `${base}/index${extension}`)];
  const matches = candidates.filter((candidate) => truth.trackedAt(commit, candidate));
  if (matches.length !== 1) {
    throw new Error(`${sourcePath}: relative import ${specifier} resolves ${matches.length} tracked files`);
  }
  return matches[0];
}

export function validateTaskSourceGraph({
  manifest,
  moduleRegistry,
  batch,
  task,
  candidateCommit,
  truth,
  failures,
}) {
  const moduleBatches = batchOwnership(manifest);
  let cargoPackages;
  try {
    cargoPackages = truth.cargoGraph(candidateCommit);
  } catch (error) {
    addFailure(failures, 'CARGO_GRAPH_UNREADABLE', `${task.task_id}: ${error.message}`);
    return;
  }
  for (const pkg of cargoPackages.values()) {
    const sourceOwner = moduleForPath(moduleRegistry, pkg.manifest_path);
    if (sourceOwner.count !== 1) {
      addFailure(failures, 'CARGO_MODULE_OWNER_CARDINALITY',
        `${pkg.manifest_path}: owner count ${sourceOwner.count}`);
      continue;
    }
    const sourceBatch = moduleBatches.get(sourceOwner.module_id);
    if (!sourceBatch) continue;
    for (const dependency of pkg.dependencies) {
      const targetOwner = moduleForPath(moduleRegistry, dependency.manifest_path);
      if (targetOwner.count !== 1) {
        addFailure(failures, 'CARGO_MODULE_OWNER_CARDINALITY',
          `${dependency.manifest_path}: owner count ${targetOwner.count}`);
        continue;
      }
      const targetBatch = moduleBatches.get(targetOwner.module_id);
      if (targetBatch && targetBatch !== sourceBatch) {
        addFailure(failures, 'CROSS_LANE_CARGO_DEPENDENCY',
          `${pkg.package_name}(${sourceBatch})->${dependency.dependency_name}(${targetBatch})`);
      }
    }
  }
  for (const sourcePath of task.source_paths ?? []) {
    if (!GRAPH_SOURCE_EXTENSIONS.has(path.extname(sourcePath))) continue;
    const bytes = truth.blob(candidateCommit, sourcePath);
    if (bytes === null) {
      addFailure(failures, 'TASK_GRAPH_SOURCE_MISSING', `${task.task_id}:${sourcePath}`);
      continue;
    }
    const source = bytes.toString('utf8');
    const sourceOwner = moduleForPath(moduleRegistry, sourcePath);
    if (sourceOwner.count !== 1) {
      addFailure(failures, 'TASK_SOURCE_MODULE_OWNER_CARDINALITY',
        `${sourcePath}: owner count ${sourceOwner.count}`);
      continue;
    }
    const sourceBatch = moduleBatches.get(sourceOwner.module_id);
    if (path.extname(sourcePath) === '.rs') {
      for (const targetModule of rustModuleReferences(source)) {
        const targetBatch = moduleBatches.get(targetModule);
        if (sourceBatch && targetBatch && targetBatch !== sourceBatch) {
          addFailure(failures, 'CROSS_LANE_RUST_REFERENCE',
            `${sourcePath}:${sourceBatch}->${targetModule}:${targetBatch}`);
        }
      }
    } else {
      let specifiers;
      try {
        specifiers = jsSpecifiers(source);
      } catch (error) {
        addFailure(failures, 'JS_IMPORT_GRAPH_UNREADABLE', `${sourcePath}: ${error.message}`);
        continue;
      }
      for (const specifier of specifiers) {
        let targetPath;
        try {
          targetPath = resolveJsImport(truth, candidateCommit, sourcePath, specifier);
        } catch (error) {
          addFailure(failures, 'JS_IMPORT_GRAPH_UNREADABLE', error.message);
          continue;
        }
        if (!targetPath) continue;
        const targetOwner = moduleForPath(moduleRegistry, targetPath);
        if (targetOwner.count !== 1) {
          addFailure(failures, 'JS_IMPORT_MODULE_OWNER_CARDINALITY',
            `${targetPath}: owner count ${targetOwner.count}`);
          continue;
        }
        const targetBatch = moduleBatches.get(targetOwner.module_id);
        if (sourceBatch && targetBatch && targetBatch !== sourceBatch) {
          addFailure(failures, 'CROSS_LANE_JS_IMPORT',
            `${sourcePath}:${sourceBatch}->${targetPath}:${targetBatch}`);
        }
      }
    }
  }
}

function parseBuildEdges(source) {
  const edges = [];
  for (const match of source.matchAll(/^\s*run\('([^']+)'\);\s*$/gm)) {
    const command = match[1];
    const consumer = command.match(/(?:^|\s)--consumer\s+([^\s]+)/)?.[1];
    if (!consumer) continue;
    for (const flag of ['deps', 'source-deps']) {
      const value = command.match(new RegExp(`(?:^|\\s)--${flag}\\s+([^\\s]+)`))?.[1];
      for (const dependency of value?.split(',').filter(Boolean) ?? []) {
        edges.push(`build:${flag}:${consumer}->${dependency}`);
      }
    }
    const rlibs = command.match(/(?:^|\s)--rlib-deps\s+([^\s]+)/)?.[1];
    for (const binding of rlibs?.split(',').filter(Boolean) ?? []) {
      const dependency = binding.split('=')[0].replaceAll('_', '-');
      edges.push(`build:rlib-deps:${consumer}->${dependency}`);
    }
  }
  return sortedUnique(edges);
}

function parseConsumerRegressionEdges(source) {
  const section = source.match(/export const CONSUMER_REGRESSIONS = \[([\s\S]*?)\n\];/)?.[1];
  if (!section) throw new Error('CONSUMER_REGRESSIONS is not parseable');
  const edges = [];
  const lines = section.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (const line of lines) {
    const values = [...line.matchAll(/'([^']*)'/g)].map((match) => match[1]);
    const residue = line.replace(/'[^']*'/g, '').replace(/[\[\],]/g, '').trim();
    if (residue.length > 0 || values.length < 2 || values.length % 2 !== 0) {
      throw new Error(`CONSUMER_REGRESSIONS entry is not canonical: ${line}`);
    }
    const [consumer, dependencies, ...options] = values;
    for (const dependency of dependencies.split(',').filter(Boolean)) {
      edges.push(`regression:deps:${consumer}->${dependency}`);
    }
    const seenFlags = new Set();
    for (let index = 0; index < options.length; index += 2) {
      const flag = options[index];
      const bindings = options[index + 1];
      if (!['--source-deps', '--rlib-deps'].includes(flag) || seenFlags.has(flag)) {
        throw new Error(`CONSUMER_REGRESSIONS option is invalid: ${line}`);
      }
      seenFlags.add(flag);
      for (const binding of bindings.split(',').filter(Boolean)) {
        edges.push(`regression:${flag.slice(2)}:${consumer}->${binding.split('=')[0].replaceAll('_', '-')}`);
      }
    }
  }
  return sortedUnique(edges);
}

function parseFrozenEdges(source) {
  const registry = JSON.parse(source);
  return sortedUnique([
    ...(registry.active_link_edges ?? []).map((edge) => `active:${edge.from}->${edge.to}`),
    ...(registry.consumers ?? []).map((edge) => `consumer:${edge.mode}:${edge.consumer}->${edge.dependency}`),
  ]);
}

function parseMainlineEdges(source) {
  const map = JSON.parse(source);
  return sortedUnique((map.edges ?? []).map((edge) =>
    `mainline:${edge.chain_id}:${edge.from}->${edge.to}:${edge.owner}`));
}

function parseWorkspaceMembers(source) {
  const section = source.match(/^\s*members\s*=\s*\[([\s\S]*?)\]\s*$/m)?.[1];
  if (!section) throw new Error('Cargo workspace members are not parseable');
  const members = [...section.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  if (members.length === 0) throw new Error('Cargo workspace members cannot be empty');
  return sortedUnique(members.map((member) => `workspace:member:${member}`));
}

function readAt(context, commit, relativePath) {
  const bytes = commit === null
    ? Buffer.from(context.io.readText(relativePath))
    : context.truth.blob(commit, relativePath);
  if (bytes === null) throw new Error(`${relativePath} cannot be read at ${commit}`);
  return bytes.toString('utf8');
}

function semanticWiringGraph(context, commit) {
  const cargoEdges = [];
  for (const pkg of context.truth.cargoGraph(commit).values()) {
    for (const dependency of pkg.dependencies) {
      cargoEdges.push(`cargo:path:${pkg.package_name}->${dependency.dependency_name}`);
    }
  }
  return sortedUnique([
    ...cargoEdges,
    ...parseWorkspaceMembers(readAt(context, commit, 'Cargo.toml')),
    ...parseBuildEdges(readAt(context, commit, 'scripts/build.mjs')),
    ...parseConsumerRegressionEdges(readAt(context, commit, 'scripts/_gate-matrix.mjs')),
    ...parseFrozenEdges(readAt(context, commit, 'contracts/active-link/frozen-consumer-registry.json')),
    ...parseMainlineEdges(readAt(context, commit, '.appsdk/maps/mainline-call-map.json')),
  ]);
}

const TEMPLATE_TICK = String.fromCharCode(96);
const GUARD_BOOTSTRAP_FAILURE_LINE = '  throw new Error(' + TEMPLATE_TICK
  + 'V4 feature-layer admission failed: ' + '$'
  + '{admission.stderr || admission.stdout}' + TEMPLATE_TICK + ');\n';
const GUARD_BOOTSTRAP_REMOVALS = new Map([
  ['scripts/build.mjs', [
    "run('node scripts/architecture/verify-v4-feature-layer-batches.mjs --build-guard');\n"
      + '// V4-LAYER-PREFLIGHT-END\n',
  ]],
  ['scripts/verify.mjs', [
    "run('node scripts/architecture/verify-v4-feature-layer-batches.mjs --build-guard');\n"
      + '// V4-LAYER-PREFLIGHT-END\n',
  ]],
  ['scripts/verify-ci.mjs', [
    "run('node scripts/architecture/verify-v4-feature-layer-batches.mjs --build-guard');\n"
      + '// V4-LAYER-PREFLIGHT-END\n',
  ]],
  ['scripts/install-rccv4.mjs', [
    "const admission = spawnSync(process.execPath, [\n"
      + "  'scripts/architecture/verify-v4-feature-layer-batches.mjs',\n"
      + "  '--admission',\n"
      + "], { cwd: root, encoding: 'utf8' });\n"
      + "if (admission.status !== 0) {\n"
      + GUARD_BOOTSTRAP_FAILURE_LINE
      + "}\n"
      + '// V4-LAYER-PREFLIGHT-END\n',
  ]],
  ['scripts/compile-real-runtime-manifest.mjs', [
    "import { spawnSync } from 'node:child_process';\n",
    "const admission = spawnSync(process.execPath, [\n"
      + "  'scripts/architecture/verify-v4-feature-layer-batches.mjs',\n"
      + "  '--admission',\n"
      + "], { cwd: root, encoding: 'utf8' });\n"
      + "if (admission.status !== 0) {\n"
      + GUARD_BOOTSTRAP_FAILURE_LINE
      + "}\n"
      + '// V4-LAYER-PREFLIGHT-END\n',
  ]],
]);

function removeExactOnce(source, fragment) {
  const first = source.indexOf(fragment);
  if (first < 0 || source.indexOf(fragment, first + fragment.length) >= 0) return null;
  return source.slice(0, first) + source.slice(first + fragment.length);
}

export function validateGuardCandidateBootstrap(manifest, context, candidate, failures) {
  const guardedChanges = context.truth.changedPaths(candidate.base_commit, candidate.head_commit)
    .filter((repoPath) => repoPath.startsWith('v4/'))
    .map((repoPath) => repoPath.slice(3))
    .filter((relativePath) => (manifest.integration.guarded_surfaces ?? [])
      .some((surface) => pathMatchesPattern(relativePath, surface.path)))
    .sort();
  const expectedChanges = [...GUARD_BOOTSTRAP_REMOVALS.keys()].sort();
  if (!sameOrdered(guardedChanges, expectedChanges)) {
    addFailure(failures, 'GUARD_CANDIDATE_WIRING_CHANGE',
      'guard candidate changed protected wiring surfaces: ' + guardedChanges.join(','));
    return;
  }
  for (const [relativePath, removals] of GUARD_BOOTSTRAP_REMOVALS) {
    const baseBytes = context.truth.blob(candidate.base_commit, relativePath);
    const headBytes = context.truth.blob(candidate.head_commit, relativePath);
    if (baseBytes === null || headBytes === null) {
      addFailure(failures, 'GUARD_CANDIDATE_WIRING_CHANGE',
        relativePath + ': guard bootstrap blobs are unavailable');
      continue;
    }
    let restored = headBytes.toString('utf8');
    for (const removal of removals) restored = removeExactOnce(restored, removal);
    if (restored === null || restored !== baseBytes.toString('utf8')) {
      addFailure(failures, 'GUARD_CANDIDATE_WIRING_CHANGE',
        relativePath + ': guard candidate contains non-bootstrap changes');
    }
  }
  try {
    const baseGraph = semanticWiringGraph(context, candidate.base_commit);
    const headGraph = semanticWiringGraph(context, candidate.head_commit);
    if (!sameOrdered(baseGraph, headGraph)) {
      addFailure(failures, 'GUARD_CANDIDATE_WIRING_CHANGE',
        'guard source candidate changed the semantic product wiring graph');
    }
  } catch (error) {
    addFailure(failures, 'GUARD_CANDIDATE_WIRING_CHANGE', error.message);
  }
}

export function observeWiring(manifest, context) {
  const guardCommit = context.truth.resolveCommit(manifest.integration?.guard_commit);
  if (!guardCommit || guardCommit !== manifest.integration?.guard_commit) {
    return { surface_changes: [], wiring_edges: [], readable: false };
  }
  const surfaceChanges = [];
  for (const surface of manifest.integration.guarded_surfaces ?? []) {
    const currentHash = context.truth.currentScopeHash([surface.path]);
    if (currentHash !== surface.scope_hash) surfaceChanges.push(`surface:${surface.path}:${currentHash}`);
  }
  const baseline = semanticWiringGraph(context, guardCommit);
  const current = semanticWiringGraph(context, null);
  const baselineSet = new Set(baseline);
  const currentSet = new Set(current);
  const graphChanges = [
    ...current.filter((edge) => !baselineSet.has(edge)).map((edge) => `added:${edge}`),
    ...baseline.filter((edge) => !currentSet.has(edge)).map((edge) => `removed:${edge}`),
  ];
  return {
    surface_changes: sortedUnique(surfaceChanges),
    wiring_edges: sortedUnique([...surfaceChanges, ...graphChanges]),
    readable: true,
  };
}

export function validateObservedWiring(manifest, context, failures) {
  let observed;
  try {
    observed = observeWiring(manifest, context);
  } catch (error) {
    addFailure(failures, 'WIRING_GRAPH_UNREADABLE', error.message);
    return null;
  }
  if (!observed.readable) {
    addFailure(failures, 'WIRING_GUARD_UNBOUND', 'wiring graph requires an exact guard commit');
    return observed;
  }
  if (!sameOrdered(manifest.integration.wiring_edges ?? [], observed.wiring_edges)
      || manifest.integration.wiring_started !== (observed.wiring_edges.length > 0)) {
    addFailure(failures, 'WIRING_OBSERVATION_MISMATCH', 'manifest wiring state is not derived from Git/graph truth');
  }
  return observed;
}
