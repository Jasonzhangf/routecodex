#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const check = process.argv.includes('--check');
const manifestRel = 'docs/architecture/manifests/v3.execution_control_payload_architecture.mainline.yml';
const resourceMapRel = 'docs/architecture/v3-resource-operation-map.yml';
const functionMapRel = 'docs/architecture/v3-function-map.yml';
const callMapRel = 'docs/architecture/v3-mainline-call-map.yml';
const moduleRegistryRel = 'docs/architecture/v3-runtime-module-registry.yml';
const verificationMapRel = 'docs/architecture/v3-verification-map.yml';
const packageRel = 'v3/package.json';
const runtimeSourceRootRel = 'v3/crates/routecodex-v3-runtime/src';
const runtimeNodesRel = `${runtimeSourceRootRel}/nodes.rs`;
const providerFailurePolicyRel = `${runtimeSourceRootRel}/provider_failure_runtime_policy.rs`;
const directContinuationCommitRel = `${runtimeSourceRootRel}/kernel/direct_continuation_commit.rs`;
const directKernelRel = `${runtimeSourceRootRel}/kernel.rs`;
const directCoreRel = `${runtimeSourceRootRel}/kernel/v3_direct_core.rs`;
const providerHealthRel = 'v3/crates/routecodex-v3-provider-responses/src/health.rs';
const webuiObservabilityRel = 'v3/crates/routecodex-v3-server/src/webui_observability.rs';
const observabilityStoreRel = 'v3/crates/routecodex-v3-debug/src/observability_store.rs';
const configLibRel = 'v3/crates/routecodex-v3-config/src/lib.rs';
const serverLibRel = 'v3/crates/routecodex-v3-server/src/lib.rs';
const failures = [];

const readText = (rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');
const readYaml = (rel) => YAML.parse(readText(rel)) ?? {};
const array = (value) => Array.isArray(value) ? value : [];
const requireValue = (condition, message) => { if (!condition) failures.push(message); };

const manifest = readYaml(manifestRel);
const resourceMap = readYaml(resourceMapRel);
const functionMap = readYaml(functionMapRel);
const callMap = readYaml(callMapRel);
const moduleRegistry = readYaml(moduleRegistryRel);
const verificationMap = readYaml(verificationMapRel);
const packageJson = JSON.parse(readText(packageRel));

validateContracts();
const markdown = renderMarkdown();
const html = renderHtml();

if (failures.length === 0) {
  writeOrCompare(manifest.generated_docs.markdown, markdown);
  writeOrCompare(manifest.generated_docs.html, html);
}

if (failures.length > 0) {
  console.error('[render:v3-execution-control-payload-architecture] failed');
  for (const failure of failures) console.error(`- ${failure}`);
  if (check) console.error('- run `npm run render:v3-execution-control-payload-architecture`');
  process.exit(1);
}

console.log(check
  ? '[verify:v3-execution-control-payload-architecture] ok'
  : '[render:v3-execution-control-payload-architecture] ok');
console.log(`- markdown ${manifest.generated_docs.markdown}`);
console.log(`- html ${manifest.generated_docs.html}`);

function validateContracts() {
  requireValue(manifest.lifecycle_id === 'v3.execution_control_payload_architecture', `${manifestRel}: lifecycle_id mismatch`);
  requireValue(manifest.status === 'active', `${manifestRel}: lifecycle status must be active`);
  requireValue(manifest.owner_feature_id === 'v3.execution_request_lifecycle', `${manifestRel}: owner_feature_id mismatch`);
  requireValue(array(manifest.current_runtime_red_bindings).length === 0, `${manifestRel}: current runtime-red bindings must be empty`);
  requireValue(manifest.entrypoint?.call_map_chain_id === manifest.lifecycle_id, `${manifestRel}: call-map chain mismatch`);
  requireValue(manifest.budget_contract?.reserve_before_append_or_copy === true, `${manifestRel}: reserve-before-append required`);
  requireValue(manifest.budget_contract?.disk_spill === 'forbidden', `${manifestRel}: initial disk spill must be forbidden`);
  for (const dimension of ['per_attempt', 'per_request', 'process_global', 'residence_or_deadline']) {
    requireValue(manifest.budget_contract?.[dimension] === 'required', `${manifestRel}: missing budget ${dimension}`);
  }
  for (const kind of ['Upstream', 'Protocol', 'LocalResourceExhausted', 'ObservationFailure', 'PersistenceFailure', 'ClientCancelled']) {
    requireValue(array(manifest.failure_kinds).includes(kind), `${manifestRel}: missing failure kind ${kind}`);
  }
  for (const forbidden of ['temporary_runtime', 'stream_wrapper_executor_reentry', 'route_pool_rehit', 'payload_control_reconstruction']) {
    requireValue(array(manifest.module_contracts?.runtime?.forbids).includes(forbidden), `${manifestRel}: runtime forbidden contract missing ${forbidden}`);
  }
  const resourceIds = new Set(array(resourceMap.resources).map((row) => row?.resource_id));
  for (const id of [
    ...array(manifest.control_resources),
    ...array(manifest.payload_resources),
    ...array(manifest.diagnostic_resources),
    ...array(manifest.persistence_resources),
  ]) requireValue(resourceIds.has(id), `${resourceMapRel}: missing manifest resource ${id}`);
  const targetFeatureIds = [
    'v3.execution_request_lifecycle',
    'v3.execution_attempt_budget_store',
    'v3.execution_attempt_success_receipt',
    'v3.execution_stream_control_diagnostics_split',
    'v3.provider_health_persistence_isolation',
    'v3.observability_persistence_isolation',
  ];
  for (const id of targetFeatureIds) {
    const feature = array(functionMap.features).find((row) => row?.feature_id === id);
    requireValue(Boolean(feature), `${functionMapRel}: missing feature ${id}`);
    requireValue(feature?.status === 'active', `${functionMapRel}: feature ${id} must be active`);
  }
  const chain = array(callMap.chains).find((row) => row?.chain_id === manifest.lifecycle_id);
  requireValue(Boolean(chain), `${callMapRel}: missing chain ${manifest.lifecycle_id}`);
  const callEdges = new Map(array(chain?.edges).map((row) => [row?.step_id, row]));
  for (const edge of array(manifest.edges)) {
    requireValue(edge?.status === 'active', `${manifestRel}: edge ${edge?.step_id} must be active`);
    const bound = callEdges.get(edge.step_id);
    requireValue(Boolean(bound), `${callMapRel}: missing edge ${edge.step_id}`);
    requireValue(bound?.from_node === edge.from_node && bound?.to_node === edge.to_node, `${callMapRel}: edge endpoints drift ${edge.step_id}`);
    requireValue(['active', 'anchored'].includes(bound?.status), `${callMapRel}: edge ${edge.step_id} must be active or anchored`);
  }
  for (const id of ['v3.execution_control_payload.runtime', 'v3.execution_control_payload.provider_responses', 'v3.execution_control_payload.server', 'v3.execution_control_payload.config']) {
    const contract = array(moduleRegistry.responsibility_contracts).find((row) => row?.contract_id === id);
    requireValue(Boolean(contract), `${moduleRegistryRel}: missing responsibility ${id}`);
    requireValue(contract?.binding_status === 'active', `${moduleRegistryRel}: responsibility ${id} must be active`);
  }
  const verificationFeature = array(verificationMap.features).find((row) => row?.feature_id === 'v3.execution_control_payload_architecture');
  requireValue(Boolean(verificationFeature), `${verificationMapRel}: missing verification feature`);
  requireValue(verificationFeature?.status === 'active', `${verificationMapRel}: verification feature must be active`);
  const targetMapText = [resourceMapRel, functionMapRel, callMapRel, moduleRegistryRel, verificationMapRel]
    .map((rel) => readText(rel))
    .join('\n');
  for (const removed of [
    'V3DirectSseAttemptBuffer',
    'wrap_direct_sse_provider_handoff_stream_with_observation',
    'execute_v3_responses_direct_runtime_kernel_core_with_handoff_budget',
  ]) requireValue(!targetMapText.includes(removed), `target architecture maps retain removed symbol ${removed}`);
  for (const gate of ['npm run verify:v3-execution-control-payload-architecture', 'npm run test:v3-execution-control-payload-architecture-red-fixtures']) {
    requireValue(array(manifest.verification_gates).includes(gate), `${manifestRel}: missing gate ${gate}`);
  }
  const scripts = packageJson.scripts ?? {};
  requireValue(scripts['render:v3-execution-control-payload-architecture'] === 'node scripts/architecture/render-v3-execution-control-payload-architecture.mjs', `${packageRel}: render script mismatch`);
  requireValue(scripts['verify:v3-execution-control-payload-architecture'] === 'node scripts/architecture/verify-v3-execution-control-payload-architecture.mjs', `${packageRel}: verify script mismatch`);
  requireValue(scripts['test:v3-execution-control-payload-architecture-red-fixtures'] === 'node scripts/tests/v3-execution-control-payload-architecture-red-fixtures.mjs', `${packageRel}: red-fixture script mismatch`);
  requireValue(String(scripts['verify:v3-architecture-docs'] ?? '').includes('verify:v3-execution-control-payload-architecture'), `${packageRel}: architecture docs gate must include execution-control verifier`);
  validateSuccessReceiptSource();
  validateRuntimeIsolationSource();
}

function validateSuccessReceiptSource() {
  const nodes = readText(runtimeNodesRel);
  requireValue(nodes.includes('pub struct V3AttemptSuccessReceipt {\n    _runtime_sealed: (),\n}'), `${runtimeNodesRel}: success receipt field must remain private`);
  for (const constructor of ['from_buffered_terminal_attempt', 'from_sealed_sse_attempt', 'from_protocol_terminal_attempt']) {
    requireValue(nodes.includes(`pub(crate) fn ${constructor}`), `${runtimeNodesRel}: success receipt constructor ${constructor} must remain crate-private`);
    requireValue(!nodes.includes(`pub fn ${constructor}`), `${runtimeNodesRel}: success receipt constructor ${constructor} must not be public`);
  }

  const owners = new Set(array(manifest.success_receipt_contract?.source_owner_files));
  for (const rel of rustFiles(path.join(repoRoot, runtimeSourceRootRel))) {
    const source = readText(rel);
    if (source.includes('V3AttemptSuccessReceipt::from_')) {
      requireValue(owners.has(rel), `${rel}: success receipt constructor used outside registered terminal/seal owner`);
    }
  }

  const providerFailurePolicy = readText(providerFailurePolicyRel);
  requireValue(
    /fn record_provider_success_in_failure_scope\([\s\S]{0,180}&crate::nodes::V3AttemptSuccessReceipt/u.test(providerFailurePolicy),
    `${providerFailurePolicyRel}: provider health success must require success receipt`,
  );
  const directContinuationCommit = readText(directContinuationCommitRel);
  requireValue(
    /fn commit_or_release_v3_direct_continuation\([\s\S]{0,120}&V3AttemptSuccessReceipt/u.test(directContinuationCommit),
    `${directContinuationCommitRel}: continuation commit must require success receipt`,
  );
}

function rustFiles(root) {
  const files = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...rustFiles(absolute));
    else if (entry.isFile() && entry.name.endsWith('.rs')) files.push(path.relative(repoRoot, absolute));
  }
  return files;
}

function validateRuntimeIsolationSource() {
  for (const rel of [directKernelRel, directCoreRel]) {
    const source = readText(rel);
    requireValue(!source.includes('responses:deepseek-console-go') && !source.includes('responses:thinking-tags'), `${rel}: execution skeleton must not inspect compatibility profile strings`);
  }

  const health = readText(providerHealthRel);
  const persistenceProjection = health.slice(
    health.indexOf('fn persist_cooldown_state'),
    health.indexOf('impl V3ProviderAvailabilityReader for V3ProviderHealthStore'),
  );
  requireValue(health.includes('mpsc::sync_channel(V3_PROVIDER_HEALTH_PERSISTENCE_QUEUE_CAPACITY)'), `${providerHealthRel}: bounded single persistence writer missing`);
  requireValue(persistenceProjection.includes('writer.enqueue(provider_cooldown_persistence_entries(state))'), `${providerHealthRel}: health mutation must enqueue lock-free persistence projection`);
  requireValue(!persistenceProjection.includes('replace_entries(') && !persistenceProjection.includes('fs::'), `${providerHealthRel}: health persistence projection performs synchronous disk IO`);

  const webui = readText(webuiObservabilityRel);
  const observabilityStore = readText(observabilityStoreRel);
  const configLib = readText(configLibRel);
  const recordStart = webui.indexOf('pub(crate) fn record_observed(');
  const appendStart = webui.indexOf('pub(crate) fn append_persisted_row(', recordStart);
  const recordObserved = webui.slice(recordStart, appendStart);
  requireValue(webui.includes('mpsc::sync_channel(V3_WEBUI_PERSISTENCE_QUEUE_CAPACITY)'), `${webuiObservabilityRel}: bounded single observability writer missing`);
  requireValue(webui.includes('v3_webui_observability_read_rows_bounded(') && webui.includes('V3_WEBUI_RECENT_REQUEST_CAPACITY'), `${webuiObservabilityRel}: bounded startup load missing`);
  requireValue(recordObserved.indexOf('drop(inner);') >= 0 && recordObserved.indexOf('drop(inner);') < recordObserved.indexOf('writer.enqueue(row);'), `${webuiObservabilityRel}: observability persistence must enqueue after releasing request mutex`);
  requireValue(!recordObserved.includes('append_persisted_row(') && !recordObserved.includes('v3_webui_observability_append_row('), `${webuiObservabilityRel}: request hot path performs synchronous observability disk IO`);
  requireValue(observabilityStore.includes('pub fn v3_webui_observability_append_row(') && observabilityStore.includes('pub fn v3_webui_observability_read_rows_bounded('), `${observabilityStoreRel}: observability storage owner is incomplete`);
  requireValue(!configLib.includes('v3_webui_observability_append_row') && !configLib.includes('v3_webui_observability_read_rows'), `${configLibRel}: Config must not export runtime observability IO`);

  const server = readText(serverLibRel);
  const prepareStart = server.indexOf('pub async fn prepare_for_exec');
  const prepareEnd = server.indexOf('pub fn restore_front_checkpoints', prepareStart);
  requireValue(server.slice(prepareStart, prepareEnd).includes('self.flush_runtime_persistence();'), `${serverLibRel}: exec shutdown must await persistence flush receipts`);
}

function renderMarkdown() {
  const lines = [
    '<!-- AUTO-GENERATED: edit the manifest/maps, then run `npm run render:v3-execution-control-payload-architecture`. -->',
    '# V3 Execution Control / Payload Architecture',
    '',
    `Status: \`${manifest.status}\``,
    '',
    manifest.summary,
    '',
    '## Canonical Sources',
    '',
    ...Object.entries(manifest.canonical_docs).map(([name, rel]) => `- ${name}: \`${rel}\``),
    `- manifest: \`${manifestRel}\``,
    `- resource map: \`${resourceMapRel}\``,
    `- function map: \`${functionMapRel}\``,
    `- call map: \`${callMapRel}\``,
    `- module registry: \`${moduleRegistryRel}\``,
    `- verification map: \`${verificationMapRel}\``,
    '',
    '## Lifecycle',
    '',
    '```mermaid',
    'flowchart LR',
    ...array(manifest.edges).map((edge) => `  ${safeId(edge.from_node)}["${edge.from_node}"] -->|${edge.step_id}| ${safeId(edge.to_node)}["${edge.to_node}"]`),
    '```',
    '',
    '## Control, Payload, Diagnostics, Persistence',
    '',
    '| lane | resources | execution authority |',
    '| --- | --- | --- |',
    `| control | ${codeList(manifest.control_resources)} | request lifecycle only |`,
    `| payload | ${codeList(manifest.payload_resources)} | none; bounded storage only |`,
    `| diagnostics | ${codeList(manifest.diagnostic_resources)} | none |`,
    `| persistence | ${codeList(manifest.persistence_resources)} | none; ordered bounded writers |`,
    '',
    '## Budget Contract',
    '',
    `- Per attempt: \`${manifest.budget_contract.per_attempt}\``,
    `- Per request: \`${manifest.budget_contract.per_request}\``,
    `- Process global: \`${manifest.budget_contract.process_global}\``,
    `- Residence/deadline: \`${manifest.budget_contract.residence_or_deadline}\``,
    `- Reserve before append/copy: \`${manifest.budget_contract.reserve_before_append_or_copy}\``,
    `- Initial storage: \`${manifest.budget_contract.initial_storage}\``,
    `- Disk spill: \`${manifest.budget_contract.disk_spill}\``,
    '',
    '## Success and Failure Truth',
    '',
    `- Success issuer: \`${manifest.success_receipt_contract.issuer}\``,
    `- Success consumers: ${codeList(manifest.success_receipt_contract.consumers)}`,
    `- Forbidden success evidence: ${codeList(manifest.success_receipt_contract.forbidden_evidence)}`,
    `- Failure kinds: ${codeList(manifest.failure_kinds)}`,
    '',
    '## Current Runtime-Red Bindings',
    '',
    '| issue | current symbols |',
    '| --- | --- |',
    ...array(manifest.current_runtime_red_bindings).map((row) => `| \`${row.id}\` | ${codeList(row.symbols)} |`),
    '',
    '## Module Responsibilities',
    '',
  ];
  for (const [name, contract] of Object.entries(manifest.module_contracts)) {
    lines.push(`### ${name}`, '', `Owns: ${codeList(contract.owns)}`, '', `Forbids: ${codeList(contract.forbids)}`, '');
  }
  lines.push(
    '## Completion Gate',
    '',
    ...Object.entries(manifest.completion_contract).map(([key, value]) => `- \`${key}\`: \`${value}\``),
    '',
    '## Verification',
    '',
    ...array(manifest.verification_gates).map((gate) => `- \`${gate}\``),
  );
  return `${lines.join('\n')}\n`;
}

function renderHtml() {
  const nodeCards = array(manifest.node_ids)
    .map((node) => `<li><code>${escapeHtml(node)}</code></li>`)
    .join('');
  const issueRows = array(manifest.current_runtime_red_bindings)
    .map((row) => `<tr><td><code>${escapeHtml(row.id)}</code></td><td>${array(row.symbols).map((value) => `<code>${escapeHtml(value)}</code>`).join('<br>')}</td></tr>`)
    .join('');
  const moduleSections = Object.entries(manifest.module_contracts)
    .map(([name, contract]) => `<section><h2>${escapeHtml(name)}</h2><h3>Owns</h3>${htmlList(contract.owns)}<h3>Forbids</h3>${htmlList(contract.forbids)}</section>`)
    .join('');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>V3 Execution Control / Payload Architecture</title>
<style>body{font-family:ui-sans-serif,system-ui,-apple-system,sans-serif;max-width:1120px;margin:0 auto;padding:32px;color:#172033;background:#f7f8fa}main{background:white;border:1px solid #dde2ea;border-radius:16px;padding:32px;box-shadow:0 8px 30px #1d2b4412}h1{font-size:2rem}h2{margin-top:2rem;border-bottom:1px solid #e5e9ef;padding-bottom:.4rem}code{background:#f0f3f7;border-radius:4px;padding:.12rem .3rem}table{border-collapse:collapse;width:100%}th,td{border:1px solid #dfe4eb;padding:.65rem;text-align:left;vertical-align:top}.status{display:inline-block;background:#fff1db;color:#7a4700;border-radius:999px;padding:.35rem .7rem}.flow{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:.6rem;padding:0;list-style:none}.flow li{border-left:4px solid #5b6ee1;background:#f5f6ff;padding:.7rem}</style></head>
<body><main><h1>V3 Execution Control / Payload Architecture</h1><p class="status">${escapeHtml(manifest.status)}</p><p>${escapeHtml(manifest.summary)}</p>
<h2>Lifecycle nodes</h2><ol class="flow">${nodeCards}</ol>
<h2>Current runtime-red bindings</h2><table><thead><tr><th>Issue</th><th>Current source symbols</th></tr></thead><tbody>${issueRows}</tbody></table>
${moduleSections}
<h2>Completion contract</h2>${htmlList(Object.entries(manifest.completion_contract).map(([key, value]) => `${key}: ${value}`))}
<h2>Verification gates</h2>${htmlList(manifest.verification_gates)}
<p>Generated from <code>${escapeHtml(manifestRel)}</code>. Do not edit this page by hand.</p></main></body></html>\n`;
}

function writeOrCompare(rel, expected) {
  const target = path.join(repoRoot, rel);
  if (check) {
    if (!fs.existsSync(target)) failures.push(`${rel}: generated file missing`);
    else if (fs.readFileSync(target, 'utf8') !== expected) failures.push(`${rel}: generated file stale`);
    return;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, expected, 'utf8');
}

function safeId(value) { return String(value).replace(/[^A-Za-z0-9_]/g, '_'); }
function codeList(values) { return array(values).map((value) => `\`${value}\``).join(', '); }
function htmlList(values) { return `<ul>${array(values).map((value) => `<li><code>${escapeHtml(value)}</code></li>`).join('')}</ul>`; }
function escapeHtml(value) { return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;'); }
