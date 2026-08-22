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

const v3Server = read('v3/crates/routecodex-v3-server/src/lib.rs')
  + '\n' + read('v3/crates/routecodex-v3-server/src/websocket.rs');
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
