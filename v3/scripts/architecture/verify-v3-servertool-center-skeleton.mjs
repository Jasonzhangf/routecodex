#!/usr/bin/env node
/**
 * verify:v3-servertool-center-skeleton
 *
 * Locks the unified ServertoolCenter skeleton contract:
 * 1. function map feature v3.servertool_center_skeleton exists with the
 *    servertool.state_machine_control resource and the 6 skeleton mainline edges.
 * 2. Servertool hooks are called only from fixed governance nodes:
 *    request hooks (apply_v3_stopless_request_hook_at_req04,
 *    apply_v3_web_search_request_hook_at_req04) only from relay_request.rs
 *    (Req04) and the direct kernel; response hooks
 *    (apply_v3_tool_call_servertool_hook_at_resp03,
 *    apply_v3_stop_servertool_hook_at_resp03) only from
 *    resp_chat_process_03_governed.rs (Resp03) and the direct kernel.
 * 3. SSE stays transport-only: the SSE crate must not reference servertool or
 *    stopless control symbols, and no SSE stream wrapper may parse control
 *    frames (wrap_direct_sse_stopless_control_stream must not reappear).
 */
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

const root = process.cwd();
const failures = [];
const read = (file) => {
  try {
    return fs.readFileSync(path.join(root, file), 'utf8');
  } catch (error) {
    failures.push(`${file}: cannot read: ${error.message}`);
    return '';
  }
};

const featureId = 'v3.servertool_center_skeleton';
const chainId = 'v3.servertool_center.skeleton';
const resourceId = 'v3.servertool.state_machine_control';

const functionMap = YAML.parse(read('docs/architecture/v3-function-map.yml'));
const mainline = YAML.parse(read('docs/architecture/v3-mainline-call-map.yml'));
const resourceMap = YAML.parse(read('docs/architecture/v3-resource-operation-map.yml'));

const feature = (functionMap.features ?? []).find((row) => row.feature_id === featureId);
if (!feature) {
  failures.push(`function map: missing feature ${featureId}`);
} else {
  if (!(feature.resource_bindings ?? []).includes(resourceId)) {
    failures.push(`function map: ${featureId} missing resource ${resourceId}`);
  }
  if (!(feature.allowed_paths ?? []).includes('docs/design/v3-servertool-center-skeleton.md')) {
    failures.push(`function map: ${featureId} missing design doc in allowed_paths`);
  }
  for (const path of ['v3/crates/routecodex-v3-sse', 'v3/crates/routecodex-v3-server/src/lib.rs']) {
    if ((feature.forbidden_paths ?? []).includes(path)) continue;
    failures.push(`function map: ${featureId} forbidden_paths missing ${path}`);
  }
}

const chain = (mainline.chains ?? []).find((row) => row.chain_id === chainId);
if (!chain) {
  failures.push(`mainline map: missing chain ${chainId}`);
} else {
  const stepIds = ['v3-servertool-center-req-01', 'v3-servertool-center-req-02', 'v3-servertool-center-req-03', 'v3-servertool-center-resp-01', 'v3-servertool-center-resp-02', 'v3-servertool-center-resp-03'];
  for (const stepId of stepIds) {
    if (!(chain.edges ?? []).some((edge) => edge.step_id === stepId)) {
      failures.push(`mainline map: chain ${chainId} missing edge ${stepId}`);
    }
  }
}

const resource = (resourceMap.resources ?? []).find((row) => row.resource_id === resourceId);
if (!resource) {
  failures.push(`resource map: missing resource ${resourceId}`);
} else if (resource.binding_status !== 'design' && resource.binding_status !== 'anchored') {
  failures.push(`resource map: ${resourceId} binding_status must be design or anchored`);
}

const requestHooks = ['apply_v3_stopless_request_hook_at_req04', 'apply_v3_web_search_request_hook_at_req04'];
const responseHooks = ['apply_v3_tool_call_servertool_hook_at_resp03', 'apply_v3_stop_servertool_hook_at_resp03'];
const fixedRequestCallers = ['relay_request.rs', 'kernel/direct_stopless.rs', 'kernel.rs'];
const fixedResponseCallers = ['resp_chat_process_03_governed.rs', 'kernel/direct_stopless.rs', 'kernel.rs'];

for (const hook of requestHooks) {
  const hookText = read('v3/crates/routecodex-v3-runtime/src/hub_v1/servertool_hooks.rs');
  if (!hookText.includes(`pub fn ${hook}`)) {
    failures.push(`servertool_hooks.rs: missing export ${hook}`);
  }
}
for (const hook of responseHooks) {
  const hookText = read('v3/crates/routecodex-v3-runtime/src/hub_v1/servertool_hooks.rs');
  if (!hookText.includes(`pub fn ${hook}`)) {
    failures.push(`servertool_hooks.rs: missing export ${hook}`);
  }
}

const allRuntime = fs.readdirSync(path.join(root, 'v3/crates/routecodex-v3-runtime/src'), { recursive: true })
  .filter((file) => file.endsWith('.rs'))
  .map((file) => path.join(root, 'v3/crates/routecodex-v3-runtime/src', file));
const runtimeRoot = path.join(root, 'v3/crates/routecodex-v3-runtime/src');
for (const file of allRuntime) {
  const rel = path.relative(root, file);
  // Test submodules (e.g. servertool_hooks_tests.rs, hub_v1/tests.rs) invoke the
  // hook under test via `use super::*`; they are not production call edges.
  if (rel.endsWith('_tests.rs') || rel.endsWith('/tests.rs')) continue;
  const content = fs.readFileSync(file, 'utf8');
  if (rel === 'v3/crates/routecodex-v3-runtime/src/hub_v1/servertool_hooks.rs') continue;
  for (const hook of [...requestHooks, ...responseHooks]) {
    if (!content.includes(hook)) continue;
    const allowed = hook.startsWith('apply_v3_stopless_request') || hook.startsWith('apply_v3_web_search_request')
      ? fixedRequestCallers
      : fixedResponseCallers;
    if (!allowed.some((caller) => rel.includes(caller))) {
      failures.push(`${rel}: servertool hook ${hook} called outside fixed governance nodes`);
    }
  }
}

const sseDir = path.join(root, 'v3/crates/routecodex-v3-sse');
if (fs.existsSync(sseDir)) {
  const sseFiles = fs.readdirSync(sseDir, { recursive: true }).filter((f) => f.endsWith('.rs'));
  for (const file of sseFiles) {
    const content = fs.readFileSync(path.join(sseDir, file), 'utf8');
    for (const controlSymbol of ['stopless', 'servertool', 'reasoningStop', 'wrap_direct_sse_stopless']) {
      if (content.toLowerCase().includes(controlSymbol.toLowerCase())) {
        failures.push(`sse crate ${file}: SSE must stay transport-only, found control symbol ${controlSymbol}`);
      }
    }
  }
}

const helpers = read('v3/crates/routecodex-v3-runtime/src/kernel/direct_runtime_helpers.rs');
if (helpers.includes('wrap_direct_sse_stopless_control_stream')) {
  failures.push('direct_runtime_helpers.rs: SSE stopless stream wrapper must not reappear');
}

if (failures.length) {
  console.error('[verify:v3-servertool-center-skeleton] failed');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log('[verify:v3-servertool-center-skeleton] ok');
