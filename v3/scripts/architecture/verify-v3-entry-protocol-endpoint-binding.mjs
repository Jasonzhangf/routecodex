#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const root = process.env.ROUTECODEX_V3_SOURCE_ROOT
  ? path.resolve(process.env.ROUTECODEX_V3_SOURCE_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const failures = [];
const requiredProtocols = ['responses', 'anthropic', 'openai_chat', 'gemini'];
const expectedEndpointPatterns = new Map([
  ['responses', ['/v1/responses']],
  ['anthropic', ['/v1/messages']],
  ['openai_chat', ['/v1/chat/completions']],
  ['gemini', ['/v1beta/models/:model/generateContent']],
]);
const implementedProtocols = new Set(['responses', 'anthropic', 'openai_chat', 'gemini']);
const pendingProtocols = new Set();

const files = {
  functionMap: 'docs/architecture/v3-function-map.yml',
  mainlineMap: 'docs/architecture/v3-mainline-call-map.yml',
  resourceMap: 'docs/architecture/v3-resource-operation-map.yml',
  verificationMap: 'docs/architecture/v3-verification-map.yml',
  manifest: 'docs/architecture/manifests/v3.entry_protocol_endpoint_binding.mainline.yml',
  server: 'v3/crates/routecodex-v3-server/src/lib.rs',
  configValidate: 'v3/crates/routecodex-v3-config/src/validate.rs',
};

const text = Object.fromEntries(Object.entries(files).map(([key, rel]) => [key, read(rel)]));

for (const [key, rel] of Object.entries(files)) {
  if (!fs.existsSync(abs(rel))) failures.push(`${rel}: missing required ${key} file`);
}

const functionMap = parseYaml(files.functionMap);
const mainlineMap = parseYaml(files.mainlineMap);
const resourceMap = parseYaml(files.resourceMap);
const verificationMap = parseYaml(files.verificationMap);
const manifest = parseYaml(files.manifest);

verifyManifest(manifest);
verifyMaps(functionMap, mainlineMap, resourceMap, verificationMap);
verifyEntryBindingResourceIsolation(resourceMap);
verifyConfigAllowedProtocols(text.configValidate);
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

// 并行 worker 用 include!("kernel/xxx.rs") 内联子模块：文本扫描需展开 include 才能看到符号。
function readWithIncludes(rel) {
  let source = read(rel);
  const includePattern = /include!\("([^"]+)"\)/g;
  for (const match of source.matchAll(includePattern)) {
    const includeRel = path.join(path.dirname(rel), match[1]);
    source += '\n' + read(includeRel);
  }
  return source;
}

function parseYaml(rel) {
  try {
    return YAML.parse(read(rel));
  } catch (error) {
    failures.push(`${rel}: YAML parse failed: ${error.message}`);
    return {};
  }
}

function array(value) {
  return Array.isArray(value) ? value : [];
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

function verifyServerSource(server, parsedManifest) {
  const businessRoutes = extractBusinessRoutes(server);
  const manifestEndpoints = new Set(array(parsedManifest?.entry_protocol_bindings).flatMap((binding) => array(binding.endpoint_patterns)));
  for (const route of businessRoutes) {
    // Axum captures model:action as one segment; the configured Gemini matcher
    // admits only declared actions under the existing semantic endpoint.
    const endpoint = route === '/v1beta/models/:model'
      ? '/v1beta/models/:model/generateContent'
      : route;
    if (!manifestEndpoints.has(endpoint)) failures.push(`${files.server}: unbound business endpoint ${route}`);
  }
  for (const endpoint of manifestEndpoints) {
    if (!businessRoutes.has(endpoint)) failures.push(`${files.server}: manifest endpoint ${endpoint} is not exposed by Server`);
  }
  // runtime_owner_symbol 空洞校验：implemented binding 的 symbol 必须在
  // runtime_owner_path 文件中真实定义（防 defaults/validate 声明不存在的函数，
  // 如 openai_chat Direct 曾指向不存在的 execute_v3_openai_chat_direct_server_outcome）。
  for (const binding of array(parsedManifest?.entry_protocol_bindings)) {
    if (
      binding.implementation_status === 'implemented' &&
      binding.runtime_owner_symbol &&
      binding.runtime_owner_path
    ) {
      const ownerSource = readWithIncludes(binding.runtime_owner_path);
      if (!ownerSource) {
        failures.push(
          `${files.manifest}: ${binding.entry_protocol} runtime_owner_path ${binding.runtime_owner_path} is unreadable`,
        );
        continue;
      }
      const escaped = binding.runtime_owner_symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const symbolPattern = new RegExp(
        `(pub\\s+)?(async\\s+)?fn\\s+${escaped}\\s*[<(]`,
        'u',
      );
      if (!symbolPattern.test(ownerSource)) {
        failures.push(
          `${files.manifest}: ${binding.entry_protocol} runtime_owner_symbol ${binding.runtime_owner_symbol} is not defined in ${binding.runtime_owner_path}`,
        );
      }
    }
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
