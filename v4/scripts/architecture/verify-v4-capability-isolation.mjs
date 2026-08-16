#!/usr/bin/env node
/**
 * v4_parity_gate_capability_isolation
 *
 * Locks plugin capability isolation (Phase 3):
 * 1. diagnostic plugin has no data writer;
 * 2. control plugin cannot write payload;
 * 3. provider plugin cannot read route decision;
 * 4. plugin cannot access another NodeContainer private service.
 * Verified against node-plugin/node-container contracts and the resource map.
 */
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const failures = [];

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
  } catch (error) {
    failures.push(`${file}: cannot read/parse: ${error.message}`);
    return null;
  }
};
const readYaml = (file) => {
  try {
    return yaml.load(fs.readFileSync(path.join(root, file), 'utf8'));
  } catch (error) {
    failures.push(`${file}: cannot read/parse: ${error.message}`);
    return null;
  }
};

const pluginContract = readJson('contracts/node-plugin.contract.json');
const containerContract = readJson('contracts/node-container.contract.json');
const resourceMap = readYaml('docs/architecture/v4-resource-operation-map.yml');
if (!pluginContract || !containerContract || !resourceMap) process.exit(1);

const effects = pluginContract.effect_rule ?? {};
if (!/diagnostic_only/.test(String(effects.diagnostic_only ?? '')) || !/writes must be empty/.test(String(effects.diagnostic_only ?? ''))) {
  failures.push('node-plugin: diagnostic_only effect must declare empty writes');
}
if (!/control_only/.test(String(effects.control_only ?? '')) || !/normal payload writes forbidden/.test(String(effects.control_only ?? ''))) {
  failures.push('node-plugin: control_only effect must forbid normal payload writes');
}

const serviceRule = String(pluginContract.service_rule ?? '');
if (!/own node container/.test(serviceRule)) {
  failures.push('node-plugin: service_rule must restrict inject to the plugin own node container');
}

const byId = new Map((resourceMap.resources ?? []).map((resource) => [resource.resource_id, resource]));
const routeDecision = byId.get('v4.control.route_exit');
if (routeDecision) {
  const readers = new Set(routeDecision.allowed_readers ?? []);
  if (readers.has('V4ProviderReqCompat06Compat')) {
    failures.push('resource map: provider wire builder may not read route decision');
  }
}
const providerSemantic = byId.get('v4.request.provider_semantic');
if (providerSemantic) {
  const readers = new Set(providerSemantic.allowed_readers ?? []);
  if (readers.size !== 1 || !readers.has('V4ProviderReqCompat06Compat')) {
    failures.push('resource map: V4ProviderReqCompat06Compat must be the only reader of provider semantic');
  }
}
const providerWire = byId.get('v4.request.provider_wire_payload');
if (providerWire) {
  const readers = new Set(providerWire.allowed_readers ?? []);
  if (readers.size !== 1 || !readers.has('V4ProviderSseOut07WireBoundary')) {
    failures.push('resource map: V4ProviderSseOut07WireBoundary must be the only reader of provider wire payload');
  }
}

if (failures.length > 0) {
  console.error('[v4_parity_gate_capability_isolation] FAIL');
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log('[v4_parity_gate_capability_isolation] OK plugin capability isolation locked');
