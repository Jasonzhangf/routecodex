#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

const root = process.cwd();
const failures = [];
const requiredProtocols = ['responses', 'anthropic', 'openai_chat', 'gemini'];
const expectedEndpointPatterns = new Map([
  ['responses', ['/v1/responses']],
  ['anthropic', ['/v1/messages']],
  ['openai_chat', ['/v1/chat/completions']],
  ['gemini', ['/v1beta/models/:model/generateContent']],
]);
const implementedProtocols = new Set(['responses', 'anthropic', 'openai_chat']);
const pendingProtocols = new Set(['gemini']);

const files = {
  functionMap: 'docs/architecture/v3-function-map.yml',
  mainlineMap: 'docs/architecture/v3-mainline-call-map.yml',
  resourceMap: 'docs/architecture/v3-resource-operation-map.yml',
  verificationMap: 'docs/architecture/v3-verification-map.yml',
  manifest: 'docs/architecture/manifests/v3.entry_protocol_endpoint_binding.mainline.yml',
  wiki: 'docs/architecture/wiki/v3-entry-protocol-endpoint-binding.md',
  wikiHtml: 'docs/architecture/wiki/html/v3-entry-protocol-endpoint-binding.html',
  wikiLib: 'scripts/architecture/architecture-wiki-lib.mjs',
  packageJson: 'package.json',
  server: 'v3/crates/routecodex-v3-server/src/lib.rs',
  configValidate: 'v3/crates/routecodex-v3-config/src/validate.rs',
  configTypes: 'v3/crates/routecodex-v3-config/src/types.rs',
};

const text = Object.fromEntries(Object.entries(files).map(([key, rel]) => [key, read(rel)]));

requirePackageScript('verify:v3-entry-protocol-endpoint-binding', 'node scripts/architecture/verify-v3-entry-protocol-endpoint-binding.mjs');
requirePackageScript('test:v3-entry-protocol-endpoint-binding-red-fixtures', 'node scripts/tests/v3-entry-protocol-endpoint-binding-red-fixtures.mjs');

for (const [key, rel] of Object.entries(files)) {
  if (!fs.existsSync(abs(rel))) failures.push(`${rel}: missing required ${key} file`);
}

const functionMap = parseYaml(files.functionMap);
const mainlineMap = parseYaml(files.mainlineMap);
const resourceMap = parseYaml(files.resourceMap);
const verificationMap = parseYaml(files.verificationMap);
const manifest = parseYaml(files.manifest);

requireText(text.functionMap, files.functionMap, 'feature_id: v3.entry_protocol_endpoint_binding');
requireText(text.functionMap, files.functionMap, 'v3.entry_protocol.binding_registry');
requireText(text.functionMap, files.functionMap, 'v3.server.endpoint_binding_projection');
requireText(text.functionMap, files.functionMap, 'v3.protocol.pending_projection');
for (const gate of [
  'npm run verify:v3-entry-protocol-endpoint-binding',
  'npm run test:v3-entry-protocol-endpoint-binding-red-fixtures',
]) requireText(text.functionMap, files.functionMap, gate);

requireText(text.resourceMap, files.resourceMap, 'resource_id: v3.entry_protocol.binding_registry');
requireText(text.resourceMap, files.resourceMap, 'resource_id: v3.server.endpoint_binding_projection');
requireText(text.resourceMap, files.resourceMap, 'resource_id: v3.protocol.pending_projection');
for (const forbidden of [
  'may_enter_provider_body: true',
  'may_enter_client_body: true',
]) {
  if (entryBindingResourceSlice(text.resourceMap).includes(forbidden)) {
    failures.push(`${files.resourceMap}: entry protocol binding resources must not enter provider/client body`);
  }
}

requireText(text.mainlineMap, files.mainlineMap, 'chain_id: v3.entry_protocol_endpoint_binding.mainline');
for (const step of ['v3-entry-bind-01', 'v3-entry-bind-02', 'v3-entry-bind-03', 'v3-entry-bind-04']) {
  requireText(text.mainlineMap, files.mainlineMap, `step_id: ${step}`);
  requireText(text.wiki, files.wiki, step);
  requireText(text.manifest, files.manifest, step);
}

requireText(text.verificationMap, files.verificationMap, 'feature_id: v3.entry_protocol_endpoint_binding');
requireText(text.verificationMap, files.verificationMap, 'Gemini pending_not_implemented');
requireText(text.verificationMap, files.verificationMap, 'Server route table config allowed protocols manifest endpoint declarations runtime dispatch must stay consistent');
requireText(text.verificationMap, files.verificationMap, 'Do not claim Gemini runtime implementation live provider compatibility global install restart or production cutover');

requireText(text.wiki, files.wiki, '# V3 Entry Protocol Endpoint Binding');
for (const heading of [
  '## Purpose',
  '## Main Rule',
  '## Binding Matrix',
  '## Mainline',
  '## Review Checklist',
  '## Current Integration Boundary',
]) requireText(text.wiki, files.wiki, heading);
for (const token of [
  'endpoint binding complete',
  'runtime protocol implementation is separate',
  'Gemini pending_not_implemented',
  'live/global/prod not claimed',
]) requireText(text.wiki, files.wiki, token);
requireText(text.wikiHtml, files.wikiHtml, 'V3 Entry Protocol Endpoint Binding');
requireText(text.wikiLib, files.wikiLib, 'v3-entry-protocol-endpoint-binding.md');

verifyManifest(manifest);
verifyMaps(functionMap, mainlineMap, resourceMap, verificationMap);
verifyEntryBindingResourceIsolation(resourceMap);
verifyConfigAllowedProtocols(text.configValidate);
verifyConfigRegistrySource(text.configTypes + '\n' + text.configValidate);
verifyServerSource(text.server, manifest);

if (failures.length) {
  console.error('[verify:v3-entry-protocol-endpoint-binding] failed');
  for (const failure of failures) console.error('- ' + failure);
  process.exit(1);
}

console.log('[verify:v3-entry-protocol-endpoint-binding] ok');

function abs(rel) {
  return path.join(root, rel);
}

function read(rel) {
  try {
    return fs.readFileSync(abs(rel), 'utf8');
  } catch {
    return '';
  }
}

function parseYaml(rel) {
  try {
    return YAML.parse(read(rel));
  } catch (error) {
    failures.push(`${rel}: YAML parse failed: ${error.message}`);
    return {};
  }
}

function requireText(source, owner, phrase) {
  if (!source.includes(phrase)) failures.push(`${owner}: missing ${phrase}`);
}

function requireAnyText(source, owner, phrases, label) {
  if (!phrases.some((phrase) => source.includes(phrase))) {
    failures.push(`${owner}: missing ${label}: expected one of ${phrases.join(', ')}`);
  }
}

function requirePackageScript(name, expectedCommand) {
  try {
    const parsed = JSON.parse(text.packageJson);
    if (parsed.scripts?.[name] !== expectedCommand) {
      failures.push(`${files.packageJson}: script ${name} must be ${expectedCommand}`);
    }
  } catch (error) {
    failures.push(`${files.packageJson}: JSON parse failed: ${error.message}`);
  }
}

function array(value) {
  return Array.isArray(value) ? value : [];
}

function entryBindingResourceSlice(resourceMapText) {
  const start = resourceMapText.indexOf('resource_id: v3.entry_protocol.binding_registry');
  if (start < 0) return '';
  const next = resourceMapText.indexOf('\n  - resource_id:', start + 1);
  return next >= 0 ? resourceMapText.slice(start, next) : resourceMapText.slice(start);
}

function verifyManifest(parsed) {
  if (parsed?.lifecycle_id !== 'v3.entry_protocol_endpoint_binding.mainline') {
    failures.push(`${files.manifest}: lifecycle_id must be v3.entry_protocol_endpoint_binding.mainline`);
  }
  const bindings = array(parsed?.entry_protocol_bindings);
  const byProtocol = new Map(bindings.map((binding) => [binding?.entry_protocol, binding]));
  for (const protocol of requiredProtocols) {
    const binding = byProtocol.get(protocol);
    if (!binding) {
      failures.push(`${files.manifest}: missing required protocol binding ${protocol}`);
      continue;
    }
    const endpointPatterns = array(binding.endpoint_patterns);
    for (const expected of expectedEndpointPatterns.get(protocol) ?? []) {
      if (!endpointPatterns.includes(expected)) {
        failures.push(`${files.manifest}: ${protocol} missing endpoint pattern ${expected}`);
      }
    }
    if (!['direct', 'relay', 'pending_not_implemented'].includes(binding.execution_mode)) {
      failures.push(`${files.manifest}: ${protocol} has invalid execution_mode ${binding.execution_mode}`);
    }
    if (implementedProtocols.has(protocol) && binding.implementation_status !== 'implemented') {
      failures.push(`${files.manifest}: ${protocol} must be implemented in this binding surface`);
    }
    if (pendingProtocols.has(protocol)) {
      if (binding.implementation_status !== 'pending_not_implemented') {
        failures.push(`${files.manifest}: ${protocol} must be explicit pending_not_implemented`);
      }
      if (!binding.pending_owner) {
        failures.push(`${files.manifest}: ${protocol} pending binding must declare pending_owner`);
      }
    } else if (!binding.runtime_owner_symbol || !binding.runtime_owner_path) {
      failures.push(`${files.manifest}: ${protocol} implemented binding must declare runtime owner symbol/path`);
    }
  }
  for (const binding of bindings) {
    if (!requiredProtocols.includes(binding?.entry_protocol)) {
      failures.push(`${files.manifest}: unknown protocol binding ${binding?.entry_protocol}`);
    }
  }
}

function verifyMaps(functionMap, mainlineMap, resourceMap, verificationMap) {
  const feature = array(functionMap?.features).find((item) => item?.feature_id === 'v3.entry_protocol_endpoint_binding');
  if (!feature) failures.push(`${files.functionMap}: feature v3.entry_protocol_endpoint_binding missing`);
  else {
    for (const resource of ['v3.entry_protocol.binding_registry', 'v3.server.endpoint_binding_projection', 'v3.protocol.pending_projection']) {
      if (!array(feature.resource_bindings).includes(resource)) failures.push(`${files.functionMap}: feature missing resource binding ${resource}`);
    }
    for (const gate of [
      'npm run verify:v3-entry-protocol-endpoint-binding',
      'npm run test:v3-entry-protocol-endpoint-binding-red-fixtures',
    ]) {
      if (!array(feature.required_gates).includes(gate)) failures.push(`${files.functionMap}: feature missing required gate ${gate}`);
    }
  }
  const resources = new Set(array(resourceMap?.resources).map((item) => item?.resource_id));
  for (const resource of ['v3.entry_protocol.binding_registry', 'v3.server.endpoint_binding_projection', 'v3.protocol.pending_projection']) {
    if (!resources.has(resource)) failures.push(`${files.resourceMap}: missing resource ${resource}`);
  }
  const chain = array(mainlineMap?.chains).find((item) => item?.chain_id === 'v3.entry_protocol_endpoint_binding.mainline');
  if (!chain) failures.push(`${files.mainlineMap}: chain v3.entry_protocol_endpoint_binding.mainline missing`);
  else {
    for (const step of ['v3-entry-bind-01', 'v3-entry-bind-02', 'v3-entry-bind-03', 'v3-entry-bind-04']) {
      if (!array(chain.edges).some((edge) => edge?.step_id === step)) failures.push(`${files.mainlineMap}: missing edge ${step}`);
    }
  }
  const verification = array(verificationMap?.features).find((item) => item?.feature_id === 'v3.entry_protocol_endpoint_binding');
  if (!verification) failures.push(`${files.verificationMap}: feature v3.entry_protocol_endpoint_binding missing`);
  else {
    for (const gate of [
      'npm run verify:v3-entry-protocol-endpoint-binding',
      'npm run test:v3-entry-protocol-endpoint-binding-red-fixtures',
    ]) {
      if (!array(verification.required_gates).includes(gate)) failures.push(`${files.verificationMap}: feature missing required gate ${gate}`);
    }
  }
}

function verifyEntryBindingResourceIsolation(resourceMap) {
  const resources = new Map(array(resourceMap?.resources).map((item) => [item?.resource_id, item]));
  for (const resourceId of ['v3.entry_protocol.binding_registry', 'v3.server.endpoint_binding_projection', 'v3.protocol.pending_projection']) {
    const resource = resources.get(resourceId);
    if (!resource) continue;
    if (resource.may_enter_provider_body !== false || resource.may_enter_client_body !== false) {
      failures.push(`${files.resourceMap}: ${resourceId} must not enter provider/client body`);
    }
  }
}

function verifyConfigAllowedProtocols(configValidate) {
  const match = configValidate.match(/HUB_V1_ENTRY_PROTOCOLS:\s*\[&str;\s*\d+\]\s*=\s*\[([^\]]+)\]/u);
  if (!match) {
    failures.push(`${files.configValidate}: HUB_V1_ENTRY_PROTOCOLS constant missing`);
    return;
  }
  const protocols = [...match[1].matchAll(/"([^"]+)"/gu)].map((item) => item[1]);
  for (const protocol of requiredProtocols) {
    if (!protocols.includes(protocol)) failures.push(`${files.configValidate}: allowed protocol ${protocol} missing`);
  }
  for (const protocol of protocols) {
    if (!requiredProtocols.includes(protocol)) failures.push(`${files.configValidate}: config allowed protocol ${protocol} lacks entry binding`);
  }
}

function verifyConfigRegistrySource(configSource) {
  for (const token of [
    'V3EntryProtocolBindingAuthoringConfig',
    'V3EntryProtocolBindingManifest',
    'V3EntryProtocolExecutionMode',
    'PendingNotImplemented',
    'compile_entry_protocol_bindings',
    'entry_protocol_binding_for_endpoint',
    'forbidden_reentry_behavior',
    'implemented',
  ]) {
    if (!configSource.includes(token)) failures.push(`routecodex-v3-config: missing registry source token ${token}`);
  }
  for (const token of [
    'runtime_owner_symbol',
    'runtime_owner_path',
    'pending_owner_symbol',
    'pending_owner_path',
  ]) {
    if (!configSource.includes(token)) failures.push(`routecodex-v3-config: missing owner source token ${token}`);
  }
}

function verifyServerSource(server, parsedManifest) {
  const businessRoutes = extractBusinessRoutes(server);
  const manifestEndpoints = new Set(array(parsedManifest?.entry_protocol_bindings).flatMap((binding) => array(binding.endpoint_patterns)));
  for (const route of businessRoutes) {
    if (!manifestEndpoints.has(route)) failures.push(`${files.server}: unbound business endpoint ${route}`);
  }
  for (const endpoint of manifestEndpoints) {
    if (!businessRoutes.has(endpoint)) failures.push(`${files.server}: manifest endpoint ${endpoint} is not exposed by Server`);
  }
  requireAnyText(server, files.server, ['entry_protocol_binding_for_endpoint', 'lookup_v3_entry_protocol_binding'], 'binding registry consumer');
  requireAnyText(server, files.server, ['PendingNotImplemented', 'pending_not_implemented'], 'explicit pending_not_implemented status');
  requireText(server, files.server, 'v3.protocol.pending_projection');
  if (/fn\s+endpoint_protocol\s*\(/u.test(server)) {
    failures.push(`${files.server}: Server duplicates endpoint protocol registry in endpoint_protocol()`);
  }
  if (/if\s+path\s*==\s*"\/v1\/(?:chat\/completions|messages|responses)"/u.test(server) || /let\s+is_responses\s*=\s*path\s*==/u.test(server)) {
    failures.push(`${files.server}: Server dispatcher bypasses entry protocol binding registry with raw path runtime branch`);
  }
  if (/execute_v3_foundation_pending_runtime\s*\(/u.test(server) && !server.includes('pending_not_implemented')) {
    failures.push(`${files.server}: endpoint can fall through to implicit generic foundation pending without explicit binding pending owner`);
  }
}

function extractBusinessRoutes(server) {
  const routes = new Set();
  for (const match of server.matchAll(/\.route\(\s*"([^"]+)"/gu)) {
    const route = match[1];
    if (route === '/v1/models') continue;
    if (route.startsWith('/v1/') || route.startsWith('/v1beta/')) routes.add(route);
  }
  return routes;
}
