#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import YAML from 'yaml';

const root = process.env.V3_PROVIDER_SESSION_COOLDOWN_ROOT
  ? path.resolve(process.env.V3_PROVIDER_SESSION_COOLDOWN_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (file) => YAML.parse(fs.readFileSync(path.join(root, 'docs/architecture', file), 'utf8'));
const resources = read('v3-resource-operation-map.yml');
const functions = read('v3-function-map.yml');
const mainline = read('v3-mainline-call-map.yml');
const failures = [];
const requireValue = (condition, message) => { if (!condition) failures.push(message); };
const includesAll = (values, expected) => expected.every((value) => values?.includes(value));
const resource = (id) => {
  const row = resources.resources?.find((item) => item.resource_id === id);
  requireValue(Boolean(row), `missing ${id} resource`);
  return row;
};
const health = resource('v3.provider.health_state');
const availability = resource('v3.provider.availability_projection');
const http = resource('v3.server.validated_http_input');
const scope = resource('v3.provider.failure_session_scope');
requireValue(isDeepStrictEqual(health?.identity, ['serverId', 'routingGroup', 'sessionId', 'providerRuntimeIdentity']), 'Resource map must bind provider health state identity to server+routing_group+session+runtime identity');
requireValue(includesAll(health?.allowed_writers, ['V3ProviderHealthStore::record_provider_failure_in_session', 'V3ProviderHealthStore::record_provider_success_in_session', 'V3ProviderHealthStore::acquire_provider_cooldown_rescue_probe']), 'Provider health writers must bind scoped Health owners');
requireValue(includesAll(health?.allowed_readers, ['V3ProviderHealthStore::availability_for_session', 'V3ProviderSessionAvailabilityReader::availability']), 'Provider health readers must bind scoped availability');
requireValue(!health?.allowed_writers?.includes('V3ProviderFailureRuntimeHealth::record_provider_failure_record'), 'Runtime wrappers must not own provider health writes');
for (const operation of ['record_provider_failure', 'record_provider_success']) {
  requireValue(!health?.allowed_writers?.includes(`V3ProviderHealthStore::${operation}`), 'Provider health must not bind removed global mutation owners');
}
requireValue(![...(health?.allowed_writers ?? []), ...(health?.allowed_readers ?? [])].includes('V3ProviderHealthStore::wait_for_provider_cooldown_probe_completion'), 'Provider health must not authorize request-blocking probe waits');
requireValue(isDeepStrictEqual(availability?.identity, ['providerId', 'interfaceId', 'authAlias', 'modelId', 'available', 'blockedScopes']), 'Availability projection must bind blocked session scopes');
requireValue(http?.identity?.includes('requestSessionIdHeader'), 'Validated HTTP input must declare the session control header');
requireValue(http?.allowed_readers?.includes('build_v3_provider_failure_session_scope_for_request'), 'Validated HTTP input must bind the Server scope builder');
for (const [name, row] of [['HTTP control input', http], ['failure session scope', scope]]) {
  requireValue(row?.may_enter_provider_body === false && row?.may_enter_client_body === false, `${name} must not enter provider or client bodies`);
}
requireValue(scope?.resource_kind === 'side_channel' && scope?.owner_crate === 'routecodex-v3-error' && scope?.owner_node === 'V3ProviderFailureSessionScope', 'Failure session scope must bind Error-owned typed side-channel');
requireValue(isDeepStrictEqual(scope?.identity, ['serverId', 'routingGroup', 'sessionId']), 'Failure session scope identity must bind server/group/session');
requireValue(isDeepStrictEqual(scope?.allowed_writers, ['V3ProviderFailureSessionScope::new']), 'Failure session scope writer must be only the typed constructor');
requireValue(includesAll(scope?.allowed_readers, [
  'V3Error05RecoveryAdmissionWitness::new',
  'V3ProviderFailureRuntimeHealth::record_provider_failure_record',
  'V3ProviderFailureRuntimeHealth::record_provider_success_in_failure_scope',
  'V3ProviderFailureRuntimeHealth::session_bound_availability',
  'V3ProviderActionProviderScope::new',
  'V3ProviderSessionAvailabilityReader::availability',
  'run_v3_relay_provider_failure_policy_with_response_source',
]), 'Failure session scope must bind typed Error/Runtime/action/availability consumers');
const feature = functions.features?.find((row) => row.feature_id === 'v3.debug_error_foundation');
requireValue(feature?.resource_bindings?.includes('v3.provider.failure_session_scope'), 'Function owner must bind failure session scope resource');
requireValue(includesAll(feature?.entry_symbols, [
  'V3ProviderFailureRuntimeHealth::record_provider_failure_record',
  'V3ProviderFailureRuntimeHealth::record_provider_success_in_failure_scope',
  'V3ProviderFailureRuntimeHealth::session_bound_availability',
  'V3ProviderSessionAvailabilityReader::availability',
  'V3ProviderHealthStore::record_provider_failure_in_session',
  'V3ProviderHealthStore::record_provider_success_in_session',
  'V3ProviderHealthStore::availability_for_session',
  'build_v3_provider_failure_session_scope_for_request',
]), 'Function owner must bind scoped health and request scope operations');
for (const symbol of ['V3ProviderHealthStore::record_provider_failure', 'V3ProviderHealthStore::record_provider_success']) {
  requireValue(!feature?.entry_symbols?.includes(symbol), 'Function owner must not retain removed global mutation owners');
}
const chain = mainline.chains?.find((row) => row.chain_id === 'v3.debug_error_foundation.mainline');
const edges = new Map((chain?.edges ?? []).map((edge) => [edge.step_id, edge]));
for (const [id, caller, callee] of [
  ['v3-de-13', 'V3ProviderSessionAvailabilityReader::availability', 'V3ProviderHealthStore::availability_for_session'],
  ['v3-de-14', 'V3ProviderFailureRuntimeHealth::record_provider_failure_record', 'V3ProviderHealthStore::record_provider_failure_in_session'],
  ['v3-de-15', 'V3ProviderFailureRuntimeHealth::record_provider_success_in_failure_scope', 'V3ProviderHealthStore::record_provider_success_in_session'],
]) {
  const edge = edges.get(id);
  requireValue(edge?.caller_symbol === caller && edge?.callee_symbol === callee, `${id} must bind scoped health caller/callee`);
}
const edge = edges.get('v3-de-18');
requireValue(edge?.from_node === 'V3Server03HttpRequestRaw' && edge?.to_node === 'V3ProviderFailureSessionScope', 'v3-de-18 must produce typed scope from Server request');
requireValue(edge?.caller_symbol === 'build_v3_provider_failure_session_scope_for_request' && edge?.caller_file === 'v3/crates/routecodex-v3-server/src/lib.rs', 'v3-de-18 must bind Server scope builder');
requireValue(edge?.callee_symbol === 'V3ProviderFailureSessionScope::new' && edge?.callee_file === 'v3/crates/routecodex-v3-error/src/lib.rs' && edge?.owner_feature_id === 'v3.debug_error_foundation', 'v3-de-18 must bind Error constructor and owner');
requireValue(includesAll(edge?.resource_flow?.consumes, ['v3.server.validated_http_input', 'v3.request.protocol_fields']), 'v3-de-18 must consume validated HTTP and protocol context');
requireValue(edge?.resource_flow?.produces?.includes('v3.provider.failure_session_scope') && edge?.resource_flow?.side_channel_writes?.includes('v3.provider.failure_session_scope'), 'v3-de-18 must produce and write failure session scope');
requireValue(!Object.values(edge?.resource_flow ?? {}).flat().includes('v3.provider.health_state'), 'v3-de-18 must not claim provider health mutation');
if (failures.length) {
  console.error('V3 provider session cooldown verification failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}
console.log('V3 provider session cooldown declared owner/resource verification passed.');
