#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const v3Root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const root = process.env.ROUTECODEX_V3_SOURCE_ROOT
  ? path.resolve(process.env.ROUTECODEX_V3_SOURCE_ROOT)
  : path.resolve(v3Root, '..');

// Node02 requires request and Error graphs; the response graph remains deferred.
const failures = [];
const requiredGraphs = [
  'docs/architecture/dagpipe/v3.operation_runner.request.graph.json',
  'docs/architecture/dagpipe/v3.operation_runner.error.graph.json',
];
const deferredGraphs = [
  'docs/architecture/dagpipe/v3.operation_runner.response.graph.json',
];
// Iterate mandatory graphs, then any deferred graph present on disk.
function forEachGraph(callback) {
  for (const rel of requiredGraphs) {
    if (fs.existsSync(path.join(root, rel))) callback(rel, false);
    else if (rel === 'docs/architecture/dagpipe/v3.operation_runner.error.graph.json') {
      failures.push('v3.operation_runner.lifecycle.manifest.yml: Node02 required Error graph is missing');
    } else failures.push(`${rel}: required graph missing`);
  }
  for (const rel of deferredGraphs) {
    if (fs.existsSync(path.join(root, rel))) callback(rel, true);
  }
}
const fieldProfilesRel = 'docs/architecture/manifests/v3.operation_runner.field_profiles.v1.yml';
const fieldProfiles = loadYaml(fieldProfilesRel);

function loadYaml(rel) {
  return YAML.parse(fs.readFileSync(path.join(root, rel), 'utf8')) ?? {};
}

function parseTmpGraph(parsed) {
  return parsed;
}

function normalizeArc(contract) {
  return {
    id: contract?.id ?? '',
    schema_ref: contract?.schema_ref ?? '',
    schema: contract?.schema ?? '',
  };
}

const sdkValueTypes = new Set(['Any', 'Null', 'Boolean', 'Number', 'String', 'Array', 'ArrayOf', 'Object']);

function stripEnum(value) {
  return String(value ?? '').replace(/^enum\(|\)$/gu, '').split(',').map((v) => v.trim()).filter(Boolean);
}

function normalizedPath(value) {
  return String(value ?? '').replace(/\[\]/gu, '[]');
}

function ancestorPath(value) {
  return normalizedPath(value).replace(/\[\]/gu, '.');
}

function collectTypedOperatorProfiles(fieldProfiles, failures) {
  const profiles = fieldProfiles?.binding_contract?.typed_operator_profiles ?? {};
  const result = new Map();
  for (const [operatorKey, directions] of Object.entries(profiles)) {
    if (!operatorKey.includes('@')) {
      failures.push(`binding_contract typed_operator_profiles key ${operatorKey} must be operator@version`);
      continue;
    }
    for (const [direction, params] of Object.entries(directions ?? {})) {
      if (!['client_request_to_chat', 'chat_to_provider', 'provider_response_to_chat', 'chat_to_client_response'].includes(direction)) {
        failures.push(`binding_contract typed_operator_profiles ${operatorKey} has unknown direction ${direction}`);
      }
      if (params?.direction || params?.direction_bindings) {
        failures.push(`binding_contract typed_operator_profiles ${operatorKey}:${direction} has direction as an operator param; direction is a binding axis only`);
      }
      const key = `${operatorKey}:${direction}`;
      result.set(key, params ?? {});
    }
  }
  const tableResourceOperators = new Set([
    'routecodex.v3.field.role_value_map@1',
    'routecodex.v3.field.usage_value_map@1',
    'routecodex.v3.field.tool_choice_value_map@1',
    'routecodex.v3.field.finish_reason_value_map@1',
    'routecodex.v3.field.part_type_value_map@1',
    'routecodex.v3.field.request_field_whitelist@1',
    'routecodex.v3.field.parallel_tool_calls_value_map@1',
  ]);
  for (const [key, params] of result) {
    const [operatorKey] = key.split(':');
    if (tableResourceOperators.has(operatorKey) && !params?.table) {
      failures.push(`binding_contract typed_operator_profiles ${key} must declare a table runtime resource`);
    }
  }
  return result;
}

function profileParamsFor(profiles, operatorKey, direction) {
  return profiles.get(`${operatorKey}:${direction}`);
}

function checkTypedParams(profile, params, failures, label) {
  if (!profile) return;
  const allowed = new Set(Object.keys(profile));
  for (const [name, expected] of Object.entries(profile)) {
    const value = params?.[name];
    if (expected === 'resource' || String(expected).startsWith('resource(')) {
      continue;
    }
    if (value === undefined || value === null || value === '') {
      failures.push(`${label} missing typed param ${name}`);
      continue;
    }
    if (typeof value === 'number') continue;
    if (typeof value !== 'string') {
      failures.push(`${label} param ${name} is not typed (${typeof value}: ${value})`);
      continue;
    }
    if (!expected) continue;
    if (expected === 'string' || expected === 'typed' || expected === 'set' || expected === 'resource') {
      if (!value.trim()) failures.push(`${label} param ${name} must be non-empty`);
      continue;
    }
    if (/^enum\(/u.test(expected)) {
      const allowed = stripEnum(expected);
      const actual = stripEnum(value);
      if (allowed.length && !actual.some((item) => allowed.includes(item))) {
        failures.push(`${label} param ${name} value ${value} not allowed by profile ${expected}`);
      }
      continue;
    }
  }
  for (const [name] of Object.entries(params ?? {})) {
    if (['source', 'destination', 'operator'].includes(name)) continue;
    if (!allowed.has(name)) {
      failures.push(`${label} has unexpected param ${name} not allowed by profile`);
    }
  }
}

function collectFieldOperators(fieldProfiles, failures) {
  const nodes = fieldProfiles?.operator_registry?.field_operators
    ?? fieldProfiles?.field_operator_library?.nodes
    ?? [];
  const byKey = new Map();
  for (const entry of nodes) {
    const key = `${entry?.operator}@${entry?.operator_version ?? ''}`;
    if (!entry?.operator || !entry?.operator_version) {
      failures.push('field_operator_library entry missing operator@operator_version');
      continue;
    }
    if (byKey.has(key)) failures.push(`field_operator_library duplicate entry ${key}`);
    for (const [param, value] of Object.entries(entry?.params ?? {})) {
      if (typeof value === 'number') continue;
      if (typeof value !== 'string') {
        failures.push(`field_operator_library ${key} parameter ${param} is not typed (${typeof value})`);
      }
    }
    if (entry?.params && Object.keys(entry.params).length > 0) {
      failures.push(`operator_registry.field_operators ${key} must not carry params; typed_operator_profiles is the unique field-operator schema truth`);
    }
    byKey.set(key, entry);
  }
  return byKey;
}

function loadArcSchemaRegistry(fieldProfiles, failures) {
  const registry = new Map();
  for (const entry of fieldProfiles?.arc_schema_registry?.schemas ?? []) {
    const id = entry?.id;
    const schema = entry?.schema;
    if (!id || !schema) {
      failures.push(`arc_schema_registry entry missing id or schema`);
      continue;
    }
    if (registry.has(id)) failures.push(`duplicate arc_schema_registry entry ${id}`);
    if (!sdkValueTypes.has(schema)) {
      failures.push(`arc_schema_registry ${id} schema ${schema} is not a DAGpipe SDK ValueType`);
    }
    registry.set(id, schema);
  }
  return registry;
}

const requestGraphRel = 'docs/architecture/dagpipe/v3.operation_runner.request.graph.json';
forEachGraph((rel) => {
  const full = path.join(root, rel);
  const parsed = JSON.parse(fs.readFileSync(full, 'utf8'));
  const registry = loadArcSchemaRegistry(fieldProfiles, failures);
  const rawJsonArcRefs = new Map([
    ['source-request', 'v3.operation_runner.arc.source_request'],
    ['client-json', 'v3.operation_runner.arc.client_json'],
  ]);
  const rawJsonArc = (arc) => rel === requestGraphRel
    && rawJsonArcRefs.get(arc?.id) === arc?.schema_ref;
  for (const input of parsed.inputs ?? []) {
    if (!registry.has(input?.schema_ref ?? '')) {
      failures.push(`${rel}: input ARC ${input?.id ?? ''} schema_ref ${input?.schema_ref ?? ''} not in project arc_schema_registry`);
    } else if (registry.get(input.schema_ref) !== input.schema) {
      failures.push(`${rel}: input ARC ${input.id} inline schema does not match arc_schema_registry`);
    }
  }
  for (const node of parsed.nodes ?? []) {
    if (!registry.has(node?.output?.schema_ref ?? '')) {
      failures.push(`${rel}: node ${node?.id ?? ''} output ARC schema_ref ${node?.output?.schema_ref ?? ''} not in project arc_schema_registry`);
    } else if (registry.get(node.output.schema_ref) !== node.output.schema) {
      failures.push(`${rel}: node ${node.id} output ARC inline schema does not match arc_schema_registry`);
    }
  }
  for (const node of parsed.nodes ?? []) {
    if (!node.operator || !node.operator_version) {
      failures.push(`${rel}: node ${node.id} missing operator or operator_version`);
    }
    if (!node.output?.schema_ref) {
      failures.push(`${rel}: node ${node.id} output ARC ${node.output?.id ?? ''} missing schema_ref`);
    }
    if (!node.output?.schema || (node.output.schema === 'Any' && !rawJsonArc(node.output))) {
      failures.push(`${rel}: node ${node.id} output ARC ${node.output?.id ?? ''} uses generic Any schema`);
    }
  }
  for (const input of parsed.inputs ?? []) {
    if (!input.schema_ref) failures.push(`${rel}: input ARC ${input.id} missing schema_ref`);
    if (!input.schema || (input.schema === 'Any' && !rawJsonArc(input))) failures.push(`${rel}: input ARC ${input.id} uses generic Any schema`);
  }
  const r = spawnSync('dagpipe', ['graph', 'validate', rel], {
    cwd: root,
    encoding: 'utf8',
  });
  if (r.status !== 0) {
    failures.push(`${rel}: dagpipe graph validate failed\n${r.stdout}\n${r.stderr}`);
  }
});

const resourceMap = YAML.parse(fs.readFileSync(path.join(root, 'docs/architecture/v3-resource-operation-map.yml'), 'utf8'));
const mainlineMap = YAML.parse(fs.readFileSync(path.join(root, 'docs/architecture/v3-mainline-call-map.yml'), 'utf8'));
const verificationMap = YAML.parse(fs.readFileSync(path.join(root, 'docs/architecture/v3-verification-map.yml'), 'utf8'));
const semanticMatrix = loadYaml('docs/architecture/reviews/v3-protocol-semantic-field-matrix.yml');

function buildSourcePathIndex() {
  const byProtocol = new Map();
  const byNormalized = new Map();
  for (const protocol of Object.keys(semanticMatrix?.source_inventory ?? {})) {
    const exact = new Set();
    const normalized = new Set();
    const normProtocol = protocol === 'openai_chat_extension' ? 'openai_chat' : protocol;
    for (const rows of Object.values(semanticMatrix.source_inventory[protocol] ?? {})) {
      if (!Array.isArray(rows)) continue;
      for (const sourcePath of rows) {
        if (!String(sourcePath ?? '').trim()) continue;
        exact.add(`${protocol}:${sourcePath}`);
        normalized.add(`${normProtocol}:${normalizedPath(sourcePath)}`);
      }
    }
    byProtocol.set(protocol, { exact, normalized });
    for (const value of normalized) {
      byNormalized.set(value, protocol);
    }
  }
  return { byProtocol, byNormalized };
}
const sourcePathIndex = buildSourcePathIndex();

function sourcePathExists(protocol, sourcePath) {
  const info = sourcePathIndex.byProtocol.get(protocol);
  if (info?.exact.has(`${protocol}:${sourcePath}`)) return true;
  return sourcePathIndex.byNormalized.has(`${normalizedProtocol(protocol)}:${normalizedPath(sourcePath)}`);
}

if (fieldProfiles.contract_id !== 'v3.operation_runner.field_profiles') {
  failures.push(`${fieldProfilesRel}: contract_id must be v3.operation_runner.field_profiles`);
}
if (fieldProfiles.business_unmatched_value?.operator !== 'routecodex.v3.field.lossless_preserve@1'
  || fieldProfiles.business_unmatched_value?.value_owner !== 'chat_extension_opaque_record'
  || fieldProfiles.business_unmatched_value?.inverse_reference_owner !== 'typed_request_inverse_context_or_response_provenance'
  || fieldProfiles.business_unmatched_value?.preserve !== 'original_path_value_encoding_and_inverse_association'
  || fieldProfiles.business_unmatched_value?.admission !== 'continue_request_or_response'
  || fieldProfiles.business_unmatched_value?.projection !== 'return_to_same_client_protocol_without_semantic_rewrite') {
  failures.push(`${fieldProfilesRel}: unmatched business values must preserve the original value and inverse association without local rejection`);
}
for (const [key, referenceOwner] of [
  ['unrepresentable_request', 'request inverse context'],
  ['unrepresentable_response', 'response provenance'],
]) {
  const contract = String(fieldProfiles.field_walker?.error_contract?.[key] ?? '');
  if (!contract.includes('chat_extension_opaque_record') || !contract.includes(referenceOwner)
    || !contract.includes('typed reference')) {
    failures.push(`${fieldProfilesRel}: ${key} must keep business value in the Chat extension and only a typed reference in ${referenceOwner}`);
  }
}
if (!String(fieldProfiles.runtime_failure_class_rule ?? '').includes('cannot trigger that class by itself')) {
  failures.push(`${fieldProfilesRel}: business shape mismatch must not trigger local failure_class`);
}
for (const oldPolicy of ['reject_ambiguous_multi_system_without_inverse', 'reject_conflicting_max_output_tokens', 'explicit_fail_if_target_cannot_represent']) {
  if (JSON.stringify(fieldProfiles).includes(oldPolicy)) failures.push(`${fieldProfilesRel}: obsolete local business rejection policy ${oldPolicy}`);
}

const operatorRegistry = new Map();
const fieldOperatorLibrary = collectFieldOperators(fieldProfiles, failures);
const typedOperatorProfiles = collectTypedOperatorProfiles(fieldProfiles, failures);
const arcSchemaRegistry = loadArcSchemaRegistry(fieldProfiles, failures);
const allowedParamTypes = new Set(['string', 'enum', 'resource', 'typed', 'number', 'set', 'preserve', '598', '599', '502']);
for (const entry of fieldProfiles?.operator_registry?.nodes ?? []) {
  const key = `${entry?.operator}@${entry?.operator_version ?? ''}`;
  if (!entry?.operator || !entry?.operator_version) failures.push(`${fieldProfilesRel}: operator_registry entry missing operator@operator_version`);
  if (operatorRegistry.has(key)) failures.push(`${fieldProfilesRel}: duplicate operator registry entry ${key}`);
  for (const [param, value] of Object.entries(entry?.params ?? {})) {
    if (typeof value === 'number') continue;
    if (typeof value !== 'string' || !allowedParamTypes.has(value)) {
      failures.push(`${fieldProfilesRel}: operator ${key} parameter ${param} is not a typed parameter (${typeof value})`);
    }
  }
  operatorRegistry.set(key, entry);
}

const seenArcRefs = new Set();
forEachGraph((rel) => {
  const parsed = JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'));
  for (const input of parsed.inputs ?? []) {
    const key = input.schema_ref ?? '';
    if (!key) continue;
    if (seenArcRefs.has(key)) failures.push(`${rel}: duplicate schema_ref ${key}`);
    seenArcRefs.add(key);
  }
  for (const node of parsed.nodes ?? []) {
    const key = node.output?.schema_ref ?? '';
    if (!key) continue;
    if (seenArcRefs.has(key)) failures.push(`${rel}: duplicate schema_ref ${key}`);
    seenArcRefs.add(key);
  }
});

forEachGraph((rel) => {
  const parsed = JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'));
  for (const node of parsed.nodes ?? []) {
    const opKey = `${node.operator}@${node.operator_version}`;
    if (!operatorRegistry.has(opKey)) {
      failures.push(`${rel}: node ${node.id} operator ${opKey} not in field profile operator_registry`);
    }
  }
});

for (const row of fieldProfiles?.path_consumers ?? []) {
  for (const [direction, operatorKey] of Object.entries(row?.consumers ?? {})) {
    if (!fieldOperatorLibrary.has(operatorKey)) {
      failures.push(`path_consumers ${row?.protocol ?? ''}.${row?.section ?? ''}.${row?.path ?? ''} direction ${direction} uses ${operatorKey} which is not a registered field_operator_library entry`);
    }
  }
}
for (const row of fieldProfiles?.extension_path_consumers ?? []) {
  for (const [direction, operatorKey] of Object.entries(row?.consumers ?? {})) {
    if (!fieldOperatorLibrary.has(operatorKey)) {
      failures.push(`extension_path_consumers path ${row?.path ?? ''} direction ${direction} uses ${operatorKey} which is not a registered field_operator_library entry`);
    }
  }
}

const inverseOperator = fieldProfiles?.request_inverse_contract?.inverse_operator;
if (fieldProfiles?.request_inverse_contract?.inverse_method !== 'inverse_to_entry'
  || !inverseOperator || !fieldOperatorLibrary.has(inverseOperator)) {
  failures.push(`${fieldProfilesRel}: request inverse_to_entry operator must be registered`);
}
const forwardRequestOperators = new Set();
for (const row of [
  ...(fieldProfiles?.path_consumers ?? []),
  ...(fieldProfiles?.extension_path_consumers ?? []),
]) {
  const operator = row?.consumers?.client_request_to_chat ?? row?.scalar_consumer?.client_request_to_chat;
  if (operator) forwardRequestOperators.add(operator);
}
for (const operator of forwardRequestOperators) {
  if (fieldOperatorLibrary.get(operator)?.inverse_to_entry !== inverseOperator) {
    failures.push(`${fieldProfilesRel}: configured forward request operator ${operator} must declare registered inverse_to_entry ${inverseOperator}`);
  }
}

const normalizedProtocol = (protocol) => protocol === 'openai_chat_extension' ? 'openai_chat' : protocol;
const standardBindingKeys = new Set();
for (const row of fieldProfiles?.path_consumers ?? []) {
  standardBindingKeys.add(`${normalizedProtocol(row?.protocol)}:${normalizedPath(row?.path)}`);
}
for (const row of fieldProfiles?.extension_path_consumers ?? []) {
  const key = `${normalizedProtocol(row?.protocol)}:${normalizedPath(row?.path)}`;
  if (standardBindingKeys.has(key)) {
    // Standard inventory is the consumption truth. The extension row is an
    // extended-superset provenance alias for the same normalized path and is
    // intentionally excluded from per-direction consumption checks below.
  }
}

const bindingContract = fieldProfiles?.binding_contract;
if (!bindingContract) {
  failures.push(`${fieldProfilesRel}: missing binding_contract`);
} else {
  const directionNames = new Set(['client_request_to_chat', 'chat_to_provider', 'provider_response_to_chat', 'chat_to_client_response']);
  for (const binding of bindingContract?.direction_bindings ?? []) {
    const direction = binding?.direction ?? '';
    if (!directionNames.has(direction)) failures.push(`${fieldProfilesRel}: binding_contract direction_bindings has unknown direction ${direction}`);
    for (const key of ['source', 'destination', 'operator', 'typed_params']) {
      if (!binding?.[key]) failures.push(`${fieldProfilesRel}: binding_contract direction ${direction} missing ${key}`);
    }
    const operatorKey = binding?.operator;
    if (operatorKey && !fieldOperatorLibrary.has(operatorKey)) {
      failures.push(`${fieldProfilesRel}: binding_contract direction ${direction} operator ${operatorKey} is not a registered field_operator_library entry`);
    }
    const params = binding?.typed_params ?? {};
  }
}

for (const [inventory, rows] of [
  ['path_consumers', fieldProfiles?.path_consumers ?? []],
  ['extension_path_consumers', fieldProfiles?.extension_path_consumers ?? []],
]) {
  for (const row of rows) {
    const label = `${inventory} ${row?.protocol ?? ''}:${row?.section ?? ''}:${row?.path ?? ''}`;
    if (row?.structure_only === true && row?.parent_owned !== true) {
      failures.push(`${fieldProfilesRel}: ${label} structure_only row must set parent_owned true`);
    }
    if (row?.parent_owned === true && row?.structure_only === true && Object.keys(row?.consumers ?? {}).length === 0) continue;
    for (const [direction, operatorKey] of Object.entries(row?.consumers ?? {})) {
      const params = row?.params ?? {};
      if (Object.prototype.hasOwnProperty.call(params, 'direction')) {
        failures.push(`${fieldProfilesRel}: ${label} uses static params.direction instead of runner-injected direction; remove it from row params`);
      }
      const hasDirectionOverride = Object.prototype.hasOwnProperty.call(params, 'direction')
        || Object.prototype.hasOwnProperty.call(params, 'direction_bindings');
      const profile = profileParamsFor(typedOperatorProfiles, operatorKey, direction);
      if (!profile) {
        failures.push(`${fieldProfilesRel}: ${label} direction ${direction} operator ${operatorKey} has no typed_operator_profile`);
        continue;
      }
      if (row?.structure_only === true && Object.keys(row?.consumers ?? {}).length > 0) {
        failures.push(`${fieldProfilesRel}: ${label} structure_only row must not declare consumers`);
      }
      const bindings = row?.params?.direction_bindings;
      if (bindings) {
        for (const [bindingDirection, binding] of Object.entries(bindings)) {
          const key = `${label} direction_binding ${bindingDirection}`;
          for (const required of ['source', 'destination', 'operator']) {
            if (!binding?.[required]) failures.push(`${fieldProfilesRel}: ${key} missing ${required}`);
          }
          if (binding?.operator !== row?.consumers?.[bindingDirection]) {
            failures.push(`${fieldProfilesRel}: ${key} operator ${binding?.operator ?? ''} must match consumers.${bindingDirection} ${row?.consumers?.[bindingDirection] ?? ''}`);
          }
          checkTypedParams(profile, binding, failures, `${fieldProfilesRel}: ${key}`);
        }
        if (!bindings[direction]) {
          failures.push(`${fieldProfilesRel}: ${label} direction ${direction} missing direction_binding for operator ${operatorKey}`);
        }
      } else {
        checkTypedParams(profile, params, failures, `${fieldProfilesRel}: ${label} direction ${direction} operator ${operatorKey}`);
      }
    }
  }
}

const allRows = [
  ...(fieldProfiles?.path_consumers ?? []).map((row) => ({ ...row, inventory: 'path_consumers' })),
  ...(fieldProfiles?.extension_path_consumers ?? []).map((row) => ({ ...row, inventory: 'extension_path_consumers' })),
];
for (const direction of ['client_request_to_chat', 'chat_to_provider', 'provider_response_to_chat', 'chat_to_client_response']) {
  const rows = allRows.filter((row) => row?.consumers?.[direction] && row?.structure_only !== true);
  for (const row of rows) {
    const key = `${normalizedProtocol(row.protocol)}:${normalizedPath(row.path)}`;
    if (standardBindingKeys.has(key) && row.inventory === 'extension_path_consumers') continue;
    const parent = rows.find((candidate) => {
      if (candidate === row) return false;
      if (normalizedProtocol(candidate.protocol) !== normalizedProtocol(row.protocol)) return false;
      if (candidate.structure_only === true) return false;
      return ancestorPath(row.path).startsWith(`${ancestorPath(candidate.path)}.`);
    });
    if (parent) {
      failures.push(`${fieldProfilesRel}: parent-child overlap direction ${direction} parent ${parent.path} and child ${row.path}; parent must be structure_only or must not have descendant consumers`);
    }
  }
}

const toolPayloadPaths = new Set();
for (const entry of fieldProfiles?.field_walker?.opaque_tool_payload_paths ?? []) {
  if (!entry?.protocol || !entry?.section || !entry?.path) {
    failures.push(`${fieldProfilesRel}: field_walker.opaque_tool_payload_paths entry missing protocol/section/path`);
    continue;
  }
  toolPayloadPaths.add(`${entry.protocol}:${entry.section}:${entry.path}`);
}
for (const row of allRows) {
  const key = `${row?.protocol}:${row?.section}:${row?.path}`;
  const usesOpaque = ['client_request_to_chat', 'chat_to_provider', 'provider_response_to_chat', 'chat_to_client_response'].some(
    (direction) => row?.consumers?.[direction] === 'routecodex.v3.field.opaque_tool_payload@1',
  );
  if (usesOpaque && !toolPayloadPaths.has(key)) {
    failures.push(`${fieldProfilesRel}: ${key} uses opaque_tool_payload@1 but is not classified in field_walker.opaque_tool_payload_paths`);
  }
  if (row?.structure_only === true) continue;
  if (!toolPayloadPaths.has(key)) continue;
  for (const direction of ['client_request_to_chat', 'chat_to_provider', 'provider_response_to_chat', 'chat_to_client_response']) {
    const operatorKey = row?.consumers?.[direction];
    if (!operatorKey) continue;
    if (operatorKey !== 'routecodex.v3.field.opaque_tool_payload@1') {
      failures.push(`${fieldProfilesRel}: opaque tool path ${row.protocol}:${row.path} direction ${direction} must use routecodex.v3.field.opaque_tool_payload@1, got ${operatorKey}`);
    }
  }
}
for (const key of toolPayloadPaths) {
  if (!allRows.some((row) => `${row?.protocol}:${row?.section}:${row?.path}` === key)) {
    failures.push(`${fieldProfilesRel}: classified opaque_tool_payload_paths ${key} has no path_consumer binding`);
  }
}

for (const ref of seenArcRefs) {
  if (!arcSchemaRegistry.has(ref)) {
    failures.push(`${fieldProfilesRel}: graph schema_ref ${ref} has no arc_schema_registry entry`);
  }
}

const requestDirections = new Set(['client_request_to_chat', 'chat_to_provider']);
const responseDirections = new Set(['provider_response_to_chat', 'chat_to_client_response']);
function requiredDirections(section) {
  return section === 'response_fields' || section === 'output_fields'
    ? responseDirections
    : requestDirections;
}

const allShapeRows = [];
for (const row of fieldProfiles?.path_consumers ?? []) {
  allShapeRows.push({ ...row, inventory: 'path_consumers' });
}
for (const row of fieldProfiles?.extension_path_consumers ?? []) {
  allShapeRows.push({ ...row, inventory: 'extension_path_consumers' });
}
const shapeToken = (paramsValue) => String(paramsValue ?? '')
  .replace(/^enum\(|\)$/gu, '')
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean);
const structureOnlyContainers = new Set(['object', 'array', 'array_item']);
function validateShapeChildren(row, required) {
  const key = `${row.protocol}:${row.section}:${row.path}`;
  const parentKind = row.union_shape === true ? 'union parent' : 'shape parent';
  const children = Array.isArray(row.shape_children) ? row.shape_children : [];
  if (row.union_shape === true && !children.length) {
    failures.push(`${fieldProfilesRel}: union parent ${key} must declare shape_children`);
  }
  for (const childPath of children) {
    const childKey = `${row.protocol}:${row.section}:${childPath}`;
    if (!sourcePathExists(row.protocol, childPath)) {
      failures.push(`${fieldProfilesRel}: ${parentKind} ${key} shape_children references unknown source inventory path ${childPath}`);
    }
    const child = allRows.find(
      (candidate) => candidate?.protocol === row.protocol && candidate?.path === childPath,
    );
    if (!child) {
      failures.push(`${fieldProfilesRel}: ${parentKind} ${key} missing shape_children row ${childKey}`);
      continue;
    }
    if (row.union_shape === true && !child.structure_only && child.parent_owned === true) {
      failures.push(`${fieldProfilesRel}: union child ${childKey} must set parent_owned false`);
    }
    if (!ancestorPath(childPath).startsWith(`${ancestorPath(row.path)}.`)) {
      failures.push(`${fieldProfilesRel}: ${parentKind} child ${childKey} must be under parent ${row.path}`);
    }
    if (child.structure_only) continue;
    for (const direction of required) {
      if (!child.consumers?.[direction]) {
        failures.push(`${fieldProfilesRel}: ${parentKind} child ${childKey} missing consumer direction ${direction}`);
      }
    }
  }
}

for (const row of allShapeRows) {
  const key = `${row?.protocol ?? ''}:${row?.section ?? ''}:${row?.path ?? ''}`;
  if (row?.structure_only !== true) continue;
  const params = row?.params ?? {};
  const shapes = shapeToken(params.shape);
  if (!shapes.length) continue;
  const required = row.direction === 'response'
    ? responseDirections
    : row.direction === 'request'
      ? requestDirections
      : requiredDirections(row.section);
  if (row?.union_shape === true) {
    if (!shapes.includes('leaf') || !shapes.some((shape) => structureOnlyContainers.has(shape))) {
      failures.push(`${fieldProfilesRel}: union parent ${key} params.shape must include leaf and an object/array container shape`);
    }
    for (const direction of required) {
      if (!row.scalar_consumer?.[direction]) {
        failures.push(`${fieldProfilesRel}: union parent ${key} missing scalar_consumer direction ${direction}`);
      } else if (!fieldOperatorLibrary.has(row.scalar_consumer[direction])) {
        failures.push(`${fieldProfilesRel}: union parent ${key} scalar_consumer ${row.scalar_consumer[direction]} is not a registered field_operator_library entry`);
      }
    }
  } else {
    const hasNonContainer = shapes.some((shape) => !structureOnlyContainers.has(shape));
    if (hasNonContainer) {
      failures.push(`${fieldProfilesRel}: structure_only row ${key} params.shape ${params.shape} must be object/array/array_item`);
    }
  }
  if (row.union_shape === true || Array.isArray(row.shape_children)) {
    validateShapeChildren(row, required);
  }
}

for (const row of allShapeRows) {
  if (row?.structure_only !== true || row?.union_shape !== true) continue;
  const key = `${row.protocol || ''}:${row.section || ''}:${row.path || ''}`;
  const shapes = shapeToken(row.params?.shape);
  const children = new Set(Array.isArray(row.shape_children) ? row.shape_children : []);
  const parentAncestor = ancestorPath(row.path);
  for (const rows of Object.values(semanticMatrix?.source_inventory?.[row.protocol] ?? {})) {
    if (!Array.isArray(rows)) continue;
    for (const sourcePath of rows) {
      if (!String(sourcePath ?? '').trim()) continue;
      if (sourcePath === row.path) continue;
      if (!ancestorPath(sourcePath).startsWith(`${parentAncestor}.`)) continue;
      if (children.has(sourcePath)) continue;
      const objectSegmentChild = !sourcePath.includes('[]') && shapes.includes('object');
      failures.push(
        `${fieldProfilesRel}: union parent ${key} missing required ${objectSegmentChild ? 'object shape' : 'shape'} child ${sourcePath}`,
      );
    }
  }
}

const requiredResponseItemDiscriminatorPaths = new Set([
  'request.input[].id',
  'request.input[].role',
  'request.input[].content',
  'request.input[].status',
  'request.input[].phase',
  'request.input[].text',
  'request.input[].arguments',
  'request.input[].call_id',
  'request.input[].name',
  'request.input[].output',
  'request.input[].input',
  'response.output[].id',
  'response.output[].role',
  'response.output[].content',
  'response.output[].phase',
  'response.output[].status',
  'response.output[].text',
  'response.output[].arguments',
  'response.output[].call_id',
  'response.output[].name',
  'response.output[].output',
  'response.output[].input',
]);
for (const row of allShapeRows) {
  if (row?.protocol !== 'responses') continue;
  if (row.section === 'input_fields' && requiredResponseItemDiscriminatorPaths.has(row.path)) {
    if (!row.typed_discriminator_cases) {
      failures.push(`${fieldProfilesRel}: responses:${row.section}:${row.path} must declare typed_discriminator_cases with discriminator_path request.input[].type`);
    }
  }
  if (row.section === 'output_fields' && requiredResponseItemDiscriminatorPaths.has(row.path)) {
    if (!row.typed_discriminator_cases) {
      failures.push(`${fieldProfilesRel}: responses:${row.section}:${row.path} must declare typed_discriminator_cases with discriminator_path response.output[].type`);
    }
  }
  const contentPartDiscriminator = row.section === 'input_fields'
    && row.path.startsWith('request.input[].content[].')
    ? 'request.input[].content[].type'
    : row.section === 'output_fields'
      && row.path.startsWith('response.output[].content[].')
      ? 'response.output[].content[].type'
      : undefined;
  if (contentPartDiscriminator && row.path !== contentPartDiscriminator) {
    if (!row.typed_discriminator_cases) {
      failures.push(`${fieldProfilesRel}: responses:${row.section}:${row.path} must declare typed_discriminator_cases with discriminator_path ${contentPartDiscriminator}`);
    } else if (row.typed_discriminator_cases.discriminator_path !== contentPartDiscriminator) {
      failures.push(`${fieldProfilesRel}: responses:${row.section}:${row.path} content-part path ${row.path} must use discriminator_path ${contentPartDiscriminator}`);
    }
  }
  validateTypedDiscriminator(row);
}

function validateTypedDiscriminator(row) {
  const d = row?.typed_discriminator_cases;
  if (!d) return;
  const key = `${row.protocol || ''}:${row.section || ''}:${row.path || ''}`;
  if (!d.discriminator_path) {
    failures.push(`${fieldProfilesRel}: ${key} typed_discriminator_cases missing discriminator_path`);
    return;
  }
  if (!sourcePathExists(row.protocol, d.discriminator_path)) {
    failures.push(`${fieldProfilesRel}: ${key} discriminator_path ${d.discriminator_path} is not in source inventory`);
  }
  if (!Array.isArray(d.cases) || d.cases.length === 0) {
    failures.push(`${fieldProfilesRel}: ${key} typed_discriminator_cases must declare non-empty cases`);
    return;
  }
  const seen = new Set();
  const seenBranches = new Set();
  for (const branch of d.cases) {
    if (!branch?.type_value || !branch?.semantic_id || !branch?.operator) {
      failures.push(`${fieldProfilesRel}: ${key} typed_discriminator_cases branch missing type_value/semantic_id/operator`);
      continue;
    }
    if (seen.has(branch.type_value) && JSON.stringify(branch.predicates ?? []) === JSON.stringify(d.cases.find((item) => item?.type_value === branch.type_value)?.predicates ?? [])) {
      failures.push(`${fieldProfilesRel}: ${key} typed_discriminator_cases duplicate type_value without distinct predicates ${branch.type_value}`);
    }
    seen.add(branch.type_value);
    const branchKey = JSON.stringify({
      type_value: branch.type_value,
      semantic_id: branch.semantic_id,
      operator: branch.operator,
      predicates: branch.predicates ?? [],
    });
    if (seenBranches.has(branchKey)) {
      failures.push(`${fieldProfilesRel}: ${key} typed_discriminator_cases duplicate branch ${branch.type_value}`);
    }
    seenBranches.add(branchKey);
    if (!fieldOperatorLibrary.has(branch.operator)) {
      failures.push(`${fieldProfilesRel}: ${key} typed_discriminator_cases operator ${branch.operator} is not a registered field_operator_library entry`);
    }
    for (const [direction, operatorKey] of Object.entries(row.consumers ?? {})) {
      if (operatorKey && branch.operator !== operatorKey) {
        failures.push(`${fieldProfilesRel}: ${key} typed_discriminator_cases operator ${branch.operator} must match consumers.${direction} ${operatorKey}`);
      }
    }
    validateTypedDiscriminatorPredicates(row, key, d, branch);
  }
  validateTypedDiscriminatorRequiredPredicates(row, key, d);
}

function validateTypedDiscriminatorPredicates(row, key, d, branch) {
  const predicates = branch?.predicates;
  if (predicates === undefined) return;
  if (!Array.isArray(predicates) || predicates.length === 0) {
    failures.push(`${fieldProfilesRel}: ${key} typed_discriminator_cases branch ${branch.type_value} must declare non-empty predicates`);
    return;
  }
  const pathIndex = new Map();
  for (const predicate of predicates) {
    if (!predicate || typeof predicate !== 'object') {
      failures.push(`${fieldProfilesRel}: ${key} typed_discriminator_cases predicate must be an object`);
      continue;
    }
    if (!predicate.path) {
      failures.push(`${fieldProfilesRel}: ${key} typed_discriminator_cases predicate missing path`);
      continue;
    }
    if (!sourcePathExists(row.protocol, predicate.path)) {
      failures.push(`${fieldProfilesRel}: ${key} typed_discriminator_cases predicate path ${predicate.path} is not in source inventory`);
    }
    const hasState = Object.prototype.hasOwnProperty.call(predicate, 'state');
    const hasValue = Object.prototype.hasOwnProperty.call(predicate, 'value');
    if (!hasValue && !hasState) {
      failures.push(`${fieldProfilesRel}: ${key} typed_discriminator_cases predicate path ${predicate.path} must declare exactly one of value, state: missing, or state: present`);
      continue;
    }
    if (hasValue) {
      if (typeof predicate.value !== 'string' || predicate.value.trim() === '') {
        failures.push(`${fieldProfilesRel}: ${key} typed_discriminator_cases predicate path ${predicate.path} value must be a non-empty string`);
      }
      if (hasState) {
        failures.push(`${fieldProfilesRel}: ${key} typed_discriminator_cases predicate path ${predicate.path} must not mix value with state`);
      }
    } else {
      if (predicate.state !== 'missing' && predicate.state !== 'present') {
        failures.push(`${fieldProfilesRel}: ${key} typed_discriminator_cases predicate path ${predicate.path} state must be missing or present`);
      }
    }
    if (pathIndex.has(predicate.path)) {
      failures.push(`${fieldProfilesRel}: ${key} typed_discriminator_cases branch ${branch.type_value} duplicates predicate path ${predicate.path}`);
    }
    pathIndex.set(predicate.path, predicate);
  }
}

function hasPredicate(predicates, expectedPath, expectedState, expectedValue) {
  return predicates?.some((predicate) => {
    if (predicate?.path !== expectedPath) return false;
    if (expectedState !== undefined && predicate?.state !== expectedState) return false;
    if (expectedValue !== undefined && predicate?.value !== expectedValue) return false;
    return true;
  });
}

function validateTypedDiscriminatorRequiredPredicates(row, key, d) {
  if (row.protocol === 'responses' && row.section === 'input_fields' && row.path === 'request.input[].role') {
    if (!d.cases.some((branch) => branch?.type_value === 'message' && hasPredicate(branch.predicates, 'request.input[].type', 'missing'))) {
      failures.push(`${fieldProfilesRel}: ${key} typed_discriminator_cases missing branch predicate request.input[].type state missing`);
    }
  }
  if (row.protocol === 'responses' && row.section === 'input_fields' && row.path === 'request.input[].content[].text') {
    const reasoningBranch = d.cases.find((branch) => branch?.type_value === 'reasoning_text');
    if (!reasoningBranch || !hasPredicate(reasoningBranch.predicates, 'request.input[].type', undefined, 'reasoning')) {
      failures.push(`${fieldProfilesRel}: ${key} typed_discriminator_cases branch reasoning_text must require parent predicate request.input[].type value reasoning`);
    }
  }
}

const nullBehaviorValues = new Set(['preserve_null']);
const requiredNullBehavior = new Map([
  ['responses:request_fields:request.input', 'preserve_null'],
  ['openai_chat:message_fields:request.messages[].content', 'preserve_null'],
  ['anthropic:content_block_fields:request.messages[].content', 'preserve_null'],
]);

for (const row of allShapeRows) {
  if (row?.structure_only !== true || row?.union_shape !== true) continue;
  const key = `${row.protocol || ''}:${row.section || ''}:${row.path || ''}`;
  const params = row.params ?? {};
  if (row.null_behavior !== undefined) {
    const tokens = shapeToken(row.null_behavior);
    if (tokens.length !== 1 || !nullBehaviorValues.has(tokens[0])) {
      failures.push(`${fieldProfilesRel}: union parent ${key} null_behavior ${row.null_behavior} must be enum(preserve_null)`);
    }
  }
  const expectedNull = requiredNullBehavior.get(key);
  if (expectedNull) {
    const tokens = shapeToken(row.null_behavior);
    if (tokens.length !== 1 || tokens[0] !== expectedNull) {
      failures.push(`${fieldProfilesRel}: union parent ${key} must declare null_behavior enum(${expectedNull}) matching codec evidence`);
    }
  }
  const required = row.direction === 'response'
    ? responseDirections
    : row.direction === 'request'
      ? requestDirections
      : requiredDirections(row.section);
  for (const direction of required) {
    const opKey = row.scalar_consumer?.[direction];
    const profile = opKey ? profileParamsFor(typedOperatorProfiles, opKey, direction) : undefined;
    if (profile) {
      const allowed = shapeToken(profile.shape);
      const rowShapes = shapeToken(params.shape);
      if (allowed.length && !rowShapes.every((shape) => allowed.includes(shape))) {
        failures.push(`${fieldProfilesRel}: union parent ${key} scalar_consumer ${opKey} profile shape ${profile.shape} does not accept declared shape ${params.shape}`);
      }
    }
  }
}

for (const row of allShapeRows) {
  if (row?.structure_only !== true || row?.union_shape !== true) continue;
  const key = `${row.protocol || ''}:${row.section || ''}:${row.path || ''}`;
  const children = new Set(Array.isArray(row.shape_children) ? row.shape_children : []);
  for (const candidate of allShapeRows) {
    if (candidate === row) continue;
    if (candidate.protocol !== row.protocol || candidate.section !== row.section) continue;
    if (!ancestorPath(candidate.path).startsWith(`${ancestorPath(row.path)}.`)) continue;
    if (!children.has(candidate.path)) {
      failures.push(`${fieldProfilesRel}: union parent ${key} shape_children missing child row ${candidate.protocol}:${candidate.section}:${candidate.path}`);
    }
  }
}

function expectedAnthropicContentDiscriminator(row) {
  if (row.protocol !== 'anthropic' || row.structure_only === true) return undefined;
  if (row.section === 'content_block_fields' && row.path.startsWith('request.messages[].content[].')) {
    return 'request.messages[].content[].type';
  }
  if (row.section === 'response_fields' && row.path.startsWith('response.content[].')) {
    return 'response.content[].type';
  }
  return undefined;
}

for (const row of allShapeRows) {
  const discriminatorPath = expectedAnthropicContentDiscriminator(row);
  if (!discriminatorPath || row.path === discriminatorPath) continue;
  const key = `${row.protocol || ''}:${row.section || ''}:${row.path || ''}`;
  if (!row.typed_discriminator_cases) {
    failures.push(`${fieldProfilesRel}: anthropic:${row.section}:${row.path} must declare typed_discriminator_cases with discriminator_path ${discriminatorPath}`);
  } else if (row.typed_discriminator_cases.discriminator_path !== discriminatorPath) {
    failures.push(`${fieldProfilesRel}: anthropic:${row.section}:${row.path} must use discriminator_path ${discriminatorPath}`);
  }
}
const anthropicSignature = allShapeRows.find((row) => row.protocol === 'anthropic'
  && row.section === 'response_fields' && row.path === 'response.content[].signature');
const signatureCases = anthropicSignature?.typed_discriminator_cases?.cases ?? [];
if (signatureCases.length !== 1 || signatureCases[0]?.type_value !== 'thinking'
    || !signatureCases[0]?.predicates?.some((predicate) => predicate.path === 'response.content[].type'
      && predicate.value === 'thinking')) {
  failures.push(`${fieldProfilesRel}: Anthropic response.content[].signature must be limited to thinking blocks`);
}

const hostedToolCases = [
  ['content_block_fields', 'request.messages[].content[].input', 'server_tool_use'],
  ['content_block_fields', 'request.messages[].content[].tool_use_id', 'web_search_tool_result'],
  ['response_fields', 'response.content[].id', 'server_tool_use'],
  ['response_fields', 'response.content[].name', 'server_tool_use'],
  ['response_fields', 'response.content[].input', 'server_tool_use'],
  ['response_fields', 'response.content[].tool_use_id', 'web_search_tool_result'],
  ['response_fields', 'response.content[].content', 'web_search_tool_result'],
];
for (const [section, path, typeValue] of hostedToolCases) {
  const row = allShapeRows.find((item) => item.protocol === 'anthropic'
    && item.section === section && item.path === path);
  const discriminatorPath = section === 'response_fields'
    ? 'response.content[].type' : 'request.messages[].content[].type';
  const hasCase = row?.typed_discriminator_cases?.discriminator_path === discriminatorPath
    && row.typed_discriminator_cases.cases?.some((entry) => entry.type_value === typeValue
      && entry.predicates?.some((predicate) => predicate.path === discriminatorPath
        && predicate.value === typeValue));
  if (!hasCase) {
    failures.push(`${fieldProfilesRel}: Anthropic hosted tool ${path} must accept ${typeValue}`);
  }
}

const anthropicSourcePath = 'request.messages[].content[].source';
const anthropicContentType = 'request.messages[].content[].type';
const anthropicSourceType = `${anthropicSourcePath}.type`;
const anthropicSourceTypeRow = allShapeRows.find((item) => item.protocol === 'anthropic'
  && item.section === 'content_block_fields' && item.path === anthropicSourceType);
for (const [contentType, sourceType] of [
  ['image', 'url'], ['image', 'base64'], ['document', 'url'], ['document', 'base64'],
]) {
  if (!anthropicSourceTypeRow?.typed_discriminator_cases?.cases?.some((item) =>
    item.type_value === contentType
    && item.predicates?.some((predicate) => predicate.path === anthropicContentType && predicate.value === contentType)
    && item.predicates?.some((predicate) => predicate.path === anthropicSourceType && predicate.value === sourceType))) {
    failures.push(`${fieldProfilesRel}: Anthropic source.type must distinguish ${contentType}/${sourceType}`);
  }
}
const anthropicMediaBranches = [
  ['url', 'image', 'url', 'request.messages[].content[].image_url.url'],
  ['data', 'image', 'base64', 'request.messages[].content[].media.inline_data'],
  ['media_type', 'image', 'base64', 'request.messages[].content[].media.mime_type'],
  ['data', 'document', 'base64', 'request.messages[].content[].file.file_data'],
  ['media_type', 'document', 'base64', 'request.messages[].content[].media.mime_type'],
];
for (const [member, contentType, sourceType, semanticId] of anthropicMediaBranches) {
  const path = `${anthropicSourcePath}.${member}`;
  const row = allShapeRows.find((item) => item.protocol === 'anthropic'
    && item.section === 'content_block_fields' && item.path === path);
  const branch = row?.typed_discriminator_cases?.cases?.find((item) => item.type_value === contentType
    && item.semantic_id === semanticId
    && item.predicates?.some((predicate) => predicate.path === anthropicContentType && predicate.value === contentType)
    && item.predicates?.some((predicate) => predicate.path === anthropicSourceType && predicate.value === sourceType));
  if (!branch) {
    failures.push(`${fieldProfilesRel}: Anthropic media ${path} must map ${contentType}/${sourceType} to ${semanticId}`);
  }
}
for (const [member, contentType, sourceType, forbiddenSemantic] of [
  ['url', 'image', 'url', 'request.messages[].content[].media.inline_data'],
  ['data', 'image', 'base64', 'request.messages[].content[].image_url.url'],
  ['data', 'document', 'base64', 'request.messages[].content[].media.inline_data'],
]) {
  const path = `${anthropicSourcePath}.${member}`;
  const row = allShapeRows.find((item) => item.protocol === 'anthropic'
    && item.section === 'content_block_fields' && item.path === path);
  const wrongBranch = row?.typed_discriminator_cases?.cases?.some((item) => item.type_value === contentType
    && item.semantic_id === forbiddenSemantic
    && item.predicates?.some((predicate) => predicate.path === anthropicSourceType && predicate.value === sourceType));
  if (wrongBranch) {
    failures.push(`${fieldProfilesRel}: Anthropic media ${path} must not map ${contentType}/${sourceType} to ${forbiddenSemantic}`);
  }
}

const parallelToolCandidates = new Set([
  'request.parallel_tool_calls',
  'response.parallel_tool_calls',
  'request.tool_choice.disable_parallel_tool_use',
]);
const identityToolCandidates = new Set([
  'request.tool_choice.name',
  'request.tool_choice.function.name',
  'response.tool_choice.name',
  'response.tool_choice.function.name',
  'request.toolConfig.functionCallingConfig.allowedFunctionNames',
  'request.tool_choice.allowed_function_names',
]);
for (const row of allShapeRows) {
  const key = `${row?.protocol ?? ''}:${row?.section ?? ''}:${row?.path ?? ''}`;
  if (parallelToolCandidates.has(row.path)) {
    if (row.protocol === 'openai_chat' && row.path === 'request.parallel_tool_calls') continue;
    for (const [direction, operatorKey] of Object.entries(row.consumers ?? {})) {
      if (operatorKey !== 'routecodex.v3.field.parallel_tool_calls_value_map@1') {
        failures.push(`${fieldProfilesRel}: ${key} direction ${direction} must use routecodex.v3.field.parallel_tool_calls_value_map@1, got ${operatorKey}`);
        continue;
      }
      if (row.path === 'request.tool_choice.disable_parallel_tool_use') {
        if (!shapeToken(row.params?.inverse_boolean).includes('true')) {
          failures.push(`${fieldProfilesRel}: ${key} inverse_boolean must be enum(true)`);
        }
      } else if (!shapeToken(row.params?.inverse_boolean).includes('false')) {
        failures.push(`${fieldProfilesRel}: ${key} inverse_boolean must be enum(false)`);
      }
    }
  }
  if (identityToolCandidates.has(row.path)) {
    for (const [direction, operatorKey] of Object.entries(row.consumers ?? {})) {
      if (operatorKey !== 'routecodex.v3.field.tool_identity_context@1') {
        failures.push(`${fieldProfilesRel}: ${key} direction ${direction} must use routecodex.v3.field.tool_identity_context@1, got ${operatorKey}`);
      }
    }
  }
}

const pathBindings = new Map();
const pathBindingsByNormalized = new Map();
const extensionPathBindings = new Map();

for (const row of fieldProfiles?.path_consumers ?? []) {
  if (!row?.protocol || !row?.section || !row?.path) {
    failures.push(`${fieldProfilesRel}: path_consumers row missing protocol/section/path`);
    continue;
  }
  const key = `${row.protocol}:${row.section}:${row.path}`;
  if (pathBindings.has(key)) failures.push(`${fieldProfilesRel}: duplicate path_consumer binding ${key}`);
  const normalizedKey = `${normalizedProtocol(row.protocol)}:${normalizedPath(row.path)}`;
  if (pathBindingsByNormalized.has(normalizedKey)) {
    failures.push(`${fieldProfilesRel}: duplicate normalized path_consumer binding ${normalizedKey}`);
  }
  pathBindingsByNormalized.set(normalizedKey, row);
  if (row?.structure_only !== true) {
    for (const direction of requiredDirections(row.section)) {
      if (!row.consumers?.[direction]) {
        failures.push(`${fieldProfilesRel}: path_consumer binding ${key} missing required consumer direction ${direction}`);
      }
    }
    const allowed = requiredDirections(row.section);
    for (const direction of Object.keys(row.consumers ?? {})) {
      if (!allowed.has(direction)) {
        failures.push(`${fieldProfilesRel}: path_consumer binding ${key} declares wrong direction ${direction} for section ${row.section}`);
      }
    }
  }
  pathBindings.set(key, row);
}

for (const row of fieldProfiles?.extension_path_consumers ?? []) {
  if (!row?.path || !row?.protocol || !row?.section) {
    failures.push(`${fieldProfilesRel}: extension_path_consumers row missing path/protocol/section`);
    continue;
  }
  const key = `${row.protocol}:${row.section}:${row.path}`;
  if (extensionPathBindings.has(key)) failures.push(`${fieldProfilesRel}: duplicate extension path_consumer binding ${key}`);
  extensionPathBindings.set(key, row);
}

const sourceInventory = semanticMatrix?.source_inventory ?? {};
const anthropicBlockTypes = new Set([
  'text', 'image', 'document', 'tool_use', 'tool_result', 'thinking',
  'redacted_thinking', 'server_tool_use', 'web_search_tool_result',
  'web_fetch_tool_result', 'code_execution_tool_result',
  'bash_code_execution_tool_result', 'text_editor_code_execution_tool_result',
  'tool_search_tool_result', 'container_upload', 'mid_conv_system',
]);
function isSyntheticAnthropicBlockPath(pathValue) {
  const prefix = 'request.messages[].content[].';
  if (!String(pathValue).startsWith(prefix)) return false;
  const suffix = String(pathValue).slice(prefix.length);
  const firstDot = suffix.indexOf('.');
  return firstDot >= 0 && anthropicBlockTypes.has(suffix.slice(0, firstDot));
}
for (const pathValue of sourceInventory?.anthropic?.content_block_fields ?? []) {
  if (isSyntheticAnthropicBlockPath(pathValue)) {
    failures.push(`${fieldProfilesRel}: Anthropic raw source path ${pathValue} contains a synthetic block-type segment`);
  }
}
for (const row of allShapeRows) {
  if (row.protocol !== 'anthropic' || row.section !== 'content_block_fields') continue;
  for (const pathValue of [row.path, ...(row.shape_children ?? [])]) {
    if (isSyntheticAnthropicBlockPath(pathValue)) {
      failures.push(`${fieldProfilesRel}: Anthropic path_consumer ${pathValue} contains a synthetic block-type segment`);
    }
  }
}
const matrixProtocols = new Set(Object.keys(sourceInventory));
const sourcePathKeys = new Set();
const sourcePathKeysByNormalized = new Map();
for (const protocol of ['responses', 'openai_chat', 'anthropic', 'gemini']) {
  const sections = sourceInventory[protocol] ?? {};
  for (const [section, rows] of Object.entries(sections)) {
    if (!Array.isArray(rows) || rows.length === 0) continue;
    for (const row of rows) {
      if (!String(row ?? '').trim()) continue;
      const pathKey = `${protocol}:${section}:${row}`;
      sourcePathKeys.add(pathKey);
      const normalized = `${normalizedProtocol(protocol)}:${normalizedPath(row)}`;
      if (!sourcePathKeysByNormalized.has(normalized)) sourcePathKeysByNormalized.set(normalized, []);
      sourcePathKeysByNormalized.get(normalized).push(pathKey);
      if (!pathBindings.has(pathKey) && ![...pathBindings.values()].some((binding) => normalizedProtocol(binding.protocol) === normalizedProtocol(protocol) && normalizedPath(binding.path) === normalizedPath(row) && binding.structure_only !== true)) {
        failures.push(`${fieldProfilesRel}: matrix path ${pathKey} has no path_consumer binding`);
      }
    }
  }
}

for (const row of allShapeRows) {
  if (row?.structure_only !== true || row?.union_shape !== true) continue;
  const parentProtocol = normalizedProtocol(row.protocol);
  const parentSection = row.section;
  const children = new Set(Array.isArray(row.shape_children) ? row.shape_children : []);
  const parentAncestor = ancestorPath(row.path);
  for (const protocol of ['responses', 'openai_chat', 'anthropic', 'gemini']) {
    if (normalizedProtocol(protocol) !== parentProtocol) continue;
    const sections = sourceInventory[protocol] ?? {};
    for (const [section, rows] of Object.entries(sections)) {
      if (section !== parentSection) continue;
      if (!Array.isArray(rows)) continue;
      for (const sourcePath of rows) {
        if (!String(sourcePath ?? '').trim()) continue;
        if (!ancestorPath(sourcePath).startsWith(`${parentAncestor}.`)) continue;
        if (!children.has(sourcePath)) {
          failures.push(`${fieldProfilesRel}: union parent ${parentProtocol}:${parentSection}:${row.path} missing source inventory child row ${protocol}:${section}:${sourcePath}`);
        }
      }
    }
  }
}

for (const row of fieldProfiles?.path_consumers ?? []) {
  const key = `${row?.protocol}:${row?.section}:${row?.path}`;
  const isDuplicateSectionAlias = sourcePathKeysByNormalized.has(`${normalizedProtocol(row?.protocol)}:${normalizedPath(row?.path)}`);
  if (!sourcePathKeys.has(key) && !isDuplicateSectionAlias) {
    const overlapping = [...sourcePathKeys].some((sourceKey) => sourceKey.startsWith(`${key}.`));
    const detail = overlapping ? ` overlaps a proven matrix path without a source row` : ` has no matrix source row`;
    failures.push(`${fieldProfilesRel}: unknown path_consumer binding ${key}${detail}`);
  }
}

for (const fold of fieldProfiles?.fold_contract?.registered_folds ?? []) {
  const targetProtocol = fold?.params?.target_protocol;
  if (targetProtocol) {
    const raw = String(targetProtocol);
    const protocolNames = raw.startsWith('enum(') && raw.endsWith(')')
      ? raw.slice('enum('.length, -1).split(',').map((p) => p.trim())
      : [raw];
    for (const name of protocolNames) {
      if (!matrixProtocols.has(name) && !allowedParamTypes.has(name)) {
        failures.push(`${fieldProfilesRel}: fold ${fold.operator}@${fold.operator_version} mixes unknown target protocol ${name}`);
      }
    }
  }
}

const extensionSuperset = semanticMatrix?.extended_openai_chat_semantic_superset;
const extensionSourcePathKeys = new Set();
const standardByNormalized = new Map();
for (const row of fieldProfiles?.path_consumers ?? []) {
  const key = `${normalizedProtocol(row.protocol)}:${normalizedPath(row.path)}`;
  if (!standardByNormalized.has(key)) standardByNormalized.set(key, row);
}
if (extensionSuperset && Array.isArray(extensionSuperset.fields)) {
  for (const field of extensionSuperset.fields) {
    const pathKey = `openai_chat_extension:extended_superset:${field.extended_openai_chat_field ?? ''}`;
    if (!pathKey.endsWith(':')) extensionSourcePathKeys.add(pathKey);
    if (!field?.direction) continue;
    if (field.mapping_status === 'edge_only' || field.direction === 'edge') continue;
    if (!extensionPathBindings.has(pathKey)) {
      failures.push(`${fieldProfilesRel}: extended superset field ${field.extended_openai_chat_field ?? ''} has no extension_path_consumer binding`);
    }
  }
}

for (const row of fieldProfiles?.extension_path_consumers ?? []) {
  const key = `${row?.protocol}:${row?.section}:${row?.path}`;
  if (!extensionSourcePathKeys.has(key)) {
    failures.push(`${fieldProfilesRel}: unknown extension_path_consumer binding ${key} has no extended superset source row`);
  }
  const normalizedKey = `${normalizedProtocol(row.protocol)}:${normalizedPath(row.path)}`;
  const standardTarget = standardByNormalized.get(normalizedKey);
  if (standardTarget && !row?.alias_of) {
    failures.push(`${fieldProfilesRel}: extension row ${key} duplicates standard binding; set alias_of to ${standardTarget.protocol}:${standardTarget.path}`);
    continue;
  }
  if (row?.alias_of) {
    const target = standardTarget;
    if (!target) {
      failures.push(`${fieldProfilesRel}: extension alias ${key} alias_of points to missing standard binding ${row.alias_of}`);
      continue;
    }
    if (row.alias_of !== `${target.protocol}:${target.path}`) {
      failures.push(`${fieldProfilesRel}: extension alias ${key} alias_of ${row.alias_of} must equal standard binding ${target.protocol}:${target.path}`);
      continue;
    }
    if (Object.keys(row.consumers ?? {}).length > 0) {
      failures.push(`${fieldProfilesRel}: extension alias ${key} must not declare consumers`);
    }
    continue;
  }
  if (standardByNormalized.has(normalizedKey)) {
    const target = standardByNormalized.get(normalizedKey);
    const mismatch = ['client_request_to_chat', 'chat_to_provider', 'provider_response_to_chat', 'chat_to_client_response'].filter((direction) => {
      const ext = row.consumers?.[direction];
      const std = target.consumers?.[direction];
      return ext || std ? ext !== std : false;
    });
    if (mismatch.length) {
      failures.push(`${fieldProfilesRel}: extension alias ${key} duplicates standard binding with different operators for ${mismatch.join(',')}`);
    }
  }
}

const foldOperators = (fieldProfiles?.fold_contract?.registered_folds ?? []).map((fold) => `${fold.operator}@${fold.operator_version}`);
for (const fold of foldOperators) {
  if (!operatorRegistry.has(fold) && !fieldOperatorLibrary.has(fold)) {
    failures.push(`${fieldProfilesRel}: fold ${fold} not in operator_registry or field_operator_library`);
  }
}
for (const fold of fieldProfiles?.fold_contract?.registered_folds ?? []) {
  if (!fold?.finalize_operator || !fold?.finalize_position) {
    failures.push(`${fieldProfilesRel}: fold ${fold?.operator}@${fold?.operator_version} must declare one finalize operator and position`);
    continue;
  }
  const finalizeKey = fold.finalize_operator;
  if (!operatorRegistry.has(finalizeKey) && !fieldOperatorLibrary.has(finalizeKey)) {
    failures.push(`${fieldProfilesRel}: fold ${fold.operator}@${fold.operator_version} finalize_operator ${finalizeKey} not in operator_registry or field_operator_library`);
  }
}

const lifecycleManifest = loadYaml('docs/architecture/manifests/v3.operation_runner.lifecycle.manifest.yml');
if (lifecycleManifest.field_profiles !== fieldProfilesRel) {
  failures.push(`v3.operation_runner.lifecycle.manifest.yml: field_profiles must be ${fieldProfilesRel}`);
}
if (!lifecycleManifest.field_walker_contract) failures.push('v3.operation_runner.lifecycle.manifest.yml: missing field_walker_contract');
const node02SliceRel = 'docs/architecture/dagpipe/v3.operation_runner.request.normalize_request_losslessly.graph.json';
const node02ErrorGraphRel = 'docs/architecture/dagpipe/v3.operation_runner.error.graph.json';
const node02Failure = lifecycleManifest.node02_failure_handoff;
const node02Slice = JSON.parse(fs.readFileSync(path.join(root, node02SliceRel), 'utf8'));
const node02ErrorGraph = fs.existsSync(path.join(root, node02ErrorGraphRel))
  ? JSON.parse(fs.readFileSync(path.join(root, node02ErrorGraphRel), 'utf8'))
  : { inputs: [], nodes: [] };
if (node02Failure?.source_graph !== node02SliceRel
  || node02Failure?.source_node !== 'normalize_request_losslessly'
  || node02Failure?.runtime_result !== 'typed_source_failure'
  || node02Failure?.error_input_arc !== 'source-failure'
  || node02Failure?.error_graph !== node02ErrorGraphRel
  || node02Failure?.error_entry_node !== 'error_err01_source_raised'
  || node02Failure?.owner !== 'RuntimeRequestGraphEntry'
  || node02Slice.outputs?.length !== 1
  || node02Slice.outputs[0] !== 'canonical-request'
  || !node02Slice.nodes?.some((node) => node.id === node02Failure?.source_node)
  || !node02ErrorGraph.inputs?.some((input) => input.id === node02Failure?.error_input_arc)
  || !node02ErrorGraph.nodes?.some((node) => node.id === node02Failure?.error_entry_node
    && node.inputs?.includes(node02Failure?.error_input_arc))) {
  failures.push('v3.operation_runner.lifecycle.manifest.yml: Node02 typed source failure must hand off from the single-sink request slice to ErrorErr01');
}

const resourceIds = new Set((resourceMap.resources ?? []).map((r) => r.resource_id));
for (const id of [
  'v3.operation_runner.dagpipe_manifest',
  'v3.operation_runner.operator_registry',
  'v3.operation_runner.execution_mode',
  'v3.operation_runner.request_inverse_context',
  'v3.operation_runner.attempt_projection_context',
  'v3.operation_runner.tool_thinking_turn_context',
  'v3.operation_runner.response_tool_binding',
  'v3.operation_runner.metadata_center_control',
]) {
  if (!resourceIds.has(id)) failures.push(`missing resource ${id}`);
}

const chainIds = new Set((mainlineMap.chains ?? []).map((c) => c.chain_id));
// Request chain is mandatory for Node 01; response and error chains are
// deferred design targets checked only when their graph is present.
if (!chainIds.has('v3.operation_runner.dagpipe.request')) {
  failures.push('missing mainline chain v3.operation_runner.dagpipe.request');
}
for (const id of ['v3.operation_runner.dagpipe.response', 'v3.operation_runner.dagpipe.error']) {
  if (chainIds.has(id)) continue;
  const graphRel = id === 'v3.operation_runner.dagpipe.response'
    ? 'docs/architecture/dagpipe/v3.operation_runner.response.graph.json'
    : 'docs/architecture/dagpipe/v3.operation_runner.error.graph.json';
  if (fs.existsSync(path.join(root, graphRel))) {
    failures.push(`missing mainline chain ${id}`);
  }
}

const designFeature = (verificationMap.features ?? []).find((f) => f.feature_id === 'v3.unified_operation_runner_design');
if (!designFeature) failures.push('verification map missing v3.unified_operation_runner_design');
else if (!(designFeature.required_gates ?? []).includes('npm run verify:v3-operation-runner-dagpipe')) {
  failures.push('verification map feature missing required gate npm run verify:v3-operation-runner-dagpipe');
}

const requestGraph = JSON.parse(fs.readFileSync(path.join(root, requestGraphRel), 'utf8'));
const requestChain = (mainlineMap.chains ?? []).find((chain) => chain.chain_id === 'v3.operation_runner.dagpipe.request');
const captureNode = (requestGraph.nodes ?? []).find((node) => node.id === 'capture_client_json');
if (!captureNode) {
  failures.push(`${requestGraphRel}: missing capture_client_json node`);
} else {
  const captureReads = captureNode.resources?.reads ?? [];
  const captureWrites = captureNode.resources?.writes ?? [];
  for (const forbidden of ['v3.operation_runner.metadata_center_control', 'v3.operation_runner.request_origin_kind']) {
    if (captureReads.includes(forbidden) || captureWrites.includes(forbidden)) {
      failures.push(`${requestGraphRel}: capture_client_json must not access ${forbidden}`);
    }
  }
  if (captureWrites.length > 0) {
    failures.push(`${requestGraphRel}: pure capture_client_json must not declare control-resource writes`);
  }
}

const captureNormalizeEdges = (requestGraph.edges ?? []).filter(
  (edge) => edge?.from === 'capture_client_json' && edge?.to === 'normalize_request_losslessly',
);
if (captureNormalizeEdges.length !== 1 || captureNormalizeEdges[0]?.arc_id !== 'client-json') {
  failures.push(`${requestGraphRel}: missing or malformed capture_client_json -> normalize_request_losslessly edge (arc client-json)`);
}

const requestCaptureNormalizeMapEdge = (requestChain?.edges ?? []).find(
  (edge) => edge?.from_node === 'V3OperationRunnerCaptureClientJson' && edge?.to_node === 'V3OperationRunnerNormalizeRequest',
);
if (!requestCaptureNormalizeMapEdge) {
  failures.push('v3-mainline-call-map.yml: v3.operation_runner.dagpipe.request missing capture_client_json -> normalize_request_losslessly caller edge');
} else {
  if (requestCaptureNormalizeMapEdge.status !== 'binding_pending') {
    failures.push('v3-mainline-call-map.yml: v3-op-runner-req-01 must preserve status binding_pending');
  }
  for (const field of ['caller_symbol', 'caller_file', 'callee_symbol', 'callee_file']) {
    if (requestCaptureNormalizeMapEdge[field] !== 'pending') {
      failures.push(`v3-mainline-call-map.yml: v3-op-runner-req-01 must keep ${field} pending, not fake source binding`);
    }
  }
}

const captureEntry = requestChain?.entry_contract?.first_delivery_binding;
const captureSlice = captureEntry?.dagpipe_slice;
if (!['design_review_pending', 'runtime_bound'].includes(captureEntry?.status)) {
  failures.push('v3-mainline-call-map.yml: capture first delivery must declare its binding status');
}
if (captureEntry?.status === 'runtime_bound') {
  const symbol = 'execute_v3_operation_runner_request_capture_client_json';
  for (const [rel, start, boundary] of [
    ['v3/crates/routecodex-v3-server/src/endpoint_handlers.rs',
      'pub(crate) async fn pending_endpoint_after_responses_admission_inner(',
      'V3EntryProtocolExecutionMode::Direct'],
    ['v3/crates/routecodex-v3-server/src/websocket.rs',
      'pub(crate) async fn handle_responses_websocket_message_with_mode(',
      'match effective_execution_mode'],
  ]) {
    const source = fs.readFileSync(path.join(root, rel), 'utf8');
    const functionStart = source.indexOf(start);
    const dispatch = source.indexOf(boundary, functionStart);
    const beforeDispatch = functionStart < 0 || dispatch < 0 ? '' : source.slice(functionStart, dispatch);
    if (beforeDispatch.split(symbol).length - 1 !== 1) {
      failures.push(`${rel}: ${symbol} must be called exactly once before Direct/Relay dispatch`);
    }
  }
}
const captureSliceContract = {
  source_graph: requestGraphRel,
  selected_node: 'capture_client_json',
  node_selection: 'selected_node_and_transitive_ancestors',
  input_arc: 'source-request',
  output_arc: 'client-json',
  derived_graph_id: 'v3.operation_runner.request.capture_client_json',
  graph_version: 'inherited_from_source_graph',
  runtime_owner: 'RuntimeRequestGraphEntry',
  compile_api: 'pipeline_runtime::compile',
  run_api: 'pipeline_runtime::Runtime::run',
  unregistered_operator: 'compile_failure_enters_error_err01',
};
if (!captureSlice) {
  failures.push('v3-mainline-call-map.yml: first delivery missing deterministic capture DAGpipe slice contract');
} else {
  for (const [field, expected] of Object.entries(captureSliceContract)) {
    if (captureSlice[field] !== expected) {
      failures.push(`v3-mainline-call-map.yml: capture dagpipe_slice.${field} must be ${expected}`);
    }
  }
  if (captureNode && (captureNode.inputs?.length !== 1
    || captureNode.inputs[0] !== captureSlice.input_arc
    || captureNode.output?.id !== captureSlice.output_arc)) {
    failures.push(`${requestGraphRel}: capture dagpipe_slice must preserve the canonical node input/output ARC contract`);
  }
}

const normalizePlanEdges = (requestGraph.edges ?? []).filter(
  (edge) => edge?.from === 'normalize_request_losslessly' && edge?.to === 'plan_execution',
);
if (normalizePlanEdges.length !== 1 || normalizePlanEdges[0]?.arc_id !== 'canonical-request') {
  failures.push(`${requestGraphRel}: missing or malformed normalize_request_losslessly -> plan_execution edge (arc canonical-request)`);
}

const requestNormalizePlanMapEdge = (requestChain?.edges ?? []).find(
  (edge) => edge?.from_node === 'V3OperationRunnerNormalizeRequest' && edge?.to_node === 'V3OperationRunnerPlanExecution',
);
if (!requestNormalizePlanMapEdge) {
  failures.push('v3-mainline-call-map.yml: v3.operation_runner.dagpipe.request missing normalize_request_losslessly -> plan_execution caller edge');
} else {
  if (requestNormalizePlanMapEdge.status !== 'binding_pending') {
    failures.push('v3-mainline-call-map.yml: v3-op-runner-req-02b must preserve status binding_pending');
  }
  for (const field of ['caller_symbol', 'caller_file', 'callee_symbol', 'callee_file']) {
    if (requestNormalizePlanMapEdge[field] !== 'pending') {
      failures.push(`v3-mainline-call-map.yml: v3-op-runner-req-02b must keep ${field} pending, not fake source binding`);
    }
  }
}

const node02DesignBinding = requestChain?.entry_contract?.second_delivery_design_binding;
const requiredNode02Consumers = [
  'direct',
  'relay',
  'responses_relay',
  'anthropic_relay',
  'public_relay_hook',
  'responses_relay_websocket',
  'openai_chat_direct_to_relay',
  'responses_direct_to_relay',
];
if (!node02DesignBinding) {
  failures.push('v3-mainline-call-map.yml: request chain missing second_delivery_design_binding');
} else {
  const node02Entry = node02DesignBinding.node02_slice_entry ?? {};
  if (node02Entry.output_arc !== 'canonical-request') {
    failures.push('v3-mainline-call-map.yml: Node02 slice entry output_arc must be canonical-request');
  }
  if (node02Entry.caller_file !== 'v3/crates/routecodex-v3-runtime/src/operation_runner/mod.rs') {
    failures.push('v3-mainline-call-map.yml: Node02 slice entry caller_file must be v3/crates/routecodex-v3-runtime/src/operation_runner/mod.rs');
  }

  const node02Consumers = node02DesignBinding.node02_slice_consumers;
  if (!Array.isArray(node02Consumers)) {
    failures.push('v3-mainline-call-map.yml: Node02 slice consumers must be an array');
  } else {
    const consumerModes = new Set(node02Consumers.map((consumer) => consumer?.mode));
    for (const mode of requiredNode02Consumers) {
      if (!consumerModes.has(mode)) failures.push(`v3-mainline-call-map.yml: Node02 slice consumers missing ${mode}`);
    }
    for (const consumer of node02Consumers) {
      if (!requiredNode02Consumers.includes(consumer?.mode)) continue;
      if (consumer?.handoff !== 'canonical-request') {
        failures.push(`v3-mainline-call-map.yml: Node02 slice consumer ${consumer?.mode} handoff must be canonical-request`);
      }
    }
  }

  const futureNodeSymbols = new Set([
    'V3OperationRunnerResolveTarget',
    'V3OperationRunnerPlanExecution',
  ]);
  for (const consumer of node02Consumers ?? []) {
    if (futureNodeSymbols.has(consumer?.consumer_symbol)) {
      failures.push(`v3-mainline-call-map.yml: Node02 consumer ${consumer?.mode} cannot bind future node ${consumer.consumer_symbol}`);
    }
  }

  const futureFullGraphEdges = node02DesignBinding.future_full_graph_edges;
  if (!Array.isArray(futureFullGraphEdges)) {
    failures.push('v3-mainline-call-map.yml: Node02 binding missing future_full_graph_edges');
  } else {
    for (const expectedStepId of ['v3-op-runner-req-02', 'v3-op-runner-req-02b']) {
      const edge = futureFullGraphEdges.find((item) => item?.step_id === expectedStepId);
      if (!edge) {
        failures.push(`v3-mainline-call-map.yml: Node02 future full graph edge ${expectedStepId} missing`);
      } else if (edge.status !== 'binding_pending') {
        failures.push(`v3-mainline-call-map.yml: Node02 future full graph edge ${expectedStepId} must remain binding_pending`);
      }
    }
  }
}

const errorGraphRel = 'docs/architecture/dagpipe/v3.operation_runner.error.graph.json';
// Error graph resource checks are deferred design targets: validate only
// when the graph is present, never block Node 01.
if (fs.existsSync(path.join(root, errorGraphRel))) {
  const errorGraph = JSON.parse(fs.readFileSync(path.join(root, errorGraphRel), 'utf8'));
const expectedErrorResources = {
  error_err01_source_raised: {
    reads: [],
    writes: ['v3.error.chain'],
  },
  error_err02_host_captured: {
    reads: ['v3.error.chain'],
    writes: ['v3.error.chain'],
  },
  error_err03_runtime_classified: {
    reads: ['v3.error.chain', 'provider_runtime.observation'],
    writes: ['v3.error.chain', 'provider_runtime.observation'],
  },
  error_err04_router_policy_applied: {
    reads: ['v3.error.chain', 'route.retry_exclusion_set'],
    writes: ['v3.error.chain', 'route.retry_exclusion_set'],
  },
  error_err05_execution_decision: {
    reads: ['v3.error.chain', 'v3.error.execution_decision'],
    writes: ['v3.error.chain', 'v3.error.execution_decision'],
  },
  error_err06_client_projected: {
    reads: ['v3.error.chain', 'v3.error.execution_decision'],
    writes: ['v3.error.client_projection_candidate'],
  },
};
const errorNodes = new Map((errorGraph.nodes ?? []).map((node) => [node.id, node]));
for (const [nodeId, expected] of Object.entries(expectedErrorResources)) {
  const node = errorNodes.get(nodeId);
  if (!node) {
    failures.push(`${errorGraphRel}: missing error node ${nodeId}`);
    continue;
  }
  const actualReads = node?.resources?.reads ?? [];
  const actualWrites = node?.resources?.writes ?? [];
  const missingReads = expected.reads.filter((resource) => !actualReads.includes(resource));
  const missingWrites = expected.writes.filter((resource) => !actualWrites.includes(resource));
  const extraReads = actualReads.filter((resource) => !expected.reads.includes(resource));
  const extraWrites = actualWrites.filter((resource) => !expected.writes.includes(resource));
  if (missingReads.length || missingWrites.length || extraReads.length || extraWrites.length) {
    failures.push(
      `${errorGraphRel}: node ${nodeId} typed resources mismatch`
      + ` (missing reads: ${missingReads.join(',') || 'none'}`
      + `, missing writes: ${missingWrites.join(',') || 'none'}`
      + `, extra reads: ${extraReads.join(',') || 'none'}`
      + `, extra writes: ${extraWrites.join(',') || 'none'})`,
    );
  }
}
} // end deferred error graph check

const terminalCleanupEvents = new Set(Object.keys(lifecycleManifest?.typed_cleanup_events?.attempt_cleanup?.consumes ?? {}));
for (const terminal of ['terminal_client_error', 'cancel', 'disconnect']) {
  if (!terminalCleanupEvents.has(terminal)) {
    failures.push(`v3.operation_runner.lifecycle.manifest.yml: attempt_cleanup must cover ${terminal}`);
  }
}
const disconnectTerminal = (lifecycleManifest.lifecycle_terminals ?? []).find((entry) => entry?.name === 'disconnect');
if (!disconnectTerminal) {
  failures.push('v3.operation_runner.lifecycle.manifest.yml: missing disconnect lifecycle terminal');
} else {
  const disconnectText = `${disconnectTerminal.condition ?? ''} ${disconnectTerminal.release ?? ''}`;
  if (!/before the first committed client frame/.test(disconnectText) || !/after accepted frames/.test(disconnectText)) {
    failures.push('v3.operation_runner.lifecycle.manifest.yml: disconnect must cover pre-first-frame and post-frame disconnects');
  }
  if (!/RuntimeAttemptCleanup releases/.test(disconnectText) || !/RuntimeRequestFinalizer releases request scope/.test(disconnectText)) {
    failures.push('v3.operation_runner.lifecycle.manifest.yml: disconnect must release attempt scope before request scope');
  }
}

const cancelTerminal = (lifecycleManifest.lifecycle_terminals ?? []).find((entry) => entry?.name === 'cancel');
const cancelRelease = cancelTerminal?.release ?? '';
if (!/RuntimeAttemptCleanup releases/.test(cancelRelease) || !/RuntimeRequestFinalizer then releases request-scoped control slots/.test(cancelRelease)) {
  failures.push('v3.operation_runner.lifecycle.manifest.yml: cancel must release attempt scope before request scope');
}

const failureTerminal = (lifecycleManifest.lifecycle_terminals ?? []).find((entry) => entry?.name === 'failure');
const failureRelease = failureTerminal?.release ?? '';
if (!/terminal_client_error commits through Server\/SSE and then RuntimeAttemptCleanup/.test(failureRelease) || !/RuntimeRequestFinalizer releases request scope/.test(failureRelease)) {
  failures.push('v3.operation_runner.lifecycle.manifest.yml: terminal_client_error must release attempt scope before request scope');
}

if (failures.length) {
  console.error('[verify:v3-operation-runner-dagpipe] failed');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('[verify:v3-operation-runner-dagpipe] ok');
console.log(`- required graphs: ${requiredGraphs.length}`);
console.log(`- deferred graphs present: ${deferredGraphs.filter((rel) => fs.existsSync(path.join(root, rel))).length}`);
console.log(`- operator_version checks: passed`);
