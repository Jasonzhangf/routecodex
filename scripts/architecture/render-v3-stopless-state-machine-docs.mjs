#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { renderArchitectureWikiHtmlPages } from './wiki-html-lib.mjs';

const root = process.cwd();
const check = process.argv.includes('--check');
const manifestPath = 'docs/architecture/manifests/v3.servertool_hook_skeleton_lifecycle.mainline.yml';
const mainlineMapPath = 'docs/architecture/v3-mainline-call-map.yml';
const manifest = readYaml(manifestPath);
const mainlineMap = readYaml(mainlineMapPath);
const packageJson = readJson('package.json');
const failures = [];

const markdownPath = manifest?.edge_flow_docs?.generated_markdown ?? 'docs/architecture/wiki/stopless-session-mainline-source.md';
const htmlPath = manifest?.edge_flow_docs?.generated_html ?? 'docs/architecture/wiki/html/stopless-session-mainline-source.html';

validateManifest(manifest);
validateMainlineMap(manifest, mainlineMap);
validatePackageScripts(packageJson);
const markdown = renderMarkdown(manifest, mainlineMap);

if (failures.length === 0) {
  if (check) {
    compareFile(markdownPath, markdown, 'markdown');
    const htmlOutputs = renderArchitectureWikiHtmlPages(root);
    const expectedHtml = htmlOutputs.get(htmlPath);
    if (!expectedHtml) {
      failures.push(`HTML renderer did not return ${htmlPath}`);
    } else {
      compareFile(htmlPath, expectedHtml, 'html');
    }
  } else {
    writeText(markdownPath, markdown);
    const htmlOutputs = renderArchitectureWikiHtmlPages(root);
    const expectedHtml = htmlOutputs.get(htmlPath);
    if (!expectedHtml) {
      failures.push(`HTML renderer did not return ${htmlPath}`);
    } else {
      writeText(htmlPath, expectedHtml);
    }
  }
}

if (failures.length > 0) {
  console.error('[render:v3-stopless-state-machine-docs] failed');
  for (const failure of failures) console.error(`- ${failure}`);
  if (check) console.error('- run `npm run render:v3-stopless-state-machine-docs`');
  process.exit(1);
}

console.log(check ? '[verify:v3-stopless-state-machine-docs] ok' : '[render:v3-stopless-state-machine-docs] ok');
console.log(`- markdown ${markdownPath}`);
console.log(`- html ${htmlPath}`);

function abs(rel) {
  return path.resolve(root, rel);
}

function readText(rel) {
  return fs.readFileSync(abs(rel), 'utf8');
}

function readYaml(rel) {
  return YAML.parse(readText(rel)) ?? {};
}

function readJson(rel) {
  return JSON.parse(readText(rel));
}

function writeText(rel, content) {
  const target = abs(rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, 'utf8');
}

function compareFile(rel, expected, label) {
  let actual = '';
  try {
    actual = readText(rel);
  } catch (error) {
    failures.push(`${rel}: missing generated ${label}: ${error.message}`);
    return;
  }
  if (actual !== expected) {
    failures.push(`${rel}: generated ${label} is stale`);
  }
}

function requireValue(condition, message) {
  if (!condition) failures.push(message);
}

function arrayOf(value) {
  return Array.isArray(value) ? value : [];
}

function validateManifest(doc) {
  requireValue(doc?.lifecycle_id === 'v3.servertool_hook_skeleton_lifecycle', `${manifestPath}: lifecycle_id must be v3.servertool_hook_skeleton_lifecycle`);
  requireValue(doc?.control_owner?.resource_id === 'v3.metadata.runtime_control_stopless', `${manifestPath}: control_owner.resource_id must bind StoplessCenter`);
  requireValue(doc?.state_machine?.id === 'v3.stopless_center.state_machine', `${manifestPath}: state_machine.id missing`);
  requireValue(doc?.state_machine?.owner_node === 'StoplessCenterMetadataControl', `${manifestPath}: state_machine.owner_node must be StoplessCenterMetadataControl`);
  requireValue(doc?.state_machine?.initial_state === 'Idle', `${manifestPath}: state_machine.initial_state must be Idle`);
  for (const state of [
    'Idle',
    'ProviderTurnInFlight',
    'RespStopObserved',
    'CliNoopProjected',
    'CliNoopObserved',
    'ContinuationGuidancePrepared',
    'TerminalCompleted',
    'TerminalBlocked',
    'GuardTerminal',
  ]) {
    requireValue(arrayOf(doc?.state_machine?.states).some((row) => row?.id === state), `${manifestPath}: missing StoplessCenter state ${state}`);
  }
  for (const transitionId of [
    'stsm-01',
    'stsm-02',
    'stsm-03',
    'stsm-04',
    'stsm-05',
    'stsm-06',
    'stsm-07',
    'stsm-08',
    'stsm-09',
    'stsm-10',
    'stsm-11',
    'stsm-12',
    'stsm-13',
  ]) {
    requireValue(arrayOf(doc?.state_machine?.transitions).some((row) => row?.id === transitionId), `${manifestPath}: missing StoplessCenter transition ${transitionId}`);
  }
  requireValue(arrayOf(doc?.state_machine?.transitions).some((row) => row?.class === 'normal'), `${manifestPath}: state_machine.transitions must include normal edges`);
  requireValue(arrayOf(doc?.state_machine?.transitions).some((row) => row?.class === 'abnormal'), `${manifestPath}: state_machine.transitions must include abnormal edges`);
  requireValue(doc?.edge_flow_docs?.generator === 'scripts/architecture/render-v3-stopless-state-machine-docs.mjs', `${manifestPath}: edge_flow_docs.generator mismatch`);
  requireValue(doc?.edge_flow_docs?.generated_html === htmlPath, `${manifestPath}: edge_flow_docs.generated_html mismatch`);
  requireValue(arrayOf(doc?.guidance_rewrite?.forbidden_model_visible).includes('guard exhausted'), `${manifestPath}: guidance_rewrite.forbidden_model_visible must include guard exhausted`);
  requireValue(doc?.guidance_rewrite?.history_persistence === 'forbidden', `${manifestPath}: guidance_rewrite.history_persistence must be forbidden`);
  requireValue(doc?.guidance_rewrite?.stale_generated_guideline_cleanup === 'required', `${manifestPath}: guidance_rewrite.stale_generated_guideline_cleanup must be required`);
  requireValue(doc?.dry_run_contract?.provider_request_dry_run_writes_stopless_control === 'forbidden', `${manifestPath}: dry_run_contract.provider_request_dry_run_writes_stopless_control must be forbidden`);
  requireValue(doc?.dry_run_contract?.provider_request_dry_run_clears_stopless_control === 'forbidden', `${manifestPath}: dry_run_contract.provider_request_dry_run_clears_stopless_control must be forbidden`);
  requireValue(doc?.dry_run_contract?.repeated_dry_run_same_state_provider_request === 'identical', `${manifestPath}: dry_run_contract.repeated_dry_run_same_state_provider_request must be identical`);
  requireValue(arrayOf(doc?.verification_gates).includes('npm run verify:v3-stopless-state-machine-docs'), `${manifestPath}: verification_gates must include npm run verify:v3-stopless-state-machine-docs`);
  requireValue(arrayOf(doc?.verification_gates).includes('npm run test:v3-stopless-state-machine-docs-red-fixtures'), `${manifestPath}: verification_gates must include npm run test:v3-stopless-state-machine-docs-red-fixtures`);
}

function validateMainlineMap(doc, mainlineMapDoc) {
  const chain = arrayOf(mainlineMapDoc?.chains).find((row) => row?.chain_id === doc.lifecycle_id);
  requireValue(Boolean(chain), `${mainlineMapPath}: missing chain ${doc.lifecycle_id}`);
  const edges = new Map(arrayOf(chain?.edges).map((edge) => [edge.step_id, edge]));
  for (const edge of arrayOf(doc.edges)) {
    requireValue(edges.has(edge.step_id), `${mainlineMapPath}: missing manifest edge ${edge.step_id}`);
  }
  requireValue(
    arrayOf(chain?.edges).some((edge) => arrayOf(edge?.resource_flow?.side_channel_reads).includes('v3.metadata.runtime_control_stopless')),
    `${mainlineMapPath}: missing StoplessCenter side_channel read edge`,
  );
  requireValue(
    arrayOf(chain?.edges).some((edge) => arrayOf(edge?.resource_flow?.side_channel_writes).includes('v3.metadata.runtime_control_stopless')),
    `${mainlineMapPath}: missing StoplessCenter side_channel write edge`,
  );
}

function validatePackageScripts(doc) {
  const scripts = doc?.scripts ?? {};
  requireValue(scripts['render:v3-stopless-state-machine-docs'] === 'node scripts/architecture/render-v3-stopless-state-machine-docs.mjs', 'package.json: render:v3-stopless-state-machine-docs script mismatch');
  requireValue(scripts['verify:v3-stopless-state-machine-docs'] === 'node scripts/architecture/verify-v3-stopless-state-machine-docs.mjs', 'package.json: verify:v3-stopless-state-machine-docs script mismatch');
  requireValue(scripts['test:v3-stopless-state-machine-docs-red-fixtures'] === 'node scripts/tests/v3-stopless-state-machine-docs-red-fixtures.mjs', 'package.json: test:v3-stopless-state-machine-docs-red-fixtures script mismatch');
  requireValue(String(scripts['verify:v3-architecture-docs'] ?? '').includes('verify:v3-stopless-state-machine-docs'), 'package.json: verify:v3-architecture-docs must include verify:v3-stopless-state-machine-docs');
}

function renderMarkdown(doc, mainlineMapDoc) {
  const mainlineEdgeById = new Map();
  for (const chain of arrayOf(mainlineMapDoc?.chains)) {
    if (chain?.chain_id !== doc.lifecycle_id) continue;
    for (const edge of arrayOf(chain.edges)) mainlineEdgeById.set(edge.step_id, edge);
  }
  const lines = [
    '<!-- AUTO-GENERATED: do not edit by hand. Rebuild with `npm run render:v3-stopless-state-machine-docs`. -->',
    '# Stopless Session Mainline Source',
    '',
    '## Purpose',
    '',
    'This page is the generated review surface for the V3 stopless lifecycle. It binds the StoplessCenter MetadataCenter state machine, the fixed Req04/Resp03 hook edges, and the generated HTML flow/state diagrams to one manifest truth.',
    '',
    'Canonical sources:',
    `- \`${manifestPath}\``,
    '- `docs/architecture/v3-resource-operation-map.yml` (`resource_id: v3.metadata.runtime_control_stopless`)',
    '- `docs/architecture/v3-function-map.yml` (`feature_id: v3.servertool_hook_skeleton_lifecycle`)',
    '- `docs/architecture/v3-mainline-call-map.yml` (`chain_id: v3.servertool_hook_skeleton_lifecycle`)',
    '- `docs/architecture/v3-verification-map.yml`',
    '- `.agents/skills/rcc-dev-skills/references/95-v3-stopless-sop.md`',
    '',
    'Generated artifacts:',
    `- Markdown: \`${markdownPath}\``,
    `- HTML: \`${htmlPath}\``,
    `- Generator: \`${doc.edge_flow_docs.generator}\``,
    `- Verifier: \`${doc.edge_flow_docs.verifier}\``,
    '',
    'Main rule: stopless is transparent to client/provider/agent except for the public no-input `exec_command` bridge that lets the black-box client display the stopped assistant text. StoplessCenter is the only control truth and lives in MetadataCenter/runtime_control; it never lives in CLI args/stdout, provider payload, client payload, continuation store, SSE, handler, debug snapshot, or dry-run metadata. Provider-request dry-run may read the scoped StoplessCenter state to build an observational provider request, but it must never write, clear, or advance that live state.',
    '',
    '## Stopless Session Mainline',
    '',
    '```mermaid',
    renderFlowchart(doc),
    '```',
    '',
    '## Stopless State Machine',
    '',
    '```mermaid',
    renderStateDiagram(doc),
    '```',
    '',
    '## State Contract',
    '',
    '| state | kind | stored | client-visible | provider-visible | description |',
    '| --- | --- | --- | --- | --- | --- |',
  ];
  for (const state of arrayOf(doc.state_machine.states)) {
    lines.push(`| \`${state.id}\` | \`${state.kind}\` | \`${String(state.stored)}\` | \`${String(state.visible_to_client)}\` | \`${String(state.visible_to_provider)}\` | ${state.description} |`);
  }
  lines.push(
    '',
    '## Edge Owners and Current Status',
    '',
    '| step | from | to | status | owner feature | resource access |',
    '| --- | --- | --- | --- | --- | --- |',
  );
  for (const edge of arrayOf(doc.edges)) {
    lines.push(`| \`${edge.step_id}\` | \`${edge.from_node}\` | \`${edge.to_node}\` | \`${edge.status}\` | \`${edge.owner_feature_id}\` | ${resourceAccess(mainlineEdgeById.get(edge.step_id) ?? edge)} |`);
  }
  lines.push(
    '',
    '## State Transition Matrix',
    '',
    '| transition | class | from | to | event | action |',
    '| --- | --- | --- | --- | --- | --- |',
  );
  for (const transition of arrayOf(doc.state_machine.transitions)) {
    lines.push(`| \`${transition.id}\` | \`${transition.class}\` | \`${transition.from}\` | \`${transition.to}\` | \`${transition.event}\` | ${transition.action} |`);
  }
  lines.push(
    '',
    '## Normal Closure',
    '',
    '- `TerminalCompleted`: only a valid model-visible `reasoningStop(stopreason=0)` with evidence closes as completed; internal tool artifacts are stripped and StoplessCenter is cleared.',
    '- `TerminalBlocked`: only a valid model-visible `reasoningStop(stopreason=1)` with reason and evidence closes as blocked/wait-user; internal tool artifacts are stripped and StoplessCenter is cleared or waits for a real user turn.',
    '- `Idle`: non-stop progress, ordinary tool progress, or real user turn after a stale stopless bridge resets the scoped state without changing normal user/model payload semantics.',
    '',
    '## Abnormal Closure',
    '',
    '- `GuardTerminal`: when the configured consecutive-stop guard is reached, stopless stops intercepting the current provider `finish_reason=stop`; it does not project another no-op and does not expose guard/budget/counter diagnostics.',
    '- Missing client session scope, direct/provider-direct paths, disabled feature flags, and scope changes never write StoplessCenter and never inject relay stopless guidance/tool/projection.',
    '- Provider or route terminal errors stay real ErrorErr-chain errors; stopless must not synthesize success, fallback, or diagnostics and must not retain stale bridge state as user-visible truth.',
    '',
    '## Provider/Client Transparency Checklist',
    '',
    '- Provider-visible continuation guidance must not mention no-op, CLI, client tool round, `routecodex hook run reasoningStop`, `finish_reason=stop`, consecutive stop count, stop budget, or guard exhaustion.',
    '- Provider-visible continuation guidance is current-turn only: Req04 must remove earlier generated stopless continuation guidelines before appending the current one, so restored provider history never accumulates repeated stopless prompts.',
    '- Client-visible no-op command is exactly `routecodex hook run reasoningStop` and carries no input JSON, session, conversation, scope, counter, or state.',
    '- Provider request after no-op must remove `call_stopless_reasoning`, CLI stdout, `--input-json`, `repeatCount`, `schemaFeedback`, `runtime_control`, `metadata_center`, and other control/debug fields while preserving real tools and real history.',
    '- Provider-request dry-run must be observational: the same live StoplessCenter state and same local continuation state must produce identical provider requests across repeated dry-runs, and dry-run must not write or clear StoplessCenter.',
    '',
    '## Required Gates',
    '',
  );
  for (const gate of arrayOf(doc.verification_gates)) lines.push(`- \`${gate}\``);
  lines.push(
    '',
    '## Active Gaps',
    '',
    '- `stopless-gap-03`: historical wording that treats stopless as sessionDir/CLI-persisted state must keep failing gates; StoplessCenter is MetadataCenter control truth only.',
    '- `stopless-gap-04`: stopless and Responses continuation restore/save must remain separate owners; any logic in the immutable interval is a regression.',
    '- `stopless-gap-05`: runtime workdir/sessionDir may exist for CLI/server process plumbing, but it must not become stopless identity or control-state truth.',
    '',
    '## Review Checklist',
    '',
    '- Resp03 projects no-input CLI or transparent terminal/pass-through before Resp04 continuation commit.',
    '- Req04 runs only after continuation/local context restore; it consumes no-op output only as evidence and loads StoplessCenter from MetadataCenter/runtime_control.',
    '- Req04 removes stale generated stopless continuation guidelines before appending one current-turn guideline.',
    '- Provider-request dry-run reads StoplessCenter for projection only and does not commit StoplessCenter transitions.',
    '- The state diagram includes both normal and abnormal terminal/reset edges.',
    '- The HTML page is generated from this Markdown and contains both the lifecycle flowchart and the state transition diagram.',
  );
  return `${lines.join('\n').trimEnd()}\n`;
}

function resourceAccess(edge) {
  const flow = edge.resource_flow ?? {};
  const pieces = [];
  for (const key of ['consumes', 'produces', 'side_channel_reads', 'side_channel_writes']) {
    const values = arrayOf(flow[key]);
    if (values.length > 0) pieces.push(`${key}: ${values.map((value) => `\`${value}\``).join(', ')}`);
  }
  return pieces.length === 0 ? '`none`' : pieces.join('<br/>');
}

function renderFlowchart(doc) {
  const lines = ['flowchart LR'];
  for (const nodeId of arrayOf(doc.node_ids)) lines.push(`  ${nodeId}["${nodeId}"]`);
  for (const edge of arrayOf(doc.edges)) lines.push(`  ${edge.from_node} -->|${edge.step_id}| ${edge.to_node}`);
  return lines.join('\n');
}

function renderStateDiagram(doc) {
  const lines = ['stateDiagram-v2', '  [*] --> Idle'];
  for (const transition of arrayOf(doc.state_machine.transitions)) {
    lines.push(`  ${transition.from} --> ${transition.to}: ${transition.id} ${transition.event}`);
  }
  for (const terminal of arrayOf(doc.state_machine.terminal_states)) {
    lines.push(`  ${terminal} --> [*]`);
  }
  lines.push('  note right of CliNoopProjected');
  lines.push('    client sees only assistant text + no-input exec_command');
  lines.push('  end note');
  lines.push('  note right of ContinuationGuidancePrepared');
  lines.push('    provider sees only transparent task guideline + reasoningStop tool');
  lines.push('  end note');
  return lines.join('\n');
}
