#!/usr/bin/env node
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = process.cwd();
const verifier = resolve(repoRoot, 'scripts/architecture/verify-v3-hub-v1-node-file-topology.mjs');

const fixtures = [
  {
    name: 'mainline builder mapped back to root',
    relative: 'docs/architecture/v3-mainline-call-map.yml',
    from: 'callee_symbol: build_v3_hub_req_inbound_02_from_v3_hub_req_inbound_01, callee_file: v3/crates/routecodex-v3-runtime/src/hub_v1/req_inbound_02_normalized.rs',
    to: 'callee_symbol: build_v3_hub_req_inbound_02_from_v3_hub_req_inbound_01, callee_file: v3/crates/routecodex-v3-runtime/src/hub_v1.rs',
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
    from: 'from_node: V3HubReqOutbound07ProviderSemantic, to_node: ProviderReqCompat06ProviderCompat',
    to: 'from_node: V3HubReqOutbound07ProviderSemantic, to_node: ProviderReqCompat07ProviderCompat',
    diagnostic: /v3-hub-req-07 must remain adjacent|ProviderReqCompat06ProviderCompat/,
  },
  {
    name: 'function map loses node owner truth',
    relative: 'docs/architecture/v3-function-map.yml',
    from: 'node_owner_files:',
    to: 'node_owner_files_removed:',
    diagnostic: /node_owner_files missing|H1 node_owner_files/,
  },
  {
    name: 'verification map drops topology gate',
    relative: 'docs/architecture/v3-verification-map.yml',
    from: '      - npm run verify:v3-hub-v1-node-file-topology',
    to: '      - npm run verify:v3-hub-v1-node-file-topology_REMOVED',
    diagnostic: /required_gates missing npm run verify:v3-hub-v1-node-file-topology/,
  },
];

function copyRequiredTree(root) {
  for (const dir of [
    'docs/architecture',
    'docs/design',
    'v3/crates/routecodex-v3-runtime/src',
    'v3/crates/routecodex-v3-runtime/tests',
  ]) {
    cpSync(resolve(repoRoot, dir), join(root, dir), { recursive: true });
  }
  mkdirSync(dirname(join(root, 'package.json')), { recursive: true });
  cpSync(resolve(repoRoot, 'package.json'), join(root, 'package.json'));
}

const failures = [];
for (const fixture of fixtures) {
  const root = mkdtempSync(join(tmpdir(), 'routecodex-v3-hub-v1-node-file-red-'));
  try {
    copyRequiredTree(root);
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
    const result = spawnSync(process.execPath, [verifier], { cwd: root, encoding: 'utf8' });
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    if (result.status === 0) {
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
