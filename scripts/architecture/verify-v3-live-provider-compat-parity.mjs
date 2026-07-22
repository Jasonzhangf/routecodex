#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import YAML from 'yaml';

const manifestPath = 'docs/architecture/manifests/v3.live_provider_compat.parity.yml';
const functionMapPath = 'docs/architecture/v3-function-map.yml';
const mainlinePath = 'docs/architecture/v3-mainline-call-map.yml';
const resourceMapPath = 'docs/architecture/v3-resource-operation-map.yml';
const verificationPath = 'docs/architecture/v3-verification-map.yml';
const wikiPath = 'docs/architecture/wiki/v3-live-provider-compat-parity.md';
const planPath = 'docs/goals/v3-live-provider-compat-parity-closeout-plan.md';
const packagePath = 'package.json';
const verifierName = 'verify-v3-live-provider-compat-parity';

const manifest = YAML.parse(readFileSync(manifestPath, 'utf8'));
const functionMap = readFileSync(functionMapPath, 'utf8');
const mainline = readFileSync(mainlinePath, 'utf8');
const resourceMap = readFileSync(resourceMapPath, 'utf8');
const verification = readFileSync(verificationPath, 'utf8');
const wiki = readFileSync(wikiPath, 'utf8');
const plan = readFileSync(planPath, 'utf8');
const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'));
const failures = [];
const functionMapYaml = YAML.parse(functionMap);
const mainlineYaml = YAML.parse(mainline);
const resourceMapYaml = YAML.parse(resourceMap);
const verificationYaml = YAML.parse(verification);

const featureId = 'v3.live_provider_compat_parity_closeout';
const expectedEndpoints = [
  'responses_direct',
  'responses_relay',
  'anthropic_messages',
  'openai_chat_completions',
  'gemini_generate_content',
];
const expectedTransports = ['json_http', 'sse_http', 'websocket_v2'];
const requiredErrorCases = [
  'http_401',
  'http_402',
  'http_403',
  'http_429',
  'http_5xx',
  'sse_body_level_failure',
  'malformed_provider_body',
  'timeout',
  'disconnect',
  'cancel',
];
const reroutableProviderFailureCases = ['http_401', 'http_403', 'http_5xx', 'timeout'];
const requiredCapabilityFields = [
  'supports_reasoning_summaries',
  'support_verbosity',
  'supports_parallel_tool_calls',
  'context_window',
  'max_context_window',
  'supports_search_tool',
  'input_modalities',
];
const requiredSelectorAbsenceFields = [
  'use_responses_lite',
  'tool_mode',
];
const requiredCurrentProfileProviders = [
  'glmrelay_anthropic',
  'glmrelay_openai',
  'minimax_anthropic',
  'minimax_openai',
];
const requiredCurrentProfilePools = [
  'anthropic_entry',
  'coding',
  'default',
  'longcontext',
  'search',
  'thinking',
  'web_search',
];
const forbiddenCurrentAnthropicBlockerText = [
  'final_5555_profile_anthropic_endpoint_not_enabled',
  'anthropic_messages_live_replay_pending',
  'Anthropic Messages final-profile endpoint_not_enabled',
  'Anthropic Messages JSON/SSE is not enabled',
  'protocols excluded from the final responses + openai_chat profile',
  'final live profile responses + openai_chat',
];

if (manifest.lifecycle_id !== 'v3.live_provider_compat.parity') {
  failures.push(manifestPath + ': lifecycle_id mismatch');
}
if (manifest.owner_feature_id !== featureId) {
  failures.push(manifestPath + ': owner_feature_id mismatch');
}
if (manifest.call_map_chain_id !== 'v3.live_provider_compat.parity') {
  failures.push(manifestPath + ': call_map_chain_id mismatch');
}
if (manifest.production_policy?.no_fallback !== true) {
  failures.push(manifestPath + ': production_policy.no_fallback must be true');
}
if (manifest.production_policy?.provider_specific_hub_vr_forbidden !== true) {
  failures.push(manifestPath + ': Hub/VR provider-specific branch ban missing');
}
if (manifest.completion_boundary?.production_ready_claim !== false
    || manifest.completion_boundary?.live_config_mutation !== false
    || manifest.completion_boundary?.global_install_restart !== true) {
  failures.push(manifestPath + ': completion boundary must record global install/restart live closeout without live config mutation or full production cutover');
}
if (manifest.completion_boundary?.current_5555_multi_provider_profile !== true
    || manifest.completion_boundary?.anthropic_messages_current_5555_live_verified !== true
    || manifest.completion_boundary?.start_lifecycle_used_for_item3 !== false) {
  failures.push(manifestPath + ': completion boundary must lock current multi-provider Anthropic live evidence and no start lifecycle use');
}
if (manifest.live_read_only_audit?.status !== 'live_v3_provider_replay_partial_verified') {
  failures.push(manifestPath + ': live audit must record partial V3 provider replay verification');
}
if (!(manifest.verification_gates ?? []).includes('npm run verify:provider-failure-ban-blackbox')) {
  failures.push(manifestPath + ': verification_gates missing npm run verify:provider-failure-ban-blackbox');
}
if (!String(manifest.live_read_only_audit?.finding ?? '').includes('Responses Direct JSON/SSE/client WebSocket, Responses Relay JSON/SSE, and OpenAI Chat Relay JSON/SSE')) {
  failures.push(manifestPath + ': live audit must name the verified V3 5555 live replay surface');
}

const currentProfile = manifest.current_5555_profile_audit;
if (currentProfile?.status !== 'current_5555_multi_provider_profile_partial_verified') {
  failures.push(manifestPath + ': current_5555_profile_audit must record the current multi-provider partial verification status');
}
if (currentProfile?.server_id !== 'responses_v3_5555'
    || currentProfile?.manifest_version !== 3) {
  failures.push(manifestPath + ': current_5555_profile_audit must bind the V3 5555 server identity');
}
if (currentProfile?.lifecycle_command_used_for_this_audit !== 'none'
    || currentProfile?.allowed_lifecycle_command_if_needed !== 'routecodex restart --port 5555'
    || !Array.isArray(currentProfile?.forbidden_lifecycle_commands_used)
    || currentProfile.forbidden_lifecycle_commands_used.length !== 0) {
  failures.push(manifestPath + ': current audit must use no lifecycle command and allow only routecodex restart --port 5555 if needed');
}
for (const endpoint of ['responses', 'anthropic']) {
  requireArrayText(currentProfile?.endpoints_enabled, endpoint, 'current_5555_profile_audit.endpoints_enabled');
}
for (const provider of requiredCurrentProfileProviders) {
  requireArrayText(currentProfile?.providers, provider, 'current_5555_profile_audit.providers');
}
for (const pool of requiredCurrentProfilePools) {
  if (!Array.isArray(currentProfile?.route_pools?.[pool])
      || currentProfile.route_pools[pool].length === 0) {
    failures.push(manifestPath + ': current 5555 profile missing non-empty route pool ' + pool);
  }
}
for (const evidenceKey of [
  'health_and_pool_status',
  'messages_json_dryrun_no_send',
  'messages_json_live_200',
  'messages_sse_dryrun_no_send',
  'messages_sse_live_200',
]) {
  if (!String(currentProfile?.evidence?.[evidenceKey] ?? '').startsWith('.agent-collab/runs/')) {
    failures.push(manifestPath + ': current 5555 profile missing run evidence ' + evidenceKey);
  }
}
const currentFinding = String(currentProfile?.finding ?? '');
if (!currentFinding.includes('Anthropic Messages JSON and SSE are live_verified')
    || !currentFinding.includes('multi-provider')
    || !currentFinding.includes('no start/server-start/run-managed-child')) {
  failures.push(manifestPath + ': current 5555 finding must name multi-provider Anthropic JSON/SSE live evidence and no start lifecycle use');
}

for (const endpoint of expectedEndpoints) requireArrayText(manifest.axes?.endpoints, endpoint, 'axes.endpoints');
for (const transport of expectedTransports) requireArrayText(manifest.axes?.transports, transport, 'axes.transports');

const cases = Array.isArray(manifest.cases) ? manifest.cases : [];
const caseIds = new Set(cases.map((entry) => entry.id));
for (const endpoint of expectedEndpoints) {
  for (const transport of expectedTransports) {
    const found = cases.some((entry) => entry.endpoint === endpoint && entry.transport === transport);
    if (!found) failures.push(manifestPath + ': missing matrix case for ' + endpoint + ' x ' + transport);
  }
}
if (caseIds.size !== cases.length) failures.push(manifestPath + ': duplicate case id');
if (cases.length < expectedEndpoints.length * expectedTransports.length) {
  failures.push(manifestPath + ': matrix must cover every endpoint x transport pair');
}
for (const relayCaseId of ['responses_relay_json_http', 'responses_relay_sse_http']) {
  const relayCase = cases.find((entry) => entry.id === relayCaseId);
  if (!relayCase || relayCase.live_evidence?.status !== 'live_verified' || relayCase.production?.status !== 'ready') {
    failures.push(manifestPath + ': Responses Relay live case must be live_verified and ready after 5555 replay ' + relayCaseId);
  }
}
for (const anthropicCaseId of ['anthropic_messages_json_http', 'anthropic_messages_sse_http']) {
  const anthropicCase = cases.find((entry) => entry.id === anthropicCaseId);
  if (!anthropicCase || anthropicCase.live_evidence?.status !== 'live_verified' || anthropicCase.production?.status !== 'ready') {
    failures.push(manifestPath + ': Anthropic Messages current 5555 case must be live_verified and ready ' + anthropicCaseId);
    continue;
  }
  const refs = anthropicCase.live_evidence?.refs ?? [];
  if (!refs.some((ref) => String(ref).includes('20260722T171600Z-Macstudio.local-88821-c652a9-v3-live-compat-matrix'))
      && anthropicCaseId === 'anthropic_messages_sse_http') {
    failures.push(manifestPath + ': Anthropic Messages SSE case must cite current 5555 SSE run evidence');
  }
  if (refs.some((ref) => String(ref).includes('20260716T032203Z-Macstudio.local-73370-compatresume'))) {
    failures.push(manifestPath + ': Anthropic Messages current case must not cite stale endpoint_not_enabled evidence ' + anthropicCaseId);
  }
}

for (const entry of cases) {
  for (const field of ['id', 'endpoint', 'protocol', 'transport', 'provider_model_scope', 'owner_feature_id']) {
    if (!entry[field]) failures.push(manifestPath + ': case missing ' + field);
  }
  if (!expectedEndpoints.includes(entry.endpoint)) failures.push(manifestPath + ': unknown endpoint in case ' + entry.id);
  if (!expectedTransports.includes(entry.transport)) failures.push(manifestPath + ': unknown transport in case ' + entry.id);
  validateEvidence(entry.controlled_evidence, 'controlled_evidence', entry.id);
  validateEvidence(entry.live_evidence, 'live_evidence', entry.id);
  const productionStatus = entry.production?.status;
  if (!['ready', 'blocked', 'pending'].includes(productionStatus)) {
    failures.push(manifestPath + ': invalid production status in case ' + entry.id);
  }
  const blockers = Array.isArray(entry.production?.blockers) ? entry.production.blockers : [];
  if (productionStatus === 'ready') {
    if (entry.controlled_evidence?.status !== 'controlled_verified') {
      failures.push(manifestPath + ': production-ready case lacks controlled evidence ' + entry.id);
    }
    if (entry.live_evidence?.status !== 'live_verified') {
      failures.push(manifestPath + ': production-ready case lacks live evidence ' + entry.id);
    }
    if (blockers.length !== 0) failures.push(manifestPath + ': production-ready case has blockers ' + entry.id);
  } else if (blockers.length === 0) {
    failures.push(manifestPath + ': non-ready case must name blockers ' + entry.id);
  }
}

for (const required of requiredErrorCases) {
  const found = (manifest.error_cases ?? []).some((entry) => entry.id === required);
  if (!found) failures.push(manifestPath + ': missing error case ' + required);
}
for (const errorCase of manifest.error_cases ?? []) {
  if (!errorCase.status || !errorCase.owner_feature_id || !errorCase.required_path) {
    failures.push(manifestPath + ': malformed error case ' + (errorCase.id ?? '<missing>'));
  }
  if (reroutableProviderFailureCases.includes(errorCase.id)) {
    if (errorCase.status !== 'controlled_verified') {
      failures.push(manifestPath + ': reroutable provider failure case must not be vague pending ' + errorCase.id);
    }
    validateErrorEvidence(errorCase.controlled_evidence, 'controlled_evidence', errorCase.id);
    validateErrorEvidence(errorCase.live_evidence, 'live_evidence', errorCase.id);
    if (!String(errorCase.required_path).includes('Error01-06')) {
      failures.push(manifestPath + ': reroutable provider failure case must name Error01-06 path ' + errorCase.id);
    }
  }
}

const codexCapability = (manifest.capability_cases ?? [])
  .find((entry) => entry.id === 'codex_models_capability_catalog');
if (!codexCapability) failures.push(manifestPath + ': missing codex_models_capability_catalog');
else {
  for (const field of requiredCapabilityFields) {
    if (!(codexCapability.required_fields ?? []).includes(field)) {
      failures.push(manifestPath + ': /v1/models capability field missing ' + field);
    }
  }
  for (const field of requiredSelectorAbsenceFields) {
    if (!(codexCapability.selector_absence_fields ?? []).includes(field)) {
      failures.push(manifestPath + ': /v1/models selector absence field missing ' + field);
    }
  }
  validateEvidence(codexCapability.controlled_evidence, 'controlled_evidence', codexCapability.id);
  validateEvidence(codexCapability.live_evidence, 'live_evidence', codexCapability.id);
}

for (const blocker of [
  'live_provider_replay_matrix_pending',
  'gemini_generate_content_live_replay_pending',
  'final_5555_profile_gemini_endpoint_not_enabled',
]) {
  if (!(manifest.production_blockers ?? []).some((entry) => entry.blocker_id === blocker)) {
    failures.push(manifestPath + ': missing production blocker ' + blocker);
  }
}
for (const blocker of manifest.production_blockers ?? []) {
  if (['anthropic_messages_live_replay_pending', 'final_5555_profile_anthropic_endpoint_not_enabled']
    .includes(blocker.blocker_id)) {
    failures.push(manifestPath + ': stale current Anthropic production blocker reintroduced ' + blocker.blocker_id);
  }
}

for (const script of [
  'verify:v3-live-provider-compat-parity',
  'test:v3-live-provider-compat-parity-red-fixtures',
  'verify:provider-failure-ban-blackbox',
]) {
  if (!packageJson.scripts?.[script]) failures.push(packagePath + ': missing script ' + script);
}

if (!(functionMapYaml.features ?? []).some((entry) => entry.feature_id === featureId)) {
  failures.push(functionMapPath + ': missing feature entry ' + featureId);
}
if (!(mainlineYaml.chains ?? []).some((entry) => entry.chain_id === 'v3.live_provider_compat.parity'
    && entry.owner_feature_id === featureId)) {
  failures.push(mainlinePath + ': missing v3.live_provider_compat.parity chain');
}
if (!(resourceMapYaml.resources ?? []).some((entry) => entry.resource_id === 'v3.live_provider_compat.matrix'
    && entry.owner_feature_id === featureId)) {
  failures.push(resourceMapPath + ': missing v3.live_provider_compat.matrix resource binding');
}
if (!(verificationYaml.features ?? []).some((entry) => entry.feature_id === featureId)) {
  failures.push(verificationPath + ': missing feature entry ' + featureId);
}

for (const [path, text] of [
  [functionMapPath, functionMap],
  [mainlinePath, mainline],
  [resourceMapPath, resourceMap],
  [verificationPath, verification],
  [wikiPath, wiki],
  [planPath, plan],
]) {
  requireText(text, path, featureId);
  requireText(text, path, 'v3.live_provider_compat.parity');
  requireText(text, path, 'v3.live_provider_compat.matrix');
}
for (const pathText of [functionMap, mainline, resourceMap, verification, wiki]) {
  if (!pathText.includes('docs/architecture/manifests/v3.live_provider_compat.parity.yml')) {
    failures.push('architecture maps/wiki: missing manifest reference');
    break;
  }
}
for (const phrase of [
  'controlled evidence cannot be live evidence',
  'production ready requires controlled + live evidence',
  'provider-specific differences stay in provider runtime or codec owners',
]) requireText(wiki, wikiPath, phrase);
for (const phrase of [
  'live_provider_replay_matrix_pending',
  'responses_relay_live_verified',
  'anthropic_messages_live_verified_current_5555',
  'gemini_generate_content_live_replay_pending',
  'npm run verify:provider-failure-ban-blackbox',
]) requireText(wiki, wikiPath, phrase);
for (const [path, text] of [
  [manifestPath, readFileSync(manifestPath, 'utf8')],
  [wikiPath, wiki],
  [planPath, plan],
]) {
  for (const forbidden of forbiddenCurrentAnthropicBlockerText) {
    if (text.includes(forbidden)) {
      failures.push(path + ': stale current Anthropic blocker text reintroduced: ' + forbidden);
    }
  }
}
for (const phrase of [
  'scenarioTimeout',
  'production_credentials_must_not_be_mutated_for_auth_error',
]) requireText(readFileSync(manifestPath, 'utf8'), manifestPath, phrase);

if (failures.length) {
  console.error('[verify:v3-live-provider-compat-parity] failed');
  for (const failure of failures) console.error('- ' + failure);
  process.exit(1);
}
console.log('[verify:v3-live-provider-compat-parity] ok');

function validateEvidence(evidence, label, caseId) {
  const statuses = ['controlled_verified', 'live_verified', 'live_pending', 'pending', 'blocker'];
  if (!evidence || !statuses.includes(evidence.status)) {
    failures.push(manifestPath + ': invalid ' + label + ' status in case ' + caseId);
  }
  if (label === 'live_evidence' && evidence?.status === 'controlled_verified') {
    failures.push(manifestPath + ': live_evidence must not reuse controlled evidence status in case ' + caseId);
  }
  if (!Array.isArray(evidence.refs)) {
    failures.push(manifestPath + ': ' + label + '.refs must be an array in case ' + caseId);
  }
  if (evidence.status === 'blocker' && (!Array.isArray(evidence.blockers) || evidence.blockers.length === 0)) {
    failures.push(manifestPath + ': blocker evidence must name blockers in case ' + caseId);
  }
  if (evidence.status === 'live_pending' && (!Array.isArray(evidence.blockers) || evidence.blockers.length === 0)) {
    failures.push(manifestPath + ': live_pending evidence must name blockers in case ' + caseId);
  }
}

function validateErrorEvidence(evidence, label, caseId) {
  if (!evidence || typeof evidence !== 'object') {
    failures.push(manifestPath + ': missing ' + label + ' for error case ' + caseId);
    return;
  }
  if (label === 'controlled_evidence' && evidence.status !== 'controlled_verified') {
    failures.push(manifestPath + ': error case ' + caseId + ' controlled evidence must be controlled_verified');
  }
  if (label === 'live_evidence') {
    if (!['live_verified', 'live_pending', 'blocker'].includes(evidence.status)) {
      failures.push(manifestPath + ': error case ' + caseId + ' live evidence status must be live_verified, live_pending, or blocker');
    }
    if (evidence.status !== 'live_verified' && (!Array.isArray(evidence.blockers) || evidence.blockers.length === 0)) {
      failures.push(manifestPath + ': error case ' + caseId + ' live evidence must name blockers when not live_verified');
    }
  }
  if (!Array.isArray(evidence.refs)) {
    failures.push(manifestPath + ': error case ' + caseId + ' ' + label + '.refs must be an array');
  }
  if (!Array.isArray(evidence.gates)) {
    failures.push(manifestPath + ': error case ' + caseId + ' ' + label + '.gates must be an array');
  }
}

function requireArrayText(value, item, owner) {
  if (!Array.isArray(value) || !value.includes(item)) {
    failures.push(manifestPath + ': missing ' + item + ' in ' + owner);
  }
}

function requireText(text, owner, phrase) {
  if (!text.includes(phrase)) failures.push(owner + ': missing ' + phrase);
}
