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
if (!providerDirect.includes('if (errorAction && !errorAction.shouldRethrow)')) {
  failures.push('provider-direct-pipeline must consume non-rethrow ErrorErr05 action instead of always rethrowing');
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
if (!serverIndex.includes('return decideDirectProviderRetry({')) {
  failures.push('http-server provider-direct path must consume ErrorErr05 via typed direct decision action');
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
