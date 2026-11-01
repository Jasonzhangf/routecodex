#!/usr/bin/env node
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const verifier = resolve(repoRoot, 'v3/scripts/architecture/verify-v3-hub-v1-node-file-topology.mjs');

const fixtures = [
  {
    name: 'mainline builder mapped back to root',
    relative: 'docs/architecture/v3-mainline-call-map.yml',
    from: '    callee_symbol: build_v3_hub_req_inbound_02_from_v3_hub_req_inbound_01\n    callee_file: v3/crates/routecodex-v3-runtime/src/hub_v1/req_inbound_02_normalized.rs',
    to: '    callee_symbol: build_v3_hub_req_inbound_02_from_v3_hub_req_inbound_01\n    callee_file: v3/crates/routecodex-v3-runtime/src/hub_v1.rs',
    diagnostic: /callee_file|root aggregator|req_inbound_02_normalized/,
  },
  {
    name: 'duplicate builder in root aggregator',
    relative: 'v3/crates/routecodex-v3-runtime/src/hub_v1.rs',
    append: '\npub fn build_v3_hub_req_inbound_02_from_v3_hub_req_inbound_01() {}\n',
    diagnostic: /root aggregator|build_v3_hub_req_inbound_02_from_v3_hub_req_inbound_01|duplicate/,
  },
  {
    name: 'duplicate node struct outside declared owner',
    relative: 'v3/crates/routecodex-v3-runtime/src/hub_v1/common.rs',
    append: '\npub struct V3HubReqInbound02Normalized;\n',
    diagnostic: /V3HubReqInbound02Normalized: expected one definition|shared helper must not define node/,
  },
  {
    name: 'missing node owner file',
    remove: 'v3/crates/routecodex-v3-runtime/src/hub_v1/req_inbound_02_normalized.rs',
    diagnostic: /req_inbound_02_normalized\.rs: missing|V3HubReqInbound02Normalized/,
  },
  {
    name: 'shared helper owns node-local builder',
    relative: 'v3/crates/routecodex-v3-runtime/src/hub_v1/common.rs',
    append: '\npub fn build_v3_hub_req_inbound_02_from_v3_hub_req_inbound_01() {}\n',
    diagnostic: /shared helper must not define builder|common\.rs/,
  },
  {
    name: 'provider compat branch numbering made ambiguous',
    relative: 'docs/architecture/v3-mainline-call-map.yml',
    from: '  - step_id: v3-hub-req-07\n    from_node: ProviderReqCompat06ProviderCompat\n    to_node: V3ProviderReqOutbound08WirePayload',
    to: '  - step_id: v3-hub-req-07\n    from_node: ProviderReqCompat07ProviderCompat\n    to_node: V3ProviderReqOutbound08WirePayload',
    diagnostic: /v3-hub-req-07 mixes declared Hub v1 node with undeclared node|ProviderReqCompat07ProviderCompat/,
  },
  {
    name: 'function map loses node owner truth',
    relative: 'docs/architecture/v3-function-map.yml',
    from: 'node_owner_files:',
    to: 'node_owner_files_removed:',
    diagnostic: /node_owner_files missing|H1 node_owner_files/,
  },
];

function copyRequiredTree(root) {
  const files = ['docs/architecture/v3-function-map.yml', 'docs/architecture/v3-mainline-call-map.yml'];
  const maps = files.map((file) => {
    const text = readFileSync(join(repoRoot, file), 'utf8');
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
    return YAML.parse(text);
  });
  const owner = maps[0].features.find((entry) => entry.feature_id === 'v3.hub_pipeline_static_skeleton');
  const declarations = new Map();
  const add = (file, declaration = '') => {
    if (!declarations.has(file)) declarations.set(file, new Set());
    if (declaration) declarations.get(file).add(declaration);
  };
  add(owner.module_export_owner_file);
  for (const entry of owner.node_owner_files) {
    add(entry.owner_file, `pub struct ${entry.node};`);
    add(entry.owner_file, `pub fn ${entry.builder_symbol}() {}`);
  }
  for (const helper of owner.shared_helper_owner_files) add(helper.file);
  for (const edge of maps[1].chains.flatMap((chain) => chain.edges ?? [])) {
    for (const kind of ['caller', 'callee']) {
      const file = edge[`${kind}_file`];
      const symbol = edge[`${kind}_symbol`];
      if (!file || !symbol || file === owner.module_export_owner_file) continue;
      if (!file.startsWith('v3/crates/routecodex-v3-runtime/src/hub_v1')
          && !file.startsWith('v3/crates/routecodex-v3-runtime/tests/')) continue;
      const base = symbol.split('::')[0];
      const node = owner.node_owner_files.some((entry) => entry.node === base);
      add(file, symbol.includes('::') || node ? `pub struct ${base};` : `pub fn ${base}() {}`);
    }
  }
  for (const [file, source] of declarations) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), [...source].join('\n'));
  }
}

const failures = [];
let baselineChecked = false;
for (const fixture of fixtures) {
  const root = mkdtempSync(join(tmpdir(), 'routecodex-v3-hub-v1-node-file-red-'));
  try {
    copyRequiredTree(root);
    const options = { cwd: root, encoding: 'utf8', env: { ...process.env, ROUTECODEX_V3_SOURCE_ROOT: root } };
    if (!baselineChecked) {
      const baseline = spawnSync(process.execPath, [verifier], options);
      if (baseline.status !== 0) throw new Error(`fixture baseline failed: ${baseline.stdout}\n${baseline.stderr}`);
      baselineChecked = true;
    }
    if (fixture.remove) {
      unlinkSync(join(root, fixture.remove));
    } else {
      const target = join(root, fixture.relative);
      const source = readFileSync(target, 'utf8');
      const next = fixture.append
        ? source + fixture.append
        : (() => {
            if (!source.includes(fixture.from)) throw new Error(`${fixture.name}: fixture source missing`);
            return source.replace(fixture.from, fixture.to);
          })();
      writeFileSync(target, next);
    }
    const result = spawnSync(process.execPath, [verifier], options);
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    if (result.status !== 1) {
      failures.push(`${fixture.name}: gate unexpectedly passed`);
    } else if (!fixture.diagnostic.test(output)) {
      failures.push(`${fixture.name}: wrong diagnostic: ${output.slice(-1200)}`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (failures.length) {
  console.error('[test:v3-hub-v1-node-file-topology-red-fixtures] failed');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`[test:v3-hub-v1-node-file-topology-red-fixtures] ok (${fixtures.length} forbidden mutations rejected)`);
