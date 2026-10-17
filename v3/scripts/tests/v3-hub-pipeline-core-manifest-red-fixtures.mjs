#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import YAML from 'yaml';
import { verifyV3HubPipelineCoreManifests } from '../architecture/verify-v3-hub-pipeline-core-manifests.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const copied = [
  'docs/architecture/manifests/v3.hub_pipeline.v1.request.mainline.yml',
  'docs/architecture/manifests/v3.hub_pipeline.v1.response.mainline.yml',
  'docs/architecture/v3-mainline-call-map.yml',
  'docs/architecture/v3-function-map.yml',
  'docs/architecture/v3-verification-map.yml',
];
function fixture() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-hub-core-manifest-'));
  for (const rel of copied) {
    const target = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(root, rel), target);
  }
  return tmp;
}
const mutations = [
  {
    name: 'missing-request-manifest',
    mutate(tmp) { fs.rmSync(path.join(tmp, 'docs/architecture/manifests/v3.hub_pipeline.v1.request.mainline.yml')); },
    expect: /missing core Hub Pipeline manifest/,
  },
  {
    name: 'request-edge-step-drift',
    mutate(tmp) {
      const rel = 'docs/architecture/manifests/v3.hub_pipeline.v1.request.mainline.yml';
      const file = path.join(tmp, rel);
      const doc = YAML.parse(fs.readFileSync(file, 'utf8'));
      doc.edges[0].step_id = 'v3-hub-req-01-drift';
      fs.writeFileSync(file, YAML.stringify(doc));
    },
    expect: /edge\[0\]\.step_id must match call map/,
  },
  {
    name: 'call-map-manifest-unwired',
    mutate(tmp) {
      const rel = 'docs/architecture/v3-mainline-call-map.yml';
      const file = path.join(tmp, rel);
      const doc = YAML.parse(fs.readFileSync(file, 'utf8'));
      const chain = doc.chains.find((item) => item.chain_id === 'v3.hub_pipeline.v1.request');
      delete chain.manifest;
      fs.writeFileSync(file, YAML.stringify(doc));
    },
    expect: /call map manifest must be docs\/architecture\/manifests\/v3\.hub_pipeline\.v1\.request\.mainline\.yml/,
  },
  {
    name: 'function-map-missing-manifest',
    mutate(tmp) {
      const rel = 'docs/architecture/v3-function-map.yml';
      const file = path.join(tmp, rel);
      const doc = YAML.parse(fs.readFileSync(file, 'utf8'));
      const owner = doc.features.find((row) => row.feature_id === 'v3.hub_pipeline_static_skeleton');
      owner.allowed_paths = owner.allowed_paths.filter((rel) => rel !== 'docs/architecture/manifests/v3.hub_pipeline.v1.response.mainline.yml');
      fs.writeFileSync(file, YAML.stringify(doc));
    },
    expect: /v3-function-map\.yml: owner does not bind docs\/architecture\/manifests\/v3\.hub_pipeline\.v1\.response\.mainline\.yml/,
  },
  {
    name: 'verification-map-missing-manifest',
    mutate(tmp) {
      const rel = 'docs/architecture/v3-verification-map.yml';
      const file = path.join(tmp, rel);
      const doc = YAML.parse(fs.readFileSync(file, 'utf8'));
      const owner = doc.features.find((row) => row.feature_id === 'v3.hub_pipeline_static_skeleton');
      owner.contract = owner.contract.filter((rel) => rel !== 'docs/architecture/manifests/v3.hub_pipeline.v1.request.mainline.yml');
      fs.writeFileSync(file, YAML.stringify(doc));
    },
    expect: /v3-verification-map\.yml: owner does not bind docs\/architecture\/manifests\/v3\.hub_pipeline\.v1\.request\.mainline\.yml/,
  },
];

let failed = 0;
const baseline = fixture();
try {
  assert.deepEqual(verifyV3HubPipelineCoreManifests(baseline), [], 'baseline must be GREEN');
} finally {
  fs.rmSync(baseline, { recursive: true, force: true });
}
for (const mutation of mutations) {
  const tmp = fixture();
  try {
    mutation.mutate(tmp);
    const failures = verifyV3HubPipelineCoreManifests(tmp).join('\n');
    if (!mutation.expect.test(failures)) {
      failed += 1;
      console.error(`[v3-hub-pipeline-core-manifest-red] ${mutation.name}: expected ${mutation.expect}, got:\n${failures || '<no failures>'}`);
    } else {
      console.log(`[v3-hub-pipeline-core-manifest-red] ${mutation.name}: failed as expected`);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

if (failed > 0) process.exit(1);
