/**
 * Single source of truth for the V4 architecture gate and consumer-regression
 * matrix. verify.mjs (positive), verify-red.mjs (red suites) and the isolation
 * gate (declared<->executed binding against verification-map.json) all consume
 * this module, so a gate added or removed on any one surface is machine-checked
 * against the registry in the same verify:ci run.
 */
export const ARCHITECTURE_GATES = [
  'verify-v4-active-link.mjs',
  'verify-v4-capability-isolation.mjs',
  'verify-v4-cordis-bridge.mjs',
  'verify-v4-execution-binding.mjs',
  'verify-v4-feature-layer-batches.mjs',
  'verify-v4-feature-gap.mjs',
  'verify-v4-infrastructure.mjs',
  'verify-v4-node-graph.mjs',
  'verify-v4-plane-isolation.mjs',
  'verify-v4-plugin-plan.mjs',
  'verify-v4-relay-continuation.mjs',
  'verify-v4-resource-binding.mjs',
  'verify-v4-responses-direct-compat.mjs',
  'verify-v4-product-differential.mjs',
  'verify-v4-product-parity-ledger.mjs',
  'verify-v4-product-parity-status.mjs',
  'verify-v4-v3-baseline-delta.mjs',
  'verify-v4-semantic-parity.mjs',
  'verify-v4-skeleton-topology.mjs',
  'verify-v4-v3-resource-coverage.mjs',
  'verify-v4-plugin-manager.mjs',
  'verify-v4-runtime-inspector.mjs',
  'verify-v4-real-pipeline-mock-transport.mjs',
  'verify-v4-admin.mjs',
  'verify-v4-cordis-host.mjs',
  'verify-v4-node-container.mjs',
  'verify-v4-standard-plugins.mjs',
  'verify-v4-cli-plugin.mjs',
  'verify-v4-real-runtime-admission.mjs',
];

export const RED_SUITES = [
  ['verify-v4-cordis-bridge.mjs', '--red-self-test'],
  ['verify-v4-execution-binding.mjs', '--red-self-test'],
  ['verify-v4-feature-layer-batches.mjs', '--red-self-test'],
  ['verify-v4-feature-gap.mjs', '--red-self-test'],
  ['verify-v4-product-differential.mjs', '--red-self-test'],
  ['verify-v4-product-parity-ledger.mjs', '--red-self-test'],
  ['verify-v4-product-parity-status.mjs', '--red-self-test'],
  ['verify-v4-v3-baseline-delta.mjs', '--red-self-test'],
  ['verify-v4-infrastructure.mjs', '--red-self-test'],
  ['verify-v4-node-graph.mjs', '--red-self-test'],
  ['verify-v4-plane-isolation.mjs', '--red-self-test'],
  ['verify-v4-plugin-plan.mjs', '--red-self-test'],
  ['verify-v4-relay-continuation.mjs', '--red-self-test'],
  ['verify-v4-resource-binding.mjs', '--red-self-test'],
  ['verify-v4-v3-resource-coverage.mjs', '--red-self-test'],
  ['verify-v4-plugin-manager.mjs', '--red-self-test'],
  ['verify-v4-runtime-inspector.mjs', '--red-self-test'],
  ['verify-v4-real-pipeline-mock-transport.mjs', '--red-self-test'],
  ['verify-v4-admin.mjs', '--red-self-test'],
  ['verify-v4-cordis-host.mjs', '--red-self-test'],
  ['verify-v4-node-container.mjs', '--red-self-test'],
  ['verify-v4-standard-plugins.mjs', '--red-self-test'],
  ['verify-v4-cli-plugin.mjs', '--red-self-test'],
  ['verify-v4-real-runtime-admission.mjs', '--red-self-test'],
];

export const CONSUMER_REGRESSIONS = [
  ['routecodex-v4-edge', 'routecodex-v4-base-node'],
  ['routecodex-v4-config', 'routecodex-v4-base-node,routecodex-v4-edge'],
  ['routecodex-v4-control', 'routecodex-v4-base-node'],
  ['routecodex-v4-error', 'routecodex-v4-base-node'],
  ['routecodex-v4-runtime', 'routecodex-v4-error,routecodex-v4-base-node,routecodex-v4-control', '--source-deps', 'routecodex-v4-cordis-bridge,routecodex-v4-node-container,routecodex-v4-plugin-plan,routecodex-v4-skeleton,routecodex-v4-plugin-contract'],
  ['routecodex-v4-debug', 'routecodex-v4-base-node'],
  ['routecodex-v4-router', 'routecodex-v4-base-node,routecodex-v4-edge', '--rlib-deps', 'routecodex_v4_config=build-control/routecodex-v4-config/libroutecodex_v4_config.rlib'],
  ['routecodex-v4-provider', 'routecodex-v4-base-node'],
  ['routecodex-v4-server', 'routecodex-v4-base-node'],
  ['routecodex-v4-plugin-manager', 'routecodex-v4-base-node', '--source-deps', 'routecodex-v4-plugin-contract,routecodex-v4-plugin-plan,routecodex-v4-plugin-catalog'],
  ['routecodex-v4-runtime-inspector', 'routecodex-v4-base-node', '--source-deps', 'routecodex-v4-plugin-manager,routecodex-v4-plugin-contract,routecodex-v4-plugin-plan'],
  ['routecodex-v4-admin', 'routecodex-v4-base-node', '--source-deps', 'routecodex-v4-plugin-manager,routecodex-v4-runtime-inspector,routecodex-v4-plugin-contract,routecodex-v4-plugin-plan'],
  ['routecodex-v4-node-container', 'routecodex-v4-base-node', '--source-deps', 'routecodex-v4-cordis-bridge,routecodex-v4-plugin-plan'],
  ['routecodex-v4-standard-plugins', 'routecodex-v4-base-node', '--source-deps', 'routecodex-v4-plugin-contract,routecodex-v4-plugin-plan,routecodex-v4-plugin-catalog,routecodex-v4-cordis-bridge,routecodex-v4-node-container'],
  ['routecodex-v4-cli-plugin', 'routecodex-v4-base-node', '--source-deps', 'routecodex-v4-plugin-contract,routecodex-v4-plugin-plan,routecodex-v4-plugin-catalog,routecodex-v4-cordis-bridge,routecodex-v4-node-container,routecodex-v4-standard-plugins'],
];

// These are the unique active map commands that are not architecture or
// build-link consumer commands. A shared command runs once and can project
// into several map roles; it must not be copied into one entry per role.
// Strict feature-layer admission is intentionally not part of this build
// matrix: install/compile entrypoints and the dedicated admission job own it.
export const MODULE_REGRESSIONS = [
  { label: 'module:routecodex-v4-plugin-plan', command: 'cargo test -p routecodex-v4-plugin-plan --manifest-path Cargo.toml --locked' },
  { label: 'module:routecodex-v4-cordis-bridge', command: 'cargo test -p routecodex-v4-cordis-bridge --manifest-path Cargo.toml --locked' },
  { label: 'module:routecodex-v4-node-container', command: 'cargo test -p routecodex-v4-node-container --manifest-path Cargo.toml --locked' },
  { label: 'module:routecodex-v4-node-container-l2-epoch', command: 'cargo test -p routecodex-v4-node-container --test l2_epoch --manifest-path Cargo.toml --locked' },
  { label: 'module:routecodex-v4-cli', command: 'cargo test -p routecodex-v4-cli --manifest-path Cargo.toml --locked' },
  { label: 'module:routecodex-v4-lifecycle', command: 'cargo test -p routecodex-v4-lifecycle --manifest-path Cargo.toml --locked' },
  { label: 'module:routecodex-v4-servertool', command: 'cargo test -p routecodex-v4-servertool --test l2_servertool --manifest-path Cargo.toml --locked' },
  { label: 'module:feature-layer-self-test', command: 'node scripts/architecture/verify-v4-feature-layer-batches.mjs --self-test' },
  { label: 'module:feature-layer-boundary', command: 'node scripts/architecture/verify-v4-feature-layer-batches.mjs --boundary-self-test' },
  { label: 'module:standard-plugins-request', command: 'cargo test -p routecodex-v4-standard-plugins --test l2_request_plugins --manifest-path Cargo.toml --locked' },
  { label: 'module:standard-plugins-response', command: 'cargo test -p routecodex-v4-standard-plugins --test l2_response_inbound_outbound --manifest-path Cargo.toml --locked' },
  { label: 'module:standard-plugins-response-chat-process', command: 'cargo test -p routecodex-v4-standard-plugins --test l2_response_chat_process_plugins --manifest-path Cargo.toml --locked' },
  { label: 'module:routecodex-v4-runtime-l2-ports', command: 'cargo test --manifest-path Cargo.toml -p routecodex-v4-runtime --test l2_ports --locked' },
  { label: 'red:v4_runtime_003_plan_bundle', command: 'cargo test -p routecodex-v4-plugin-plan --manifest-path Cargo.toml --locked --lib rejected' },
  { label: 'red:v4_runtime_004_mount', command: 'cargo test -p routecodex-v4-cordis-bridge --manifest-path Cargo.toml --locked --test l2_bridge negative_execution_input_rejects_undeclared_fields' },
  { label: 'red:v4_node_container_epoch', command: 'cargo test -p routecodex-v4-node-container --manifest-path Cargo.toml --locked --test l2_epoch candidate_identity_failure_cannot_replace_active_epoch' },
  { label: 'red:v4_plugin_request', command: 'cargo test -p routecodex-v4-standard-plugins --test l2_request_plugins --manifest-path Cargo.toml --locked negative_request_plugins_reject_control_leakage_and_invalid_shapes' },
  { label: 'red:v4_runtime_005_request_port', command: 'cargo test --manifest-path Cargo.toml -p routecodex-v4-runtime --test l2_ports --locked request_admission_rejects_plan_epoch_drift_before_response_port' },
  { label: 'red:v4_runtime_006_response_error', command: 'cargo test --manifest-path Cargo.toml -p routecodex-v4-runtime --test l2_ports --locked error_port_rejects_binding_drift' },
];

export const ISOLATION_COMMAND = 'node scripts/verify-isolation.mjs';

export const RUNTIME_BIN_REGRESSION = 'cargo run --quiet --release --manifest-path Cargo.toml -p routecodex-v4-build-link -- test-binary --root . --consumer routecodex-v4-runtime-bin --deps routecodex-v4-base-node,routecodex-v4-edge,routecodex-v4-control,routecodex-v4-error --source-deps routecodex-v4-cli,routecodex-v4-cordis-bridge,routecodex-v4-lifecycle,routecodex-v4-node-container,routecodex-v4-plugin-plan,routecodex-v4-servertool,routecodex-v4-standard-plugins --rlib-deps routecodex_v4_config=build-control/routecodex-v4-config/libroutecodex_v4_config.rlib,routecodex_v4_provider=build-control/routecodex-v4-provider/libroutecodex_v4_provider.rlib,routecodex_v4_router=build-control/routecodex-v4-router/libroutecodex_v4_router.rlib,routecodex_v4_runtime=build-control/routecodex-v4-runtime/libroutecodex_v4_runtime.rlib,routecodex_v4_server=build-control/routecodex-v4-server/libroutecodex_v4_server.rlib --out build-control/routecodex-v4-runtime-bin/tests';

export function architectureCommand(gate, flag) {
  return ['node', `scripts/architecture/${gate}`, flag].filter(Boolean).join(' ');
}

export function consumerCommand([consumer, deps, ...extra]) {
  return [
    'cargo', 'run', '--quiet', '--release', '--manifest-path', 'Cargo.toml',
    '-p', 'routecodex-v4-build-link', '--', 'test-consumer', '--root', '.',
    '--consumer', consumer, '--deps', deps, ...extra,
  ].join(' ');
}
