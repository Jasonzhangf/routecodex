#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import YAML from 'yaml';

const REQUIRED = [
  {
    chainId: 'v3.hub_pipeline.v1.request',
    manifestPath: 'docs/architecture/manifests/v3.hub_pipeline.v1.request.mainline.yml',
    entryNode: 'V3HubReqInbound01ClientRaw',
    returnNode: 'V3ProviderReqOutbound09TransportRequest',
    mustIncludeNodes: [
      'V3HubReqInbound01ClientRaw',
      'V3HubReqChatProcess04Governed',
      'ProviderReqCompat06ProviderCompat',
      'V3ProviderReqOutbound09TransportRequest',
    ],
  },
  {
    chainId: 'v3.hub_pipeline.v1.response',
    manifestPath: 'docs/architecture/manifests/v3.hub_pipeline.v1.response.mainline.yml',
    entryNode: 'V3ProviderRespInbound01Raw',
    returnNode: 'V3ServerRespOutbound06ClientFrame',
    mustIncludeNodes: [
      'V3ProviderRespInbound01Raw',
      'ProviderRespCompat02ProviderCompat',
      'V3HubRespChatProcess03Governed',
      'V3HubRespContinuation04Committed',
      'V3ServerRespOutbound06ClientFrame',
    ],
  },
];

const REQUIRED_GATES = [
  'npm run verify:v3-hub-pipeline-core-manifests',
  'npm run test:v3-hub-pipeline-core-manifest-red-fixtures',
  'npm run verify:v3-mainline-caller-flow',
  'npm run verify:v3-architecture-docs',
  'git diff --check',
];

export function verifyV3HubPipelineCoreManifests(repoRoot = process.cwd()) {
  const failures = [];
  const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');
  const loadYaml = (rel) => YAML.parse(read(rel)) ?? {};
  const exists = (rel) => fs.existsSync(path.join(repoRoot, rel));

  for (const rel of [
    'docs/architecture/v3-mainline-call-map.yml',
    'docs/architecture/v3-function-map.yml',
    'docs/architecture/v3-verification-map.yml',
    'package.json',
  ]) {
    if (!exists(rel)) failures.push(`${rel}: required source missing`);
  }
  if (failures.length) return failures;

  const callMap = loadYaml('docs/architecture/v3-mainline-call-map.yml');
  const functionMapText = read('docs/architecture/v3-function-map.yml');
  const verificationMapText = read('docs/architecture/v3-verification-map.yml');
  const packageJson = JSON.parse(read('package.json'));
  const scripts = packageJson.scripts ?? {};

  if (!scripts['verify:v3-hub-pipeline-core-manifests']) failures.push('package.json: missing verify:v3-hub-pipeline-core-manifests script');
  if (!scripts['test:v3-hub-pipeline-core-manifest-red-fixtures']) failures.push('package.json: missing test:v3-hub-pipeline-core-manifest-red-fixtures script');

  for (const item of REQUIRED) {
    if (!exists(item.manifestPath)) {
      failures.push(`${item.manifestPath}: missing core Hub Pipeline manifest`);
      continue;
    }
    const manifest = loadYaml(item.manifestPath);
    const chain = (callMap?.chains ?? []).find((candidate) => candidate?.chain_id === item.chainId);
    if (!chain) {
      failures.push(`${item.chainId}: missing chain in v3-mainline-call-map.yml`);
      continue;
    }

    if (chain?.manifest !== item.manifestPath) {
      failures.push(`${item.chainId}: call map manifest must be ${item.manifestPath}`);
    }
    if (manifest?.schema_version !== 1) failures.push(`${item.manifestPath}: schema_version must be 1`);
    if (manifest?.lifecycle_id !== item.chainId) failures.push(`${item.manifestPath}: lifecycle_id must be ${item.chainId}`);
    if (manifest?.owner_feature_id !== chain?.owner_feature_id) failures.push(`${item.manifestPath}: owner_feature_id must match call map`);
    if (manifest?.entrypoint?.call_map_chain_id !== item.chainId) failures.push(`${item.manifestPath}: entrypoint.call_map_chain_id must be ${item.chainId}`);
    if (manifest?.entrypoint?.node_id !== item.entryNode) failures.push(`${item.manifestPath}: entrypoint.node_id must be ${item.entryNode}`);
    if (manifest?.return_path?.node_id !== item.returnNode) failures.push(`${item.manifestPath}: return_path.node_id must be ${item.returnNode}`);

    const edgeNodes = [];
    for (const edge of chain?.edges ?? []) {
      if (!edgeNodes.includes(edge.from_node)) edgeNodes.push(edge.from_node);
      if (!edgeNodes.includes(edge.to_node)) edgeNodes.push(edge.to_node);
    }
    if (JSON.stringify(manifest?.node_ids ?? []) !== JSON.stringify(edgeNodes)) {
      failures.push(`${item.manifestPath}: node_ids must exactly match call-map edge order`);
    }
    for (const node of item.mustIncludeNodes) {
      if (!(manifest?.node_ids ?? []).includes(node)) failures.push(`${item.manifestPath}: missing required node ${node}`);
    }

    const manifestEdges = manifest?.edges ?? [];
    const chainEdges = chain?.edges ?? [];
    if (manifestEdges.length !== chainEdges.length) failures.push(`${item.manifestPath}: edge count must match call map`);
    const edgeCount = Math.min(manifestEdges.length, chainEdges.length);
    for (let index = 0; index < edgeCount; index += 1) {
      const actual = manifestEdges[index] ?? {};
      const expected = chainEdges[index] ?? {};
      for (const key of ['step_id', 'from_node', 'to_node', 'status', 'binding_kind', 'owner_feature_id', 'caller_symbol', 'caller_file', 'callee_symbol', 'callee_file']) {
        if ((actual?.[key] ?? null) !== (expected?.[key] ?? null)) failures.push(`${item.manifestPath}: edge[${index}].${key} must match call map`);
      }
      if (JSON.stringify(actual?.resource_flow ?? null) !== JSON.stringify(expected?.resource_flow ?? null)) {
        failures.push(`${item.manifestPath}: edge[${index}].resource_flow must match call map`);
      }
    }

    for (const doc of manifest?.canonical_docs ?? []) {
      if (!exists(doc)) failures.push(`${item.manifestPath}: canonical doc missing on disk: ${doc}`);
    }
    for (const gate of REQUIRED_GATES) {
      if (!(manifest?.verification_gates ?? []).includes(gate)) failures.push(`${item.manifestPath}: missing required gate ${gate}`);
    }
    for (const gate of manifest?.verification_gates ?? []) {
      const match = String(gate).match(/^npm run ([A-Za-z0-9:_-]+)$/u);
      if (match && !scripts[match[1]]) failures.push(`${item.manifestPath}: npm script missing for gate ${gate}`);
    }
    if (manifest?.completion_boundary?.machine_readable_manifest !== true) failures.push(`${item.manifestPath}: completion_boundary.machine_readable_manifest must be true`);
    if (manifest?.completion_boundary?.source_controlled !== true) failures.push(`${item.manifestPath}: completion_boundary.source_controlled must be true`);
    if (manifest?.completion_boundary?.live_cutover !== false) failures.push(`${item.manifestPath}: completion_boundary.live_cutover must be false`);
    if (manifest?.completion_boundary?.global_install_restart !== false) failures.push(`${item.manifestPath}: completion_boundary.global_install_restart must be false`);
    if (!String(manifest?.completion_boundary?.forbidden_claim ?? '').includes('does not claim provider live behavior')) {
      failures.push(`${item.manifestPath}: completion_boundary.forbidden_claim must explicitly deny provider live behavior`);
    }

    if (!functionMapText.includes(item.manifestPath)) failures.push(`docs/architecture/v3-function-map.yml: missing ${item.manifestPath}`);
    if (!verificationMapText.includes(item.manifestPath)) failures.push(`docs/architecture/v3-verification-map.yml: missing ${item.manifestPath}`);
  }

  return failures;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const failures = verifyV3HubPipelineCoreManifests(process.cwd());
  if (failures.length) {
    console.error('[verify:v3-hub-pipeline-core-manifests] failed');
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
  }
  console.log('[verify:v3-hub-pipeline-core-manifests] ok');
  console.log('- Hub v1 request/response manifests exist and match v3-mainline-call-map.yml');
  console.log('- manifests are wired into function/verification maps and package gates');
}
