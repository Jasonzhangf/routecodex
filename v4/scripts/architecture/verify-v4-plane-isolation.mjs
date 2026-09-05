#!/usr/bin/env node
/** Locks typed data/control/diagnostic isolation and its machine-readable edge contract. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import yaml from 'js-yaml';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MAP_PATH = 'docs/architecture/v4-resource-operation-map.yml';
const CONTRACT_PATH = 'contracts/data-control-boundary.contract.json';
const SOURCE_PATHS = {
  control: 'crates/routecodex-v4-control/src/lib.rs',
  controlTests: 'crates/routecodex-v4-control/tests/l2_control.rs',
  standardPlugins: 'crates/routecodex-v4-standard-plugins/src/lib.rs',
  responseInbound: 'crates/routecodex-v4-standard-plugins/src/response_inbound.rs',
  responseOutbound: 'crates/routecodex-v4-standard-plugins/src/response_outbound.rs',
};
const CONTRACT_HASHES = {
  forbiddenEdges: 'sha256:af6dea8727859fbe4953293efd1e272f3139a041f63cb0d8183b53652a97d7bc',
  invariants: 'sha256:c411741d0d3e6ed7e70e3b57d8b560e8f15668ffd5dea74699f66b05731430a9',
  redGates: 'sha256:16037f265a61606eed0ca5c79e91a8a53b98158f3bb03f7a5ab45afdb2be9c85',
  activationConditions: 'sha256:820b26c09fad7c191a54df5e61b807bf507eda469cf3a15f532ce0ca174c7006',
};

function failure(code, message) {
  return { code, message };
}

function sortedUnique(values) {
  return [...new Set(values)].sort();
}

function sameOrdered(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sha256(value) {
  return 'sha256:' + crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function edgeIds(resourceMap) {
  return sortedUnique((resourceMap.forbidden_direct_edges ?? []).map((edge) => `${edge.from}->${edge.to}`));
}

function sortedValues(values) {
  return [...values].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

function redGateProjection(boundaryContract) {
  return sortedValues((boundaryContract?.red_test_gates ?? []).map((gate) => ({
    gate_id: gate.gate_id,
    name: gate.name,
    required_for: [...(gate.required_for ?? [])].sort(),
  })));
}

function validatePhysicalSources(sourceInputs, failures) {
  if (!sourceInputs || Object.keys(SOURCE_PATHS).some((key) => typeof sourceInputs[key] !== 'string')) {
    failures.push(failure('BOUNDARY_SOURCE_SET_MISSING', 'all owning source/test inputs are required'));
    return;
  }
  const control = sourceInputs.control;
  if (!/pub fn try_reconstruct_from_payload[\s\S]*?Err\(ControlError::ControlNotReconstructibleFromPayload\)[\s\S]*?\n    }/.test(control)
      || !/pub fn write_control[\s\S]*?Err\(ControlError::ControlIntoPayload\)[\s\S]*?\n    }/.test(control)) {
    failures.push(failure('CONTROL_PAYLOAD_FAILFAST_SOURCE',
      'control owner must fail fast on payload reconstruction and control-to-payload writes'));
  }
  const controlTests = sourceInputs.controlTests;
  for (const testName of [
    'payload_gate_write_control_red',
    'protocol_metadata_cannot_become_control_red',
    'payload_reconstruction_forbidden_red',
  ]) {
    if (!new RegExp('fn ' + testName + '\\(\\)').test(controlTests)) {
      failures.push(failure('CONTROL_PAYLOAD_RED_TEST_SOURCE', testName + ' is missing'));
    }
  }
  if ((sourceInputs.responseInbound.match(/reject_control_fields\(/g) ?? []).length !== 2
      || !sourceInputs.responseInbound.includes('reject_control_fields(raw)?;')
      || (sourceInputs.responseOutbound.match(/reject_control_fields\(/g) ?? []).length !== 2
      || !sourceInputs.responseOutbound.includes('reject_control_fields(object)?;')
      || !sourceInputs.responseOutbound.includes('reject_control_fields(&semantic)?;')) {
    failures.push(failure('WIRE_CONTROL_REJECTION_SOURCE',
      'provider/client response boundaries must reject control fields before projection'));
  }
  const providerWirePair = /vec!\[[\s\S]{0,500}?"v4\.request\.provider_semantic"[\s\S]{0,500}?\],[\s\S]{0,100}?vec!\["v4\.request\.provider_wire_payload"\]/g;
  if ((sourceInputs.standardPlugins.match(providerWirePair) ?? []).length !== 1
      || sourceInputs.standardPlugins.includes('write_control_resource("v4.request.provider_wire_payload"')
      || sourceInputs.standardPlugins.includes('write_control_resource("v4.response.client_wire_payload"')) {
    failures.push(failure('PROVIDER_WIRE_SOURCE_BINDING',
      'provider wire builders must consume provider semantic data only; control writers are forbidden'));
  }
}

export function validatePlaneIsolation(resourceMap, boundaryContract, sourceInputs) {
  const failures = [];
  const resources = resourceMap?.resources ?? [];
  const duplicateIds = resources.map((resource) => resource.resource_id)
    .filter((resourceId, index, all) => all.indexOf(resourceId) !== index);
  if (duplicateIds.length > 0) {
    failures.push(failure('RESOURCE_ID_DUPLICATE', sortedUnique(duplicateIds).join(',')));
  }
  const byId = new Map(resources.map((resource) => [resource.resource_id, resource]));
  const dataOwnerSet = new Set(resources
    .filter((resource) => resource.axis === 'data')
    .map((resource) => resource.owner_node));
  const controlOwnerSet = new Set(resources
    .filter((resource) => resource.axis === 'control')
    .map((resource) => resource.owner_node)
    .filter((owner) => !dataOwnerSet.has(owner)));

  for (const resource of resources) {
    if (!['data', 'control', 'information', 'diagnostic'].includes(resource.axis)) {
      failures.push(failure('RESOURCE_AXIS_INVALID', `${resource.resource_id}: ${resource.axis}`));
      continue;
    }
    const allowedReaders = new Set(resource.allowed_readers ?? []);
    const allowedWriters = new Set(resource.allowed_writers ?? []);
    const forbiddenWriters = new Set(resource.forbidden_writers ?? []);
    if ([...allowedWriters].some((owner) => forbiddenWriters.has(owner))) {
      failures.push(failure('DATA_WRITER_FORBIDDEN_OVERLAP', `${resource.resource_id}: writer is both allowed and forbidden`));
    }
    if (resource.axis === 'control') {
      const typedErrorProjection = resource.resource_id === 'v4.error.client_projection'
        && Array.isArray(resource.semantic_contract?.client_visible_fields);
      if (resource.may_enter_provider_body !== false
          || (resource.may_enter_client_body !== false && !typedErrorProjection)) {
        failures.push(failure('CONTROL_BODY_LEAK', `${resource.resource_id}: control resource entered a normal body`));
      }
      if (resource.resource_id === 'v4.error.client_projection'
          && (!sameOrdered(resource.semantic_contract?.client_visible_fields ?? [], ['code', 'message'])
            || resource.semantic_contract?.internal_control_fields !== 'forbidden')) {
        failures.push(failure('CLIENT_ERROR_PROJECTION_FIELDS',
          'client error projection must expose only code/message and forbid internal control fields'));
      }
    }
    if (resource.axis === 'diagnostic') {
      if (resource.semantic_contract?.may_enter_metadata_center !== false) {
        failures.push(failure('DIAGNOSTIC_METADATA_LEAK', `${resource.resource_id}: diagnostic resource may enter MetadataCenter`));
      }
      if (resource.may_enter_provider_body !== false || resource.may_enter_client_body !== false) {
        failures.push(failure('DIAGNOSTIC_BODY_LEAK', `${resource.resource_id}: diagnostic resource entered a normal body`));
      }
    }
    if (resource.axis === 'data') {
      const visible = resource.may_enter_provider_body === true || resource.may_enter_client_body === true;
      const wireCarrier = ['provider_wire', 'client_wire', 'client_frame', 'client_frame_object']
        .includes(resource.resource_kind);
      const normalPlaneCarrier = ['normal_payload', 'provider_semantic', 'provider_wire', 'client_wire',
        'client_frame', 'client_frame_object'].includes(resource.resource_kind);
      if (visible && !forbiddenWriters.has('V4ControlMetadataCenter')) {
        failures.push(failure('VISIBLE_DATA_METADATA_WRITER', `${resource.resource_id}: visible data must forbid MetadataCenter`));
      }
      if (wireCarrier && resource.semantic_contract?.control_fields_forbidden !== true) {
        failures.push(failure('WIRE_CONTROL_FIELDS_UNLOCKED', `${resource.resource_id}: wire carrier must forbid control fields`));
      }
      if (wireCarrier && [...allowedWriters].some((owner) => controlOwnerSet.has(owner))) {
        failures.push(failure('WIRE_CONTROL_WRITER', `${resource.resource_id}: control owner may write a wire carrier`));
      }
      if (normalPlaneCarrier && [...allowedReaders].some((owner) => controlOwnerSet.has(owner))) {
        failures.push(failure('DATA_CONTROL_READER', `${resource.resource_id}: control owner may read normal data`));
      }
      if (normalPlaneCarrier && [...allowedWriters].some((owner) => controlOwnerSet.has(owner))) {
        failures.push(failure('DATA_CONTROL_WRITER', `${resource.resource_id}: control owner may write normal data`));
      }
    }
  }

  for (const edge of resourceMap?.forbidden_direct_edges ?? []) {
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    if (!from || !to) {
      failures.push(failure('FORBIDDEN_EDGE_UNKNOWN_RESOURCE', `${edge.from}->${edge.to}`));
      continue;
    }
    const fromReach = new Set([...(from.allowed_readers ?? []), ...(from.allowed_writers ?? [])]);
    const toReach = new Set([...(to.allowed_readers ?? []), ...(to.allowed_writers ?? [])]);
    if (fromReach.has(to.owner_node)) {
      failures.push(failure('FORBIDDEN_EDGE_FORWARD', `${edge.from}->${edge.to}: source reaches target owner`));
    }
    if (toReach.has(from.owner_node)) {
      failures.push(failure('FORBIDDEN_EDGE_REVERSE', `${edge.from}->${edge.to}: target accepts source owner`));
    }
  }

  if (boundaryContract?.status !== 'active') {
    failures.push(failure('BOUNDARY_CONTRACT_INACTIVE', 'data/control boundary contract must be active'));
  }
  const rawContractEdges = boundaryContract?.forbidden_direct_edges ?? [];
  const rawMapEdges = (resourceMap?.forbidden_direct_edges ?? []).map((edge) => `${edge.from}->${edge.to}`);
  const contractEdges = sortedUnique(rawContractEdges);
  const mapEdges = edgeIds(resourceMap ?? {});
  if (contractEdges.length !== rawContractEdges.length || mapEdges.length !== rawMapEdges.length) {
    failures.push(failure('BOUNDARY_EDGE_DUPLICATE', 'forbidden edge sets must not contain duplicates'));
  }
  if (!sameOrdered(contractEdges, mapEdges)) {
    failures.push(failure('BOUNDARY_EDGE_CONTRACT_DRIFT', 'contract and resource-map forbidden edges differ'));
  }
  if (sha256([...rawContractEdges].sort()) !== CONTRACT_HASHES.forbiddenEdges) {
    failures.push(failure('BOUNDARY_EDGE_SET_WEAKENED', 'mandatory forbidden edge set drifted'));
  }
  if (sha256(sortedValues(boundaryContract?.invariants ?? [])) !== CONTRACT_HASHES.invariants) {
    failures.push(failure('BOUNDARY_INVARIANT_SET_WEAKENED', 'mandatory invariant set drifted'));
  }
  if (sha256(redGateProjection(boundaryContract)) !== CONTRACT_HASHES.redGates) {
    failures.push(failure('BOUNDARY_RED_GATE_SET_WEAKENED', 'mandatory red gate set drifted'));
  }
  if (sha256(sortedValues(boundaryContract?.activation_conditions ?? [])) !== CONTRACT_HASHES.activationConditions) {
    failures.push(failure('BOUNDARY_ACTIVATION_CONDITIONS', 'activation condition set drifted'));
  }
  const activationGates = sortedUnique(boundaryContract?.activation_gates ?? []);
  if (!sameOrdered(activationGates, [
    'v4_parity_gate_plane_isolation',
    'v4_parity_gate_plane_isolation_red',
    'v4_parity_gate_resource_binding',
  ])) {
    failures.push(failure('BOUNDARY_ACTIVATION_GATES', 'boundary activation gate set drifted'));
  }
  validatePhysicalSources(sourceInputs, failures);
  return failures;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function mutateAllowed(map, fromId, toId) {
  const from = map.resources.find((resource) => resource.resource_id === fromId);
  const to = map.resources.find((resource) => resource.resource_id === toId);
  from.allowed_readers = sortedUnique([...(from.allowed_readers ?? []), to.owner_node]);
}

export function runPlaneIsolationRedSelfTest(resourceMap, boundaryContract, sourceInputs) {
  const baseline = validatePlaneIsolation(resourceMap, boundaryContract, sourceInputs);
  if (baseline.length > 0) throw new Error(`baseline is not green: ${baseline.map((item) => item.code).join(',')}`);
  const shuffled = clone(resourceMap);
  shuffled.resources.reverse();
  if (validatePlaneIsolation(shuffled, boundaryContract, sourceInputs).length > 0) {
    throw new Error('resource ordering changed the verdict');
  }
  const cases = [
    {
      name: 'control writer enters provider wire',
      mutate(map) {
        const wire = map.resources.find((resource) => resource.resource_id === 'v4.request.provider_wire_payload');
        wire.allowed_writers = sortedUnique([...(wire.allowed_writers ?? []), 'V4ScopeRegistry']);
      },
      expected: ['DATA_CONTROL_WRITER', 'DATA_WRITER_FORBIDDEN_OVERLAP', 'FORBIDDEN_EDGE_REVERSE', 'WIRE_CONTROL_WRITER'],
    },
    {
      name: 'payload reconstructs metadata',
      mutate(map) { mutateAllowed(map, 'v4.request.normal_payload', 'v4.control.metadata_center'); },
      expected: ['DATA_CONTROL_READER', 'FORBIDDEN_EDGE_FORWARD'],
    },
    {
      name: 'control reaches payload',
      mutate(map) { mutateAllowed(map, 'v4.control.route_facts', 'v4.request.normal_payload'); },
      expected: ['FORBIDDEN_EDGE_FORWARD'],
    },
    {
      name: 'snapshot reaches runtime',
      mutate(map) { mutateAllowed(map, 'v4.debug.snapshot_ledger', 'v4.pipeline.mainline'); },
      expected: ['FORBIDDEN_EDGE_FORWARD'],
    },
    {
      name: 'map and contract jointly delete mandatory edge',
      mutate(map, contract) {
        const removed = contract.forbidden_direct_edges[0];
        contract.forbidden_direct_edges = contract.forbidden_direct_edges.slice(1);
        map.forbidden_direct_edges = map.forbidden_direct_edges
          .filter((edge) => `${edge.from}->${edge.to}` !== removed);
      },
      expected: ['BOUNDARY_EDGE_SET_WEAKENED'],
    },
    {
      name: 'mandatory invariant set deleted',
      mutate(_map, contract) { contract.invariants = []; },
      expected: ['BOUNDARY_INVARIANT_SET_WEAKENED'],
    },
    {
      name: 'mandatory red gate set deleted',
      mutate(_map, contract) { contract.red_test_gates = []; },
      expected: ['BOUNDARY_RED_GATE_SET_WEAKENED'],
    },
    {
      name: 'diagnostic enters provider body',
      mutate(map) {
        const snapshot = map.resources.find((resource) => resource.resource_id === 'v4.debug.snapshot_ledger');
        snapshot.may_enter_provider_body = true;
      },
      expected: ['DIAGNOSTIC_BODY_LEAK'],
    },
    {
      name: 'client error exposes internal fields',
      mutate(map) {
        const projection = map.resources.find((resource) => resource.resource_id === 'v4.error.client_projection');
        projection.semantic_contract.client_visible_fields = ['code', 'message', 'provider_id'];
      },
      expected: ['CLIENT_ERROR_PROJECTION_FIELDS'],
    },
    {
      name: 'control owner stops failing fast',
      mutate(_map, _contract, sources) {
        sources.control = sources.control.replace('Err(ControlError::ControlIntoPayload)', 'Ok(())');
      },
      expected: ['CONTROL_PAYLOAD_FAILFAST_SOURCE'],
    },
    {
      name: 'response ingress control rejection removed',
      mutate(_map, _contract, sources) {
        sources.responseInbound = sources.responseInbound.replace('    reject_control_fields(raw)?;\n', '');
      },
      expected: ['WIRE_CONTROL_REJECTION_SOURCE'],
    },
    {
      name: 'client SSE control rejection removed',
      mutate(_map, _contract, sources) {
        sources.responseOutbound = sources.responseOutbound.replace('    reject_control_fields(object)?;\n', '');
      },
      expected: ['WIRE_CONTROL_REJECTION_SOURCE'],
    },
    {
      name: 'provider wire descriptor bypasses provider semantic',
      mutate(_map, _contract, sources) {
        sources.standardPlugins = sources.standardPlugins.replace(
          '"v4.request.provider_semantic",\n            "v4.information.client_protocol",\n            "v4.information.provider_protocol",\n            "v4.information.model",\n            "v4.control.request_admission_facts",\n        ],\n        vec!["v4.request.provider_wire_payload"],',
          '"v4.request.normal_payload",\n            "v4.information.client_protocol",\n            "v4.information.provider_protocol",\n            "v4.information.model",\n            "v4.control.request_admission_facts",\n        ],\n        vec!["v4.request.provider_wire_payload"],',
        );
      },
      expected: ['PROVIDER_WIRE_SOURCE_BINDING'],
    },
  ];
  for (const testCase of cases) {
    const mutated = clone(resourceMap);
    const mutatedContract = clone(boundaryContract);
    const mutatedSources = clone(sourceInputs);
    testCase.mutate(mutated, mutatedContract, mutatedSources);
    const actual = sortedUnique(validatePlaneIsolation(mutated, mutatedContract, mutatedSources)
      .map((item) => item.code));
    if (!sameOrdered(actual, testCase.expected)) {
      throw new Error(`${testCase.name}: ${actual.join(',')} != ${testCase.expected.join(',')}`);
    }
  }
  return cases.length + 1;
}

function readInputs() {
  return {
    resourceMap: yaml.load(fs.readFileSync(path.join(root, MAP_PATH), 'utf8')),
    boundaryContract: JSON.parse(fs.readFileSync(path.join(root, CONTRACT_PATH), 'utf8')),
    sourceInputs: Object.fromEntries(Object.entries(SOURCE_PATHS)
      .map(([key, relativePath]) => [key, fs.readFileSync(path.join(root, relativePath), 'utf8')])),
  };
}

function printFailures(failures) {
  console.error('[v4_parity_gate_plane_isolation] FAIL');
  for (const item of failures) console.error(`${item.code}: ${item.message}`);
}

const direct = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (direct) {
  const args = process.argv.slice(2);
  const mode = args.length === 0 ? 'definition'
    : args.length === 1 && args[0] === '--red-self-test' ? '--red-self-test'
      : null;
  if (!mode) {
    console.error(`[v4_parity_gate_plane_isolation] MODE_INVALID ${args.join(' ')}`);
    process.exit(2);
  }
  const { resourceMap, boundaryContract, sourceInputs } = readInputs();
  if (mode === 'definition') {
    const failures = validatePlaneIsolation(resourceMap, boundaryContract, sourceInputs);
    if (failures.length > 0) {
      printFailures(failures);
      process.exit(1);
    }
    console.log('[v4_parity_gate_plane_isolation] OK control/data/diagnostic isolation locked');
  } else if (mode === '--red-self-test') {
    try {
      const count = runPlaneIsolationRedSelfTest(resourceMap, boundaryContract, sourceInputs);
      console.log(`[v4_parity_gate_plane_isolation_red] OK ${count} exact mutations/order checks`);
    } catch (error) {
      console.error(`[v4_parity_gate_plane_isolation_red] FAIL ${error.message}`);
      process.exit(1);
    }
  }
}
