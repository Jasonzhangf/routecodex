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

const root = process.cwd();

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
  .readdirSync(path.join(root, 'v4/crates'), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);

const SYMBOL_RE = /\b(struct|enum|trait|fn|type)\s+([A-Za-z_][A-Za-z0-9_]*)\b|\bimpl\b[^\n]*\b([A-Za-z_][A-Za-z0-9_]*)\b/g;

function collectDeclaredSymbols(crate) {
  const crateRoot = path.join(root, 'v4/crates', crate, 'src');
  const symbols = new Set();
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith('.rs')) {
        const source = fs.readFileSync(full, 'utf8');
        for (const match of source.matchAll(SYMBOL_RE)) {
          const symbol = match[2] ?? match[3];
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

function validate(resourceMap, appsdkMap, verificationMap) {
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
      } else if (crate && CRATE_DIRS.includes(crate)) {
        const present = declaredSymbols.get(crate) ?? new Set();
        const missing = symbols.filter((symbol) => !present.has(symbol));
        if (missing.length > 0) {
          failures.push(`${id}: owner_symbols not declared in ${crate} src: ${missing.join(', ')}`);
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
  const baseResourceMap = readYaml('v4/docs/architecture/v4-resource-operation-map.yml');
  const baseAppsdkMap = readJson('v4/.appsdk/maps/resource-map.json');
  const verificationMap = readJson('v4/.appsdk/maps/verification-map.json');

  const clone = (value) => JSON.parse(JSON.stringify(value));
  const cases = [
    ['missing owner_crate', (m) => delete m.resources[0].owner_crate],
    ['anchored with missing crate', (m) => {
      const resource = m.resources.find((r) => r.binding_status === 'anchored');
      resource.owner_crate = 'routecodex-v4-does-not-exist';
    }],
    ['unregistered gate', (m) => m.resources[0].verification_gate.push('v4_parity_gate_nonexistent')],
    ['anchored/drift', (m) => {
      const resource = m.resources.find((r) => r.binding_status === 'design');
      resource.binding_status = 'anchored';
    }],
    ['anchored symbol missing', (m) => {
      const resource = m.resources.find((r) => r.binding_status === 'anchored');
      resource.owner_symbols = ['routecodex_v4_symbol_does_not_exist'];
    }],
    ['unregistered .appsdk v4 resource', (appsdk) => {
      appsdk.resources.push({
        resource_id: 'v4.unregistered.resource',
        owner: 'routecodex-v4-runtime::Ghost',
        status: 'design',
      });
    }],
  ];

  let failed = 0;
  for (const [name, mutate] of cases) {
    const resourceMap = clone(baseResourceMap);
    const appsdkMap = clone(baseAppsdkMap);
    if (name === 'unregistered .appsdk v4 resource') {
      mutate(appsdkMap);
    } else {
      mutate(resourceMap, appsdkMap);
    }
    const failures = validate(resourceMap, appsdkMap, verificationMap);
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
  console.log('[v4_parity_gate_resource_binding] OK red self-test 6/6');
}

if (process.argv.includes('--red-self-test')) {
  runSelfTest();
  process.exit(0);
}

const resourceMap = readYaml('v4/docs/architecture/v4-resource-operation-map.yml');
const appsdkMap = readJson('v4/.appsdk/maps/resource-map.json');
const verificationMap = readJson('v4/.appsdk/maps/verification-map.json');

const failures = validate(resourceMap, appsdkMap, verificationMap);
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
