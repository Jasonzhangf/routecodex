#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const repoRoot = process.env.ROUTECODEX_V3_SOURCE_ROOT
  ? path.resolve(process.env.ROUTECODEX_V3_SOURCE_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const check = process.argv.includes('--check');
const manifestRel = 'docs/architecture/manifests/v3.execution_control_payload_architecture.mainline.yml';
const resourceMapRel = 'docs/architecture/v3-resource-operation-map.yml';
const functionMapRel = 'docs/architecture/v3-function-map.yml';
const callMapRel = 'docs/architecture/v3-mainline-call-map.yml';
const moduleRegistryRel = 'docs/architecture/v3-runtime-module-registry.yml';
const runtimeSourceRootRel = 'v3/crates/routecodex-v3-runtime/src';
const runtimeExecutionControlRel = `${runtimeSourceRootRel}/execution_control.rs`;
const providerHealthPersistenceRel = 'v3/crates/routecodex-v3-provider-responses/src/health/persistence.rs';
const configAttemptStoreRel = 'v3/crates/routecodex-v3-config/src/attempt_store.rs';
const verificationMapRel = 'docs/architecture/v3-verification-map.yml';
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
  requireValue(manifest.entrypoint?.call_map_chain_id === manifest.lifecycle_id, `${manifestRel}: call-map chain mismatch`);
  const expectedImplementationOwners = {
    request_execution_control: runtimeExecutionControlRel,
    attempt_store_policy: configAttemptStoreRel,
    provider_health_persistence: providerHealthPersistenceRel,
  };
  for (const [owner, rel] of Object.entries(expectedImplementationOwners)) {
    requireValue(manifest.implementation_owner_files?.[owner] === rel, `${manifestRel}: ${owner} owner mismatch`);
  }
  requireValue(manifest.budget_contract?.reserve_before_append_or_copy === true, `${manifestRel}: reserve-before-append required`);
  requireValue(manifest.budget_contract?.provider_attempt_and_client_replay_share_request_budget === true, `${manifestRel}: provider attempt and client replay must share one request budget`);
  requireValue(manifest.budget_contract?.server_budget_construction === 'forbidden', `${manifestRel}: Server budget construction must be forbidden`);
  requireValue(manifest.budget_contract?.disk_spill === 'forbidden', `${manifestRel}: initial disk spill must be forbidden`);
  requireValue(manifest.sealed_replay_body_contract?.anthropic === 'typed_non_optional', `${manifestRel}: Anthropic sealed replay body must be typed and non-optional`);
  requireValue(manifest.sealed_replay_body_contract?.server_consumption === 'exhaustive_match', `${manifestRel}: Server sealed replay consumption must be exhaustive`);
  requireValue(manifest.sealed_replay_body_contract?.option_stream_with_expect === 'forbidden', `${manifestRel}: optional sealed replay plus expect must be forbidden`);
  for (const dimension of ['per_attempt', 'per_request', 'process_global', 'residence_or_deadline']) {
    requireValue(manifest.budget_contract?.[dimension] === 'required', `${manifestRel}: missing budget ${dimension}`);
  }
  for (const kind of ['Upstream', 'Protocol', 'LocalResourceExhausted', 'ObservationFailure', 'PersistenceFailure', 'ClientCancelled']) {
    requireValue(array(manifest.failure_kinds).includes(kind), `${manifestRel}: missing failure kind ${kind}`);
  }
  const responsesReplayFailure = manifest.failure_attribution_contract?.responses_client_replay;
  requireValue(responsesReplayFailure?.runtime_variant === 'ExecutionControlResponse', `${manifestRel}: Responses replay failure variant mismatch`);
  requireValue(responsesReplayFailure?.source_kind === 'RuntimeFailure' && responsesReplayFailure?.source_stage === 'V3ServerRespOutbound06ClientFrame', `${manifestRel}: Responses replay failure source attribution mismatch`);
  requireValue(responsesReplayFailure?.internal_status === 599 && responsesReplayFailure?.internal_code === 'responses_relay_response_execution_control_error', `${manifestRel}: Responses replay failure internal attribution mismatch`);
  requireValue(responsesReplayFailure?.client_error_projection === 'forbidden' && responsesReplayFailure?.client_transport === 'terminate_request', `${manifestRel}: Responses replay failure must terminate request transport without client error projection`);
  requireValue(responsesReplayFailure?.provider_response_classification === 'forbidden' && responsesReplayFailure?.provider_health_mutation === 'forbidden', `${manifestRel}: Responses replay failure must remain provider-health neutral`);
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
    ...Object.entries(manifest.implementation_owner_files).map(([name, rel]) => `- implementation owner ${name}: \`${rel}\``),
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
    `- Provider stream deadline guard: \`${manifest.budget_contract.provider_stream_deadline_guard}\``,
    `- Residence expiry: \`${manifest.budget_contract.residence_expiry}\``,
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
    `- Responses client replay local failure: \`${manifest.failure_attribution_contract.responses_client_replay.runtime_variant}\`; internal diagnostic \`${manifest.failure_attribution_contract.responses_client_replay.internal_status}\` / \`${manifest.failure_attribution_contract.responses_client_replay.internal_code}\`; client error projection \`${manifest.failure_attribution_contract.responses_client_replay.client_error_projection}\`; client transport \`${manifest.failure_attribution_contract.responses_client_replay.client_transport}\`; provider classification \`${manifest.failure_attribution_contract.responses_client_replay.provider_response_classification}\``,
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
  if (check) return;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, expected, 'utf8');
}

function safeId(value) { return String(value).replace(/[^A-Za-z0-9_]/g, '_'); }
function codeList(values) { return array(values).map((value) => `\`${value}\``).join(', '); }
function htmlList(values) { return `<ul>${array(values).map((value) => `<li><code>${escapeHtml(value)}</code></li>`).join('')}</ul>`; }
function escapeHtml(value) { return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;'); }
