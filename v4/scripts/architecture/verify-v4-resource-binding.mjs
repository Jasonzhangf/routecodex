#!/usr/bin/env node
/**
 * v4_parity_gate_resource_binding
 *
 * Locks V4 resource ownership truth (Phase 2 + Truth Lock):
 * 1. Every resource in v4-resource-operation-map.yml must carry
 *    resource_id / owner_crate / owner_node / axis / lifecycle /
 *    allowed_writers / allowed_readers / forbidden_writers /
 *    verification_gate and a valid binding_status (design|anchored).
 * 2. anchored requires: owner_crate exists in v4/crates, every
 *    verification_gate is registered in verification-map.json, and the
 *    .appsdk resource-map.json counterpart declares status active with the
 *    same crate owner.
 * 3. design resources must not drift to active in .appsdk resource-map.json
 *    (dual-source consistency).
 * 4. No v4 resource may exist in .appsdk resource-map.json without a YAML
 *    declaration, unless it is a registered contract-bound plugin resource,
 *    an appsdk-owned registry resource, or a build-link-owned resource
 *    (no unregistered resource ownership).
 *
 * Run with --red-self-test to prove the gate fails on each negative class.
 */
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const readJson = (file) => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
const readYaml = (file) => yaml.load(fs.readFileSync(path.join(root, file), 'utf8'));

const REQUIRED_FIELDS = [
  'resource_id',
  'owner_crate',
  'owner_node',
  'axis',
  'lifecycle',
  'allowed_writers',
  'allowed_readers',
  'forbidden_writers',
  'verification_gate',
];

const CRATE_DIRS = fs
  .readdirSync(path.join(root, 'crates'), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);

// Only crate-level declarations bind a resource: column-0
// `pub [struct|enum|trait|fn|type|const|static]` items and `pub use`
// re-exports. Impl-method names (`fn new`, `fn execute`) and locals never
// count, so `owner_symbols` cannot be satisfied by text presence alone.
const DECL_RE = /^(?:pub(?:\([^)]*\))?\s+)?(struct|enum|trait|fn|type|const|static)\s+([A-Za-z_][A-Za-z0-9_]*)\b/gm;
const REUSE_RE = /^pub use [^\n]*\b([A-Za-z_][A-Za-z0-9_]*)\b/gm;

function collectDeclaredSymbols(crate) {
  const crateRoot = path.join(root, 'crates', crate, 'src');
  const symbols = new Set();
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith('.rs')) {
        const source = fs.readFileSync(full, 'utf8');
        for (const match of source.matchAll(DECL_RE)) {
          const symbol = match[2];
          if (symbol) {
            symbols.add(symbol);
          }
        }
        for (const match of source.matchAll(REUSE_RE)) {
          const symbol = match[1];
          if (symbol) {
            symbols.add(symbol);
          }
        }
      }
    }
  };
  if (fs.existsSync(crateRoot)) {
    walk(crateRoot);
  }
  return symbols;
}

/**
 * Machine node catalog for resource relations: node-graph chains +
 * skeleton-plan checkpoints + node-graph registered_nodes. Relation entries
 * must resolve to this catalog or to an explicit non-node reference
 * (developer/incident/replay consumers and bare crate identities); unknown
 * node-like references are RED (no resource self-proof, no dangling nodes).
 */
function collectNodeCatalog() {
  const nodeIds = new Set();
  const nodeGraph = readJson('contracts/node-graph.contract.json');
  for (const [key, value] of Object.entries(nodeGraph)) {
    if (key === 'registered_nodes') {
      for (const node of value ?? []) {
        if (node?.node_id) nodeIds.add(node.node_id);
      }
    } else if (Array.isArray(value)) {
      for (const node of value) {
        if (Array.isArray(node?.nodes)) {
          for (const inner of node.nodes) {
            if (inner?.node_id) nodeIds.add(inner.node_id);
          }
        }
      }
    }
  }
  const skeleton = readJson('contracts/skeleton-plan.contract.json');
  for (const chain of skeleton.chains ?? []) {
    for (const checkpoint of chain.checkpoints ?? []) {
      if (checkpoint?.node_id) nodeIds.add(checkpoint.node_id);
    }
  }
  return nodeIds;
}

function nodeBase(ref) {
  // Accept both `V4Node` and `V4Node::method` relation references; the base
  // node must exist in the machine catalog.
  const match = /^(V4[A-Za-z0-9_]+)(?:::.*)?$/.exec(ref);
  return match ? match[1] : null;
}

function isNodeLike(ref) {
  return nodeBase(ref) !== null;
}

function isNonNodeRef(ref) {
  return (
    ref.startsWith('developer_') ||
    ref.startsWith('incident_') ||
    ref.startsWith('replay_') ||
    ref.startsWith('appsdk::') ||
    /^routecodex-v4-[a-z-]+$/.test(ref) ||
    ref === 'v4.pipeline.mainline' ||
    ref === 'v4.debug.event_ledger' ||
    ref === 'v4.debug.raw_capture' ||
    ref === 'v4.debug.snapshot_session' ||
    ref === 'v4.debug.observability' ||
    ref === 'v4.console.terminal_output'
  );
}

function validate(resourceMap, appsdkMap, verificationMap, nodeIds) {
  const failures = [];
  const gateIds = new Set((verificationMap.gates ?? []).map((gate) => gate.gate_id));
  const appsdkById = new Map((appsdkMap.resources ?? []).map((resource) => [resource.resource_id, resource]));
  const declaredSymbols = new Map(
    CRATE_DIRS.map((crate) => [crate, collectDeclaredSymbols(crate)]),
  );

  for (const resource of resourceMap.resources ?? []) {
    const id = resource.resource_id;
    if (!id) {
      failures.push('resource without resource_id');
      continue;
    }
    for (const field of REQUIRED_FIELDS) {
      if (resource[field] === undefined) {
        failures.push(`${id}: missing required field ${field}`);
      }
    }
    const status = resource.binding_status;
    if (status !== 'design' && status !== 'anchored') {
      failures.push(`${id}: binding_status must be design|anchored (got ${status ?? 'undefined'})`);
    }
    const gates = Array.isArray(resource.verification_gate) ? resource.verification_gate : [];
    for (const gate of gates) {
      if (!gateIds.has(gate)) {
        failures.push(`${id}: verification_gate ${gate} not registered in verification-map.json`);
      }
    }

    const crate = resource.owner_crate;
    if (crate && !CRATE_DIRS.includes(crate)) {
      if (status === 'anchored') {
        failures.push(`${id}: anchored resource owner_crate ${crate} does not exist in v4/crates`);
      }
    }
    if (status === 'anchored') {
      const symbols = resource.owner_symbols;
      if (!Array.isArray(symbols) || symbols.length === 0) {
        failures.push(`${id}: anchored resource requires non-empty owner_symbols`);
      }
    } else if (crate && CRATE_DIRS.includes(crate)) {
      const symbols = resource.owner_symbols;
      if (!Array.isArray(symbols) || symbols.length === 0) {
        failures.push(`${id}: design resource with implemented owner crate requires owner_symbols (no design pretending to be truth)`);
      }
    }
    const symbols = Array.isArray(resource.owner_symbols) ? resource.owner_symbols : [];
    if (crate && CRATE_DIRS.includes(crate) && symbols.length > 0) {
      const present = declaredSymbols.get(crate) ?? new Set();
      const missing = symbols.filter((symbol) => !present.has(symbol));
      if (missing.length > 0) {
        failures.push(`${id}: owner_symbols not declared in ${crate} src: ${missing.join(', ')}`);
      }
    }
    if (crate && CRATE_DIRS.includes(crate) && status === 'anchored') {
      const ownerNode = resource.owner_node;
      const ownerBound = nodeIds.has(ownerNode) || symbols.includes(ownerNode);
      if (!ownerBound) {
        failures.push(`${id}: anchored owner_node ${ownerNode} not in node-graph/skeleton/registered catalog or owner_symbols`);
      }
      for (const kind of ['allowed_writers', 'allowed_readers', 'forbidden_writers']) {
        for (const ref of resource[kind] ?? []) {
          const base = nodeBase(ref);
          if (base && !nodeIds.has(base) && !isNonNodeRef(ref)) {
            failures.push(`${id}: ${kind} reference ${ref} not in node catalog`);
          }
        }
      }
      const forbidden = new Set(resource.forbidden_writers ?? []);
      for (const ref of resource.allowed_writers ?? []) {
        if (forbidden.has(ref)) {
          failures.push(`${id}: allowed writer ${ref} is also forbidden`);
        }
      }
    }

    const appsdk = appsdkById.get(id);
    if (!appsdk) {
      failures.push(`${id}: missing counterpart in .appsdk/maps/resource-map.json`);
      continue;
    }
    const appsdkOwner = String(appsdk.owner ?? '');
    if (crate && !appsdkOwner.startsWith(`${crate}::`)) {
      failures.push(`${id}: .appsdk owner ${appsdkOwner} does not match YAML owner_crate ${crate}`);
    } else if (crate && appsdkOwner.startsWith(`${crate}::`)) {
      const appsdkSymbol = appsdkOwner.slice(crate.length + 2);
      if (!symbols.includes(appsdkSymbol) && appsdkSymbol !== resource.owner_node) {
        failures.push(`${id}: .appsdk owner symbol ${appsdkSymbol} not declared in YAML owner_symbols/owner_node`);
      }
    }
    if (status === 'anchored' && appsdk.status !== 'active') {
      failures.push(`${id}: anchored in YAML but .appsdk status=${appsdk.status} (must be active)`);
    }
    if (status === 'design' && appsdk.status !== 'design') {
      failures.push(`${id}: design in YAML but .appsdk status=${appsdk.status} (drift)`);
    }
  }

  const yamlIds = new Set((resourceMap.resources ?? []).map((resource) => resource.resource_id));
  for (const resource of appsdkMap.resources ?? []) {
    const owner = String(resource.owner ?? '');
    const registeredExtra =
      (resource.status === 'contract_bound' && owner.startsWith('contract:')) ||
      owner.startsWith('appsdk::') ||
      owner === 'routecodex-v4-build-link' ||
      owner.startsWith('routecodex-v4-build-link::');
    if (resource.resource_id.startsWith('v4.') && !yamlIds.has(resource.resource_id) && !registeredExtra) {
      failures.push(`${resource.resource_id}: declared in .appsdk resource-map.json without YAML declaration`);
    }
  }
  return failures;
}

function runSelfTest() {
  const baseResourceMap = readYaml('docs/architecture/v4-resource-operation-map.yml');
  const baseAppsdkMap = readJson('.appsdk/maps/resource-map.json');
  const verificationMap = readJson('.appsdk/maps/verification-map.json');

  const clone = (value) => JSON.parse(JSON.stringify(value));
  const cases = [
    ['missing owner_crate', (m) => delete m.resources[0].owner_crate],
    ['anchored with missing crate', (m) => {
      const resource = m.resources.find((r) => r.binding_status === 'anchored');
      resource.owner_crate = 'routecodex-v4-does-not-exist';
    }],
    ['unregistered gate', (m) => m.resources[0].verification_gate.push('v4_parity_gate_nonexistent')],
    ['anchored flipped to design drifts from .appsdk active', (m) => {
      const resource = m.resources.find((r) => r.binding_status === 'anchored');
      resource.binding_status = 'design';
    }],
    ['anchored symbol missing', (m) => {
      const resource = m.resources.find((r) => r.binding_status === 'anchored');
      resource.owner_symbols = ['routecodex_v4_symbol_does_not_exist'];
    }],
    ['method name is not a symbol', (m) => {
      const resource = m.resources.find((r) => r.binding_status === 'anchored');
      resource.owner_symbols = ['new'];
    }],
    ['unregistered .appsdk v4 resource', (appsdk) => {
      appsdk.resources.push({
        resource_id: 'v4.unregistered.resource',
        owner: 'routecodex-v4-runtime::Ghost',
        status: 'design',
      });
    }],
    ['anchored owner_node not in catalog', (m) => {
      const resource = m.resources.find((r) => r.binding_status === 'anchored');
      resource.owner_node = 'V4GhostNode99';
    }],
    ['relation reference not in catalog', (m) => {
      const resource = m.resources.find((r) => r.binding_status === 'anchored');
      resource.allowed_readers.push('V4GhostReader99');
    }],
    ['forbidden writer is also allowed', (m) => {
      const resource = m.resources.find((r) => r.binding_status === 'anchored');
      resource.allowed_writers.push(resource.forbidden_writers[0]);
    }],
    ['appsdk owner symbol not declared', (appsdk) => {
      const resource = appsdk.resources.find((r) => r.resource_id === 'v4.request.normal_payload');
      resource.owner = 'routecodex-v4-runtime::GhostSymbol';
    }],
    ['anchored resource with empty owner_symbols', (m) => {
      const resource = m.resources.find((r) => r.binding_status === 'anchored');
      resource.owner_symbols = [];
    }],
  ];

  let failed = 0;
  for (const [name, mutate] of cases) {
    const resourceMap = clone(baseResourceMap);
    const appsdkMap = clone(baseAppsdkMap);
    if (name === 'unregistered .appsdk v4 resource' || name === 'appsdk owner symbol not declared') {
      mutate(appsdkMap);
    } else {
      mutate(resourceMap, appsdkMap);
    }
    const failures = validate(resourceMap, appsdkMap, verificationMap, collectNodeCatalog());
    if (failures.length === 0) {
      console.error(`[v4_parity_gate_resource_binding] red self-test ${name}: expected FAIL, got PASS`);
      failed += 1;
    } else {
      console.log(`[v4_parity_gate_resource_binding] red self-test ${name}: FAIL as expected (${failures.length})`);
    }
  }
  if (failed > 0) {
    process.exit(1);
  }
  console.log(`[v4_parity_gate_resource_binding] OK red self-test ${cases.length}/${cases.length}`);
}

if (process.argv.includes('--red-self-test')) {
  runSelfTest();
  process.exit(0);
}

const resourceMap = readYaml('docs/architecture/v4-resource-operation-map.yml');
const appsdkMap = readJson('.appsdk/maps/resource-map.json');
const verificationMap = readJson('.appsdk/maps/verification-map.json');

const failures = validate(resourceMap, appsdkMap, verificationMap, collectNodeCatalog());
if (failures.length > 0) {
  console.error('[v4_parity_gate_resource_binding] FAIL');
  console.error(failures.join('\n'));
  process.exit(1);
}

const anchored = (resourceMap.resources ?? []).filter((r) => r.binding_status === 'anchored').length;
const total = (resourceMap.resources ?? []).length;
console.log(
  `[v4_parity_gate_resource_binding] OK resources=${total} anchored=${anchored} dual-source consistent`,
);
