import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const exts = new Set(['.ts', '.tsx', '.js', '.mjs', '.rs']);
const ERROR_PIPELINE_CONTRACT_FEATURE_ID = 'feature_id: error.pipeline_contract';
const ERROR_PIPELINE_CONTRACT_BUILDERS = [
  'capture_error_err_02_host_from_error_err_01_source',
  'report_error_err_02_host_to_router_policy_from_error_err_01_source',
];

function read(relPath) {
  return fs.readFileSync(path.join(root, relPath), 'utf8');
}

function listFiles(relPath) {
  const abs = path.join(root, relPath);
  if (!fs.existsSync(abs)) return [];
  const stat = fs.statSync(abs);
  if (stat.isFile()) return [abs];
  const out = [];
  const stack = [abs];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const next = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'dist' || entry.name === 'node_modules' || entry.name === 'coverage' || entry.name === 'target') continue;
        stack.push(next);
        continue;
      }
      if (entry.isFile() && exts.has(path.extname(entry.name)) && !entry.name.endsWith('.d.ts')) {
        out.push(next);
      }
    }
  }
  return out;
}

function rel(filePath) {
  return path.relative(root, filePath);
}

function lineFindings(relPath, pattern, label, allow = () => false) {
  const failures = [];
  for (const file of listFiles(relPath)) {
    const relative = rel(file);
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, index) => {
      if (pattern.test(line) && !allow(relative, line)) {
        failures.push(`${label}: ${relative}:${index + 1}: ${line.trim()}`);
      }
    });
  }
  return failures;
}

const failures = [];

if (!ERROR_PIPELINE_CONTRACT_FEATURE_ID || ERROR_PIPELINE_CONTRACT_BUILDERS.length !== 2) {
  failures.push('error pipeline contract gate must declare feature id and ErrorErr01/02 owner builders');
}

const baseProvider = read('src/providers/core/runtime/base-provider.ts');
const providerSendCalls = [...baseProvider.matchAll(/sendRequestInternal\s*\(\s*processedRequest\s*\)/g)];
if (providerSendCalls.length !== 1) {
  failures.push(`provider runtime must call sendRequestInternal(processedRequest) exactly once before ErrorErr reporting; found ${providerSendCalls.length}`);
}
if (!baseProvider.includes('await this.handleRequestError(error, context);')) {
  failures.push('BaseProvider request catch must await ErrorErr reporting before rethrowing provider errors');
}
if (!baseProvider.includes('await emitProviderErrorAndWait({')) {
  failures.push('BaseProvider request-path provider.http errors must use awaited ErrorErr reporting');
}
if (/autoRetry|auto-retry|resolveAutoRetryErrorCode/.test(baseProvider)) {
  failures.push('BaseProvider must not contain provider-local autoRetry policy');
}

for (const relPath of [
  'src/providers/core/api/provider-types.ts',
  'src/providers/profile/provider-profile.ts',
  'src/providers/profile/provider-profile-loader.ts',
  'src/server/runtime/http-server/http-server-bootstrap.ts',
]) {
  if (/autoRetry|auto-retry|AutoRetry/.test(read(relPath))) {
    failures.push(`${relPath} must not expose provider-local autoRetry runtime/config semantics`);
  }
}

if (fs.existsSync(path.join(root, 'src/providers/core/runtime/auto-retry-error-codes.ts'))) {
  failures.push('src/providers/core/runtime/auto-retry-error-codes.ts must stay physically deleted');
}

const providerDirect = read('src/server/runtime/http-server/provider-direct-pipeline.ts');
if (!providerDirect.includes('onProviderError?: (error: unknown, context: ProviderDirectAuditContext)')) {
  failures.push('provider-direct-pipeline must expose an ErrorErr onProviderError hook');
}
if (!providerDirect.includes('const errorAction = await options.onProviderError?.(error, auditContext);')) {
  failures.push('provider-direct-pipeline must await ErrorErr05 action from caller-owned onProviderError hook');
}
for (const action of ['wait_then_retry_same', 'wait_then_reselect', 'project_terminal']) {
  if (!providerDirect.includes(`errorAction.action === '${action}'`)) {
    failures.push(`provider-direct-pipeline must consume typed ErrorErr05 ${action} action`);
  }
}
if (providerDirect.includes('shouldRethrow') || providerDirect.includes('request_reroute')) {
  failures.push('provider-direct-pipeline must not consume removed untyped direct-decision actions');
}
if (!providerDirect.includes('errorAction,')) {
  failures.push('provider-direct-pipeline must return caller-owned ErrorErr05 action to the HTTP/direct consumer');
}

const serverIndex = read('src/server/runtime/http-server/index.ts');
if (!serverIndex.includes('provider-direct.send.error')) {
  failures.push('http-server provider-direct live path must log provider-direct.send.error before ErrorErr reporting');
}
if (!serverIndex.includes("source: 'provider-direct'")) {
  failures.push('http-server provider-direct live path must tag ErrorErr details with source=provider-direct');
}
if (!/onProviderError:\s*async\s*\(error,\s*context\)/.test(serverIndex)) {
  failures.push('http-server provider-direct live path must wire an async onProviderError hook');
}
if (!serverIndex.includes('await resolveRequestExecutorProviderFailurePlan({')) {
  failures.push('http-server provider-direct path must build the ErrorErr05 decision wrapper');
}
if (!serverIndex.includes('return directFailurePlan.retryExecutionPlan;')) {
  failures.push('http-server provider-direct path must return the Rust-owned typed ErrorErr05 execution decision');
}
if (!serverIndex.includes("routeName: 'default'") || !serverIndex.includes('defaultPoolSingletonProvider')) {
  failures.push('http-server provider-direct path must model its explicit binding as the default singleton tier');
}
if (serverIndex.includes('decideDirectProviderRetry') || serverIndex.includes('defaultTierAvailable: false')) {
  failures.push('http-server provider-direct path must not restore removed TS policy or a false default-pool claim');
}

const handlerUtils = read('src/server/handlers/handler-utils.ts');
if (/\?\s*mapErrorToHttp\s*\(/.test(handlerUtils)) {
  failures.push('HTTP handlers must not use mapErrorToHttp as a fallback when ErrorErr05 is absent');
}
if (!handlerUtils.includes('Typed execution decision is required before client error projection')) {
  failures.push('HTTP handlers must fail-fast when the unified ErrorErr05 decision carrier is absent');
}

const routeErrorHub = read('src/error-handling/route-error-hub.ts');
if (/\bmapErrorToHttp\b|includeHttpResult|buildHttpPayload/.test(routeErrorHub)) {
  failures.push('RouteErrorHub must report errors only and must not own ErrorErr06 HTTP projection');
}

const v3Server = read('v3/crates/routecodex-v3-server/src/lib.rs');
const v3Error = read('v3/crates/routecodex-v3-error/src/lib.rs');
for (const bypass of [
  'json!({"error":{"message":"forbidden","code":"forbidden"}})',
  'json!({"error":{"message":message,"code":"virtual_router_diagnostics_failed"}})',
  'json!({"error":{"message":message,"code":"virtual_router_dry_run_failed"}})',
]) {
  if (v3Server.includes(bypass)) {
    failures.push(`V3 Server must not bypass ErrorErr01-06 with direct error JSON: ${bypass}`);
  }
}
if (!v3Server.includes('let projected = project_v3_server_websocket_error(')) {
  failures.push('V3 WebSocket event projection must call the routecodex-v3-error owned helper');
}
if (
  !v3Error.includes('pub fn project_v3_server_websocket_error(')
  || !v3Error.includes('project_v3_server_invalid_request(')
  || !v3Error.includes('project_v3_server_runtime_failure(')
  || !v3Error.includes('V3ErrorHandlingCenter::handle(V3ErrorHandlingCenterInput {')
) {
  failures.push('V3 WebSocket errors must enter the shared ErrorErr01-06 center before event projection');
}
if (!serverIndex.includes('await processProviderSendFailure({')) {
  failures.push('http-server router-direct path must consume ErrorErr05 through processProviderSendFailure');
}
if (!serverIndex.includes('router-direct.retry.requested')) {
  failures.push('http-server router-direct path must drive recursive retry/default-pool handling after ErrorErr05 consumption');
}

failures.push(...lineFindings(
  'src',
  /\bemitProviderError\s*\(/,
  'production request/runtime paths must not use fire-and-forget provider error reporting',
  (file) => file === 'src/providers/core/utils/provider-error-reporter.ts'
));

for (const relPath of [
  'src/providers/core/runtime/base-provider.ts',
  'src/providers/core/runtime/responses-provider.ts',
  'src/server/runtime/http-server/http-server-runtime-providers.ts',
]) {
  const source = read(relPath);
  if (!source.includes('emitProviderErrorAndWait')) {
    failures.push(`${relPath} must use awaited ErrorErr reporting`);
  }
}

failures.push(...lineFindings(
  'src',
  /\breportProviderErrorToRouterPolicy\s*\(\s*\{/,
  'manual ErrorErr04 report construction outside ErrorErr02 owner',
  (file) => file === 'src/providers/core/utils/provider-error-reporter.ts'
));

failures.push(...lineFindings(
  'src',
  /\bErrorHandlingCenter\b/,
  'ErrorHandlingCenter must not enter provider policy/direct/executor modules',
  (file) => {
    return !(
      file.includes('src/providers/core/runtime')
      || file.includes('src/providers/core/utils/provider-error-reporter')
      || file.includes('src/server/runtime/http-server/executor')
      || file.includes('src/server/runtime/http-server/provider-direct-pipeline')
      || file.includes('src/server/runtime/http-server/router-direct-pipeline')
    );
  }
));

if (failures.length > 0) {
  console.error('[verify:error-pipeline-contract] failed');
  failures.slice(0, 160).forEach((failure) => console.error(`- ${failure}`));
  if (failures.length > 160) console.error(`- ... ${failures.length - 160} more`);
  process.exit(1);
}

console.log('[verify:error-pipeline-contract] ok');
console.log('- provider-local autoRetry runtime semantics absent');
console.log('- provider-direct/router-direct provider failures enter ErrorErr05 action consumption before projection');
console.log('- provider policy/direct/executor stay independent from ErrorHandlingCenter');
