#!/usr/bin/env node
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const repo = process.cwd();
const verifier = resolve(repo, 'scripts/architecture/verify-v3-resource-relation-edge-lock.mjs');
const copied = [
  'package.json',
  'docs/architecture/v3-resource-operation-map.yml',
  'docs/architecture/v3-mainline-call-map.yml',
  'docs/architecture/v3-function-map.yml',
  'docs/architecture/v3-verification-map.yml',
  'scripts/architecture/verify-v3-resource-relation-edge-lock.mjs',
  'scripts/tests/v3-resource-relation-edge-lock-red-fixtures.mjs',
];

const cases = [
  {
    name: 'resource map encodes edge field',
    path: 'docs/architecture/v3-resource-operation-map.yml',
    mutate: function(source) {
      return source.replace(
        '    resource_kind: config_authoring\n',
        '    resource_kind: config_authoring\n    resource_edges: [v3.config.file_source -> v3.config.authoring_parsed]\n',
      );
    },
    diagnostic: /resource map must not encode relationship field resource_edges/u,
  },
  {
    name: 'declared resource lacks edge resource_flow use',
    path: 'docs/architecture/v3-resource-operation-map.yml',
    mutate: function(source) {
      return source + '\n  - resource_id: v3.test.unused_resource\n    resource_kind: test_only\n    lifecycle: v3.test\n    owner_crate: routecodex-v3-config\n    owner_node: V3TestUnusedResource\n    identity: [testId]\n    allowed_writers: [test]\n    allowed_readers: [test]\n    forbidden_writers: []\n    may_enter_provider_body: false\n    may_enter_client_body: false\n    binding_status: review_gate\n';
    },
    diagnostic: /resource v3\.test\.unused_resource is not referenced by any mainline edge resource_flow/u,
  },
  {
    name: 'edge references undeclared resource',
    path: 'docs/architecture/v3-mainline-call-map.yml',
    mutate: function(source) {
      return source.replace('consumes: [v3.config.file_source]', 'consumes: [v3.unknown.resource]');
    },
    diagnostic: /undeclared resource v3\.unknown\.resource/u,
  },
  {
    name: 'resource relation moved to edge top level',
    path: 'docs/architecture/v3-mainline-call-map.yml',
    mutate: function(source) {
      return source.replace(
        '        resource_flow:\n          consumes: [v3.config.file_source]',
        '        consumes: [v3.config.file_source]\n        resource_flow:\n          consumes: [v3.config.file_source]',
      );
    },
    diagnostic: /resource relationship field consumes must be nested under resource_flow/u,
  },
  {
    name: 'multi-source shortcut',
    path: 'docs/architecture/v3-mainline-call-map.yml',
    mutate: function(source) {
      return source.replace('from_node: V3Config01FileSource', 'from_node: [V3Config01FileSource, V3Config01OtherSource]');
    },
    diagnostic: /from_node must be one source node string; multiple paths require multiple edges/u,
  },
  {
    name: 'multi-target shortcut',
    path: 'docs/architecture/v3-mainline-call-map.yml',
    mutate: function(source) {
      return source.replace('to_node: V3Config02AuthoringParsed', 'to_node: [V3Config02AuthoringParsed, V3Config02OtherParsed]');
    },
    diagnostic: /to_node must be one target node string; multiple paths require multiple edges/u,
  },
  {
    name: 'plural target shortcut field',
    path: 'docs/architecture/v3-mainline-call-map.yml',
    mutate: function(source) {
      return source.replace(
        '        to_node: V3Config02AuthoringParsed
',
        '        to_node: V3Config02AuthoringParsed
        to_nodes: [V3Config02AuthoringParsed, V3Config02OtherParsed]
',
      );
    },
    diagnostic: /path shortcut field to_nodes is forbidden; multiple callable paths require multiple edges/u,
  },
  {
    name: 'duplicate edge step id',
    path: 'docs/architecture/v3-mainline-call-map.yml',
    mutate: function(source) {
      return source.replace('      - step_id: v3-cfg-02', '      - step_id: v3-cfg-01');
    },
    diagnostic: /duplicate step_id v3-cfg-01/u,
  },
  {
    name: 'same node edge',
    path: 'docs/architecture/v3-mainline-call-map.yml',
    mutate: function(source) {
      return source.replace('to_node: V3Config02AuthoringParsed', 'to_node: V3Config01FileSource');
    },
    diagnostic: /from_node and to_node must differ/u,
  },
  {
    name: 'unknown resource_flow field',
    path: 'docs/architecture/v3-mainline-call-map.yml',
    mutate: function(source) {
      return source.replace(
        '          side_channel_writes: []\n        status: anchored',
        '          side_channel_writes: []\n          relates_to: [v3.config.file_source]\n        status: anchored',
      );
    },
    diagnostic: /unknown resource_flow field relates_to/u,
  },
  {
    name: 'missing resource_flow required field',
    path: 'docs/architecture/v3-mainline-call-map.yml',
    mutate: function(source) {
      return source.replace('          side_channel_reads: []\n          side_channel_writes: []\n        status: anchored', '          side_channel_reads: []\n        status: anchored');
    },
    diagnostic: /resource_flow\.side_channel_writes must be an array/u,
  },
  {
    name: 'function resource binding undeclared',
    path: 'docs/architecture/v3-function-map.yml',
    mutate: function(source) {
      return source.replace('      - v3.config.resource_registry\n      - v3.config.published_manifest', '      - v3.resource.registry_edge\n      - v3.config.published_manifest');
    },
    diagnostic: /resource binding v3\.resource\.registry_edge is not declared in resource map/u,
  },
  {
    name: 'remove resource relation gate feature',
    path: 'docs/architecture/v3-function-map.yml',
    mutate: function(source) {
      return source.replace(/\n  - feature_id: v3\.resource_relation_edge_lock[\s\S]*?(?=\n  - feature_id: |\n?$)/u, '\n');
    },
    diagnostic: /missing feature v3\.resource_relation_edge_lock/u,
  },
  {
    name: 'remove gate from verification map',
    path: 'docs/architecture/v3-verification-map.yml',
    mutate: function(source) {
      return source.replace('      - npm run test:v3-resource-relation-edge-lock-red-fixtures\n', '');
    },
    diagnostic: /missing required gate npm run test:v3-resource-relation-edge-lock-red-fixtures/u,
  },
  {
    name: 'architecture docs script no longer invokes edge lock',
    path: 'package.json',
    mutate: function(source) {
      return source.replace('npm run verify:v3-resource-relation-edge-lock && ', '');
    },
    diagnostic: /script verify:v3-architecture-docs must invoke verify:v3-resource-relation-edge-lock/u,
  },
];

const failures = [];
for (const testCase of cases) {
  const root = mkdtempSync(join(tmpdir(), 'v3-resource-relation-edge-lock-red-'));
  try {
    for (const rel of copied) cpSync(resolve(repo, rel), resolve(root, rel), { recursive: true });
    const target = resolve(root, testCase.path);
    const original = readFileSync(target, 'utf8');
    const mutated = testCase.mutate(original);
    if (mutated === original) {
      failures.push(testCase.name + ': mutation did not change ' + testCase.path);
      continue;
    }
    writeFileSync(target, mutated);
    const result = spawnSync(process.execPath, [verifier], { cwd: root, encoding: 'utf8' });
    const output = (result.stdout || '') + '\n' + (result.stderr || '');
    if (result.status === 0) failures.push(testCase.name + ': verifier unexpectedly passed');
    else if (!testCase.diagnostic.test(output)) failures.push(testCase.name + ': wrong diagnostic: ' + output.slice(-1200));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (failures.length) {
  console.error('[test:v3-resource-relation-edge-lock-red-fixtures] failed');
  for (const failure of failures) console.error('- ' + failure);
  process.exit(1);
}

console.log('[test:v3-resource-relation-edge-lock-red-fixtures] ok (' + cases.length + ' forbidden mutations rejected)');
