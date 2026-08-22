#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { verifyV3HubPipelineCoreManifests } from '../architecture/verify-v3-hub-pipeline-core-manifests.mjs';

const root = process.cwd();
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
    name: 'response-live-cutover-overclaim',
    mutate(tmp) {
      const rel = 'docs/architecture/manifests/v3.hub_pipeline.v1.response.mainline.yml';
      const file = path.join(tmp, rel);
      const doc = YAML.parse(fs.readFileSync(file, 'utf8'));
      doc.completion_boundary.live_cutover = true;
      fs.writeFileSync(file, YAML.stringify(doc));
    },
    expect: /completion_boundary\.live_cutover must be false/,
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
      const text = fs.readFileSync(file, 'utf8').replace(/\n\s*- docs\/architecture\/manifests\/v3\.hub_pipeline\.v1\.response\.mainline\.yml/u, '');
      fs.writeFileSync(file, text);
    },
    expect: /v3-function-map\.yml: missing docs\/architecture\/manifests\/v3\.hub_pipeline\.v1\.response\.mainline\.yml/,
  },
  {
    name: 'verification-map-missing-manifest',
    mutate(tmp) {
      const rel = 'docs/architecture/v3-verification-map.yml';
      const file = path.join(tmp, rel);
      const text = fs.readFileSync(file, 'utf8').replace(/\n\s*- docs\/architecture\/manifests\/v3\.hub_pipeline\.v1\.request\.mainline\.yml/u, '');
      fs.writeFileSync(file, text);
    },
    expect: /v3-verification-map\.yml: missing docs\/architecture\/manifests\/v3\.hub_pipeline\.v1\.request\.mainline\.yml/,
  },
];

let failed = 0;
for (const mutation of mutations) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `v3-hub-core-manifest-${mutation.name}-`));
  try {
    for (const rel of [
      'docs/architecture/manifests',
      'docs/architecture/v3-mainline-call-map.yml',
      'docs/architecture/v3-function-map.yml',
      'docs/architecture/v3-verification-map.yml',
      'docs/architecture/wiki/v3-mainline-skeleton-sop.md',
      'docs/architecture/wiki/v3-mainline-caller-flow.md',
      'docs/design/v3-hub-pipeline-static-skeleton-contract.md',
      'package.json',
    ]) {
      const src = path.join(root, rel);
      const dest = path.join(tmp, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.cpSync(src, dest, { recursive: true });
    }
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
