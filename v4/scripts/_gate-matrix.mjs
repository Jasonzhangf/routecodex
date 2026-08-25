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
