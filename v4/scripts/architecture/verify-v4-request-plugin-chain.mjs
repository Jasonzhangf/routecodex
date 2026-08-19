import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();

function read(relative) {
  return fs.readFileSync(path.join(root, relative), 'utf8');
}

function verifySources({ standard, runtime, runtimeBin, mainline, verification }) {
  const errors = [];
  const requiredPluginIds = [
    'v4.std.protocol.server_input',
    'v4.std.protocol.sse_in',
    'v4.std.protocol.responses_inbound',
    'v4.std.chat_process.scope_restore',
    'v4.std.chat_process.continuation_restore',
    'v4.std.chat_process.tool_governance',
    'v4.std.routing.entry_model_admission',
    'v4.std.routing.candidate_filter',
    'v4.std.routing.target_selection',
    'v4.std.routing.model_replacement',
    'v4.std.provider.compat',
    'v4.std.provider.wire_boundary',
  ];
  for (const id of requiredPluginIds) {
    if (!standard.includes(id)) errors.push(`missing plugin id ${id}`);
  }
  if (standard.includes('mock_codec') || standard.includes('transport_mock')) {
    errors.push('mock request plugin remains active');
  }
  for (const symbol of ['RequestPluginRuntime', 'execute_responses']) {
    if (!runtime.includes(symbol)) errors.push(`runtime missing ${symbol}`);
  }
  if (!runtimeBin.includes('RequestPluginRuntime')) {
    errors.push('runtime-bin does not dispatch through RequestPluginRuntime');
  }
  if (runtimeBin.includes('route_request(') || runtimeBin.includes('build_responses_wire_request(')) {
    errors.push('runtime-bin admission handler bypasses request plugin chain');
  }
  for (const edge of [
    'V4HubReqChatProcess04Governed',
    'V4Router05RequestClassified',
    'V4Router06SelectionPlan',
    'V4HubReqOutbound05ProviderSemantic',
  ]) {
    if (!mainline.includes(edge)) errors.push(`mainline missing ${edge}`);
  }
  if (!verification.includes('v4_request_plugin_chain_l2_regression')) {
    errors.push('verification map missing request chain gate');
  }
  return errors;
}

const sources = {
  standard: read('crates/routecodex-v4-standard-plugins/src/lib.rs'),
  runtime: fs.existsSync(path.join(root, 'crates/routecodex-v4-runtime/src/request_plugin_runtime.rs'))
    ? read('crates/routecodex-v4-runtime/src/request_plugin_runtime.rs')
    : '',
  runtimeBin: read('crates/routecodex-v4-runtime-bin/src/main.rs'),
  mainline: read('.appsdk/maps/mainline-call-map.json'),
  verification: read('.appsdk/maps/verification-map.json'),
};

if (process.argv.includes('--red-self-test')) {
  const mutations = [
    { name: 'plugin removed', value: { ...sources, standard: sources.standard.replaceAll('v4.std.protocol.server_input', 'removed') } },
    { name: 'handler bypass', value: { ...sources, runtimeBin: `${sources.runtimeBin}\nroute_request(` } },
    { name: 'runtime dispatch removed', value: { ...sources, runtimeBin: sources.runtimeBin.replaceAll('RequestPluginRuntime', 'RemovedRuntime') } },
    { name: 'map edge removed', value: { ...sources, mainline: sources.mainline.replaceAll('V4Router06SelectionPlan', 'RemovedRouter06') } },
  ];
  let passed = 0;
  for (const mutation of mutations) {
    if (verifySources(mutation.value).length > 0) passed += 1;
  }
  if (passed !== mutations.length) {
    throw new Error(`request plugin red self-test failed ${passed}/${mutations.length}`);
  }
  console.log(`[v4_parity_gate_request_plugin_chain] OK red self-test ${passed}/${mutations.length}`);
  process.exit(0);
}

const errors = verifySources(sources);
if (errors.length > 0) {
  for (const error of errors) console.error(`[v4_parity_gate_request_plugin_chain] ${error}`);
  process.exit(1);
}
console.log('[v4_parity_gate_request_plugin_chain] OK');
