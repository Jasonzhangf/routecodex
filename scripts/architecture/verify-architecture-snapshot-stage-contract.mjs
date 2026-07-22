import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const failures = [];

function read(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

const stagePolicy = read('src/utils/snapshot-stage-policy.ts');
const cliStart = read('src/cli/commands/start.ts');
const contractDoc = read('docs/architecture/snapshot-stage-contract.md');
const routeDoc = read('docs/agent-routing/10-runtime-ssot-routing.md');
const archReadme = read('docs/architecture/README.md');
const v3DebugRuntime = read('v3/crates/routecodex-v3-debug/src/lib.rs');
const v3Cli = read('v3/crates/routecodex-v3-cli/src/main.rs');
const v3Server = read('v3/crates/routecodex-v3-server/src/lib.rs');
const v3ResponsesRelayRuntime = read('v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs');
const providerWriter = read('src/debug/snapshot/provider-writer.ts');
const httpRequestExecutor = read('src/providers/core/runtime/http-request-executor.ts');
const responsesProvider = read('src/providers/core/runtime/responses-provider.ts');
const httpServer = read('src/server/runtime/http-server/index.ts');
const routerDirectFailureSnapshot = read('src/server/runtime/http-server/router-direct-failure-snapshot.ts');
const rustHubSnapshotHooks = read('sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_snapshot_hooks.rs');
const snapshotRequestRetention = read('src/utils/snapshot-request-retention.ts');
const snapshotStoplessSources = [
  ['v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs', v3ResponsesRelayRuntime],
  ['v3/crates/routecodex-v3-debug/src/lib.rs', v3DebugRuntime],
];
const testsToRequire = [
  'tests/utils/snapshot-stage-policy.spec.ts',
  'tests/providers/core/utils/snapshot-writer.release-gating.spec.ts',
  'tests/debug/snapshot-store-port-isolation.red.spec.ts',
  'tests/provider/http-request-executor-sse-snapshot.spec.ts',
  'tests/server/handlers/handler-response-utils.required-action-split-frame.spec.ts',
];

for (const rel of testsToRequire) {
  if (!fs.existsSync(path.join(root, rel))) {
    failures.push(`missing required snapshot coverage test: ${rel}`);
  }
}

for (const token of ['client-request', 'provider-response', 'client-response']) {
  if (!stagePolicy.includes(`'${token}'`)) {
    failures.push(`default snapshot selector missing edge stage: ${token}`);
  }
  if (!contractDoc.includes(`- \`${token}\``)) {
    failures.push(`snapshot contract doc missing default edge stage: ${token}`);
  }
}

if (stagePolicy.includes("'provider-request'")) {
  failures.push('legacy TS default snapshot selector must not include provider-request body snapshots');
}
for (const token of [
  'V3 live `rccv3 start --snap` 默认必须打开四类真实边界快照',
  '`provider-request` 在 V3 live 中不是手工构造、dry-run 构造或 Hub 重建样本',
  '唯一 owner 是 live provider transport cutpoint recorder',
  'SSE 情况下 `response.json.rawSse` 至少能对账',
  'V2/legacy `provider-request` 不属于默认集',
  '显式 `--snap-stages provider-request`',
  'force-local debug 捕获',
]) {
  if (!contractDoc.includes(token)) {
    failures.push(`snapshot contract doc missing provider-request live/legacy boundary: ${token}`);
  }
}
for (const token of [
  'diagnostic correlation only',
  'L8 observability/debug',
  'L5 Metadata Center',
  'must never restore or own StoplessCenter control truth',
  '禁止从 snapshot metadata、debug metadata 或 `__runtime.json` restore / hydrate / rebuild StoplessCenter state',
]) {
  if (!contractDoc.includes(token)) {
    failures.push(`snapshot contract doc missing StoplessCenter observability-only boundary: ${token}`);
  }
}
const forbiddenStoplessSnapshotRestorePatterns = [
  /(?:restore|hydrate|rebuild|load)[A-Za-z0-9_\s]*(?:stopless|StoplessCenter)[A-Za-z0-9_\s]*(?:snapshot|debug|runtime_json)/u,
  /(?:snapshot|debug|runtime_json)[A-Za-z0-9_\s]*(?:restore|hydrate|rebuild|load)[A-Za-z0-9_\s]*(?:stopless|StoplessCenter)/u,
];
for (const [rel, source] of snapshotStoplessSources) {
  if (forbiddenStoplessSnapshotRestorePatterns.some((pattern) => pattern.test(source))) {
    failures.push(`${rel}: snapshot/debug artifacts must not restore StoplessCenter control truth`);
  }
}
for (const token of ['client-request', 'provider-request', 'provider-response', 'client-response']) {
  if (!v3DebugRuntime.includes(token)) {
    failures.push(`V3 default snapshot selector missing live edge stage: ${token}`);
  }
}
if (!v3DebugRuntime.includes('V3_DEFAULT_SNAPSHOT_STAGE_SELECTOR')) {
  failures.push('V3 debug runtime must expose a V3-specific default snapshot stage selector');
}
if (!v3DebugRuntime.includes('should_capture_v3_snapshot_stage')) {
  failures.push('V3 debug runtime must expose a local snapshot stage selector helper');
}
if (!v3Cli.includes('snap_stages')) {
  failures.push('V3 CLI must accept --snap-stages and propagate it to managed lifecycle');
}
for (const token of [
  'V3LiveSnapResponsesTransport',
  'V3LiveSnapClientResponseSseRecorder',
  'capture_v3_responses_relay_provider_snapshots',
  'live_server_response_stream',
  '"provider-request.json"',
  '"provider-response.json"',
  '"response.json"',
  '"rawSse"',
]) {
  if (!`${v3Server}\n${v3ResponsesRelayRuntime}`.includes(token)) {
    failures.push(`V3 live server must capture real provider cutpoint samples: ${token}`);
  }
}
if (!providerWriter.includes('forceLocalDiskWriteWhenDisabled: options.forceLocalDiskWriteWhenDisabled')) {
  failures.push('snapshot writer must preserve force-local provider-request repro capture through persist input');
}
if (!rustHubSnapshotHooks.includes('provider-request body snapshots are disabled')) {
  failures.push('Rust hub snapshot hook must hard-reject provider-request body snapshots');
}
if (!snapshotRequestRetention.includes('fsp.link(tmp, target)')) {
  failures.push('snapshot runtime marker must be atomically published via temp file + link');
}
if (snapshotRequestRetention.includes('fsp.writeFile(target')) {
  failures.push('snapshot runtime marker must not write directly to __runtime.json with a visible half-written file window');
}
if (!rustHubSnapshotHooks.includes('invalid_existing_runtime_metadata')) {
  failures.push('Rust hub snapshot hook must repair invalid existing runtime metadata with an explicit diagnostic');
}
for (const [rel, source] of [
  ['src/providers/core/runtime/responses-provider.ts', responsesProvider],
]) {
  for (const forbidden of [
    "phase: 'provider-request'",
    "snapshotPhase('provider-request'",
    'snapshotProviderRequest(',
    'captureRouterDirectProviderRequestSnapshot',
  ]) {
    if (source.includes(forbidden)) {
      failures.push(`${rel} must not write provider-request body snapshots (${forbidden})`);
    }
  }
}
if (!httpRequestExecutor.includes("phase: 'provider-request'")) {
  failures.push('provider runtime must capture provider-request replay snapshots from final PreparedHttpRequest body');
}
if (!httpServer.includes('captureRouterDirectProviderRequestSnapshot')) {
  failures.push('router-direct must capture provider-request replay snapshots before direct provider send');
}
if (!routerDirectFailureSnapshot.includes("phase: 'provider-request'")) {
  failures.push('router-direct failure snapshot helper must be the direct provider-request snapshot owner');
}

for (const token of [
  'provider-request-contract',
  'provider-request.retry',
  'provider-response-contract',
  'provider-response.retry',
  'provider-error',
  'client-response.error',
  'chat_process.req.*',
  'chat_process.resp.*',
  'hub_followup.*',
  'servertool.*',
]) {
  if (!contractDoc.includes(token)) {
    failures.push(`snapshot contract doc missing stage family: ${token}`);
  }
}

if (!cliStart.includes("--snap") || !cliStart.includes("--snap-stages")) {
  failures.push('CLI start contract missing --snap / --snap-stages options');
}

if (!archReadme.includes('snapshot-stage-contract.md')) {
  failures.push('architecture README must reference snapshot-stage-contract.md');
}

if (!routeDoc.includes('snapshot-stage-contract.md')) {
  failures.push('runtime routing doc must reference snapshot-stage-contract.md');
}

if (failures.length > 0) {
  console.error('[verify:architecture-snapshot-stage-contract] failed');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('[verify:architecture-snapshot-stage-contract] ok');
console.log(`- checked required tests: ${testsToRequire.length}`);
