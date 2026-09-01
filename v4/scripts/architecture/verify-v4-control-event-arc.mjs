#!/usr/bin/env node
/**
 * v4_parity_gate_control_event_arc
 *
 * Locks the one-way control/event arc that was missing as an explicit
 * architecture gate:
 *   typed control command -> MetadataCenter state transition
 *     -> immutable committed event fact -> debug bus read-only dispatch
 *
 * The bus must not become a continuation, routing, retry, or business
 * decision input; the subscriber view must be read-only; scope isolation
 * must be enforced by the owner bus, not by runtime-bin or handler code.
 */
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MAP_PATH = 'docs/architecture/v4-resource-operation-map.yml';
const CONTROL_SOURCE = path.join(root, 'crates/routecodex-v4-control/src/lib.rs');
const BUS_SOURCE = path.join(root, 'crates/routecodex-v4-debug/src/bus.rs');

function read(name) {
  return fs.readFileSync(path.join(root, name), 'utf8');
}

function requireSubstring(source, needle, message) {
  if (!source.includes(needle)) {
    throw new Error(message);
  }
}

function hasAny(list, needles) {
  return (list ?? []).some((entry) => needles.some((needle) => String(entry).includes(needle)));
}

function validate({ mapYaml, controlSource, busSource }) {
  const map = yaml.load(mapYaml);
  const resources = new Map(
    (map.resources ?? []).map((resource) => [resource.resource_id, resource]),
  );
  function resource(name) {
    const value = resources.get(name);
    if (!value) {
      throw new Error(`${name} is not declared in v4-resource-operation-map.yml`);
    }
    return value;
  }

  const metadata = resource('v4.control.metadata_center');
  const sideChannel = resource('v4.control.side_channel');
  const errorChain = resource('v4.control.error_chain');
  const busSubscription = resource('v4.debug.bus_subscription');

  if (metadata.axis !== 'control') throw new Error('metadata_center must be a control resource');
  if (sideChannel.axis !== 'control') throw new Error('side_channel must be a control resource');
  if (errorChain.axis !== 'control') throw new Error('error_chain must be a control resource');
  if (busSubscription.axis !== 'diagnostic') throw new Error('bus_subscription must be a diagnostic resource');
  if (metadata.state_machine_required !== true) throw new Error('metadata_center requires a state machine');

  const sideContract = sideChannel.semantic_contract ?? {};
  if (sideContract.never_normal_payload !== true
    || sideContract.never_provider_wire !== true
    || sideContract.never_client_wire !== true) {
    throw new Error('side_channel must never enter normal/provider/client payload');
  }

  const busContract = busSubscription.semantic_contract ?? {};
  if (busContract.read_only !== true
    || busContract.decision_plane !== 'forbidden'
    || busContract.payload_carrier !== 'forbidden'
    || busContract.may_enter_metadata_center !== false) {
    throw new Error('bus_subscription must be read-only, never decision plane or payload carrier');
  }

  const errorContract = errorChain.semantic_contract ?? {};
  if (errorContract.single_direction !== true
    || errorContract.fallback !== 'forbidden') {
    throw new Error('error_chain must be one-way and forbid fallback');
  }

  const busOwned = busSource.includes('publish(')
    && busSource.includes('dispatch(')
    && busSource.includes("subscribers_for<'a>(")
    && busSource.includes('scope_key')
    && busSource.includes('ReadOnlySubscriberView');
  if (!busOwned) {
    throw new Error('diagnostic event bus owner must expose publish/dispatch/scope/read-only view');
  }

  const controlOwned = controlSource.includes('pub fn register(')
    && controlSource.includes('pub fn consume(')
    && controlSource.includes('pub fn release(')
    && controlSource.includes('committed_event(')
    && controlSource.includes('ControlCommittedEvent');
  if (!controlOwned) {
    throw new Error('MetadataCenter owner must expose register/consume/release/committed_event');
  }

  const wireWriters = [
    'V4ProviderReqCompat07ProviderCompat',
    'V4HubRespOutbound05ClientSemantic',
  ];
  const arcOwners = [
    [metadata, wireWriters],
    [sideChannel, wireWriters],
    [busSubscription, wireWriters],
  ];
  for (const [owner, mustForbid] of arcOwners) {
    for (const writer of mustForbid) {
      if (!(owner.forbidden_writers ?? []).includes(writer)) {
        throw new Error(`${owner.resource_id} must forbid writer ${writer}`);
      }
    }
  }
  for (const writer of ['V4HubReqChatProcess03Governed', 'V4ProviderReqCompat07ProviderCompat', 'V4HubRespOutbound05ClientSemantic']) {
    if (!(errorChain.forbidden_writers ?? []).includes(writer)) {
      throw new Error(`${errorChain.resource_id} must forbid writer ${writer}`);
    }
  }

  if (!hasAny(busSubscription.allowed_readers, ['observe', 'ReadOnlySubscriberView'])) {
    throw new Error('bus_subscription must expose only read-only subscribers');
  }

  if ((busSubscription.may_enter_provider_body ?? false)
    || (busSubscription.may_enter_client_body ?? false)
    || (metadata.may_enter_provider_body ?? false)
    || (metadata.may_enter_client_body ?? false)
    || (errorChain.may_enter_provider_body ?? false)
    || (errorChain.may_enter_client_body ?? false)) {
    throw new Error('control/event resources must not enter provider or client body');
  }

  requireSubstring(
    busSource,
    'fn dispatch(',
    'bus owner must own scope-filtered dispatch',
  );
  requireSubstring(
    controlSource,
    'try_reconstruct_from_payload',
    'control reconstruction from payload must fail at owner boundary',
  );
  requireSubstring(
    controlSource,
    'ControlSignalKind',
    'typed control signal enum must remain the control carrier',
  );
}

const mapYaml = read(MAP_PATH);
const controlSource = read('crates/routecodex-v4-control/src/lib.rs');
const busSource = read('crates/routecodex-v4-debug/src/bus.rs');

if (process.argv.includes('--red-self-test')) {
  // Probe: deleting the read-only view from the bus source must fail the gate.
  try {
    validate({ mapYaml, controlSource, busSource: busSource.replaceAll('ReadOnlySubscriberView', '') });
    console.error('red self-test: gate accepted a bus without read-only subscriber view');
    process.exit(1);
  } catch (error) {
    if (!String(error.message).includes('read-only view')) {
      console.error(`red self-test failed unexpectedly: ${error.message}`);
      process.exit(1);
    }
  }
  console.log('[v4_parity_gate_control_event_arc] OK red self-test 1/1');
  process.exit(0);
}

validate({ mapYaml, controlSource, busSource });
console.log(
  '[v4_parity_gate_control_event_arc] OK control->event arc locked: ',
  'metadata_center/side_channel/error_chain one-way, bus read-only, scope dispatch owner-bound',
);
