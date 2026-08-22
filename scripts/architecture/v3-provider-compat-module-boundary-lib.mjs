import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';

const PATHS = {
  moduleRegistry: 'docs/architecture/v3-build-tool-module-registry.yml',
  functionMap: 'docs/architecture/function-map.yml',
  v3FunctionMap: 'docs/architecture/v3-function-map.yml',
  mainlineMap: 'docs/architecture/v3-mainline-call-map.yml',
  resourceMap: 'docs/architecture/v3-resource-operation-map.yml',
  verificationMap: 'docs/architecture/verification-map.yml',
  v3VerificationMap: 'docs/architecture/v3-verification-map.yml',
  providerCompatSource:
    'sharedmodule/llmswitch-core/rust-core/crates/provider-compat-core/src/lib.rs',
  reqCompatSource:
    'v3/crates/routecodex-v3-runtime/src/hub_v1/provider_req_compat_06_provider_compat.rs',
  configFixture: 'v3/tests/resources/glm-anthropic-request-outbound-config.toml',
  genericResponsesCodec:
    'v3/crates/routecodex-v3-runtime/src/hub_v1/responses_openai_codec.rs',
  genericAnthropicCodec:
    'v3/crates/routecodex-v3-runtime/src/hub_v1/anthropic_codec.rs',
  genericOutboundCodec:
    'v3/crates/routecodex-v3-runtime/src/hub_v1/request_outbound_format.rs',
  packageJson: 'package.json',
  architectureCi: 'scripts/architecture/verify-v3-architecture-ci.mjs',
};

const REQUIRED_OWNED_PATHS = [
  'sharedmodule/llmswitch-core/rust-core/crates/provider-compat-core/src',
  'v3/crates/routecodex-v3-runtime/src/hub_v1/provider_req_compat_06_provider_compat.rs',
  'v3/crates/routecodex-v3-runtime/src/hub_v1/provider_resp_compat_02_provider_compat.rs',
  'v3/crates/routecodex-v3-runtime/tests/glm_anthropic_request_outbound_compat.rs',
  'v3/tests/resources/glm-anthropic-request-outbound-config.toml',
  'docs/goals/v3-glm-request-outbound-compat-20260819.md',
  'scripts/architecture/v3-provider-compat-module-boundary-lib.mjs',
  'scripts/architecture/verify-v3-provider-compat-module-boundary.mjs',
  'scripts/tests/v3-provider-compat-module-boundary-red-fixtures.mjs',
];

export function loadProviderCompatBoundarySources(root = process.cwd()) {
  return Object.fromEntries(
    Object.entries(PATHS).map(([key, relative]) => [
      key,
      readFileSync(join(root, relative), 'utf8'),
    ]),
  );
}

function parseYaml(source, label, failures) {
  try {
    return YAML.parse(source) ?? {};
  } catch (error) {
    failures.push(`${label}: invalid YAML: ${error.message}`);
    return {};
  }
}

function findFeature(document, featureId, key) {
  return (document[key] ?? []).find((entry) => entry.feature_id === featureId);
}

function listHasAll(values, expected) {
  const actual = new Set(Array.isArray(values) ? values : []);
  return expected.filter((value) => !actual.has(value));
}

function forwarderSection(source) {
  const marker = '[forwarders."fwd.v3.glm-5.2"]';
  const start = source.indexOf(marker);
  if (start < 0) return '';
  const next = source.indexOf('\n[', start + marker.length);
  return source.slice(start, next < 0 ? undefined : next);
}

export function verifyProviderCompatBoundary(sources) {
  const failures = [];
  const moduleRegistry = parseYaml(sources.moduleRegistry, PATHS.moduleRegistry, failures);
  const functionMap = parseYaml(sources.functionMap, PATHS.functionMap, failures);
  const v3FunctionMap = parseYaml(sources.v3FunctionMap, PATHS.v3FunctionMap, failures);
  const mainlineMap = parseYaml(sources.mainlineMap, PATHS.mainlineMap, failures);
  const resourceMap = parseYaml(sources.resourceMap, PATHS.resourceMap, failures);
  const verificationMap = parseYaml(
    sources.verificationMap,
    PATHS.verificationMap,
    failures,
  );
  const v3VerificationMap = parseYaml(
    sources.v3VerificationMap,
    PATHS.v3VerificationMap,
    failures,
  );

  const module = (moduleRegistry.modules ?? []).find(
    (entry) => entry.module_id === 'v3-provider-compat-profile-loading',
  );
  if (moduleRegistry.status !== 'active' || !module) {
    failures.push('provider compat module must be active in the global module registry');
  }
  if (module?.owner_feature_id !== 'v3.provider_compat_profile_loading') {
    failures.push('provider compat module owner_feature_id mismatch');
  }
  for (const missing of listHasAll(module?.owned_paths, REQUIRED_OWNED_PATHS)) {
    failures.push(`provider compat module missing owned path ${missing}`);
  }
  for (const gate of [
    'npm run verify:v3-provider-compat-module-boundary',
    'npm run test:v3-provider-compat-module-boundary-red-fixtures',
    'npm run test:v3-glm-anthropic-request-outbound-compat',
  ]) {
    if (!(module?.required_gates ?? []).includes(gate)) {
      failures.push(`provider compat module missing required gate ${gate}`);
    }
  }

  const owner = findFeature(
    functionMap,
    'v3.provider_compat_profile_loading',
    'owners',
  );
  if (owner?.status !== 'active') {
    failures.push('provider compat function-map owner must be active');
  }
  if (!(owner?.resource_bindings ?? []).includes('v3.provider_compat.profile_application')) {
    failures.push('provider compat function-map owner missing profile application resource');
  }
  if (!(owner?.mainline_bindings ?? []).includes('v3-provider-compat-request-01')) {
    failures.push('provider compat function-map owner missing request mainline binding');
  }

  const v3Feature = findFeature(
    v3FunctionMap,
    'v3.glm_anthropic_request_outbound_compat',
    'features',
  );
  const v3FeatureStatus = String(v3Feature?.status ?? '');
  if (!/^(source_controlled|runtime_live_verified)/u.test(v3FeatureStatus)) {
    failures.push('GLM Anthropic outbound feature must have an independent source or runtime verified status');
  }
  for (const symbol of [
    'apply_v3_provider_req_compat_profile',
    'run_req_outbound_stage3_compat',
    'glm_anthropic_request_outbound_runs_standard_codec_before_provider_compat',
    'responses_chat_anthropic_glm_compat_uses_configured_anthropic_target_and_standard_wire',
  ]) {
    if (!(v3Feature?.entry_symbols ?? []).includes(symbol)) {
      failures.push(`GLM Anthropic outbound feature missing entry symbol ${symbol}`);
    }
  }

  const resource = (resourceMap.resources ?? []).find(
    (entry) => entry.resource_id === 'v3.provider_compat.profile_application',
  );
  if (resource?.binding_status !== 'anchored') {
    failures.push('provider compat profile application resource must be anchored');
  }
  if (resource?.may_enter_provider_body !== false || resource?.may_enter_client_body !== false) {
    failures.push('provider compat profile application resource must never enter payload');
  }
  if (resource?.owner_node !== 'ProviderReqCompat06ProviderCompat') {
    failures.push('provider compat profile application resource owner node mismatch');
  }

  const chain = (mainlineMap.chains ?? []).find(
    (entry) => entry.chain_id === 'v3.provider_compat_profile_loading.request',
  );
  const edge = (chain?.edges ?? []).find(
    (entry) => entry.step_id === 'v3-provider-compat-request-01',
  );
  if (chain?.owner_feature_id !== 'v3.provider_compat_profile_loading') {
    failures.push('provider compat request chain owner mismatch');
  }
  if (
    edge?.caller_symbol !== 'apply_v3_provider_req_compat_profile'
    || edge?.callee_symbol !== 'run_req_outbound_stage3_compat'
  ) {
    failures.push('provider compat request edge must bind V3 helper directly to compat core');
  }
  if (!(edge?.resource_flow?.side_channel_writes ?? []).includes(
    'v3.provider_compat.profile_application',
  )) {
    failures.push('provider compat request edge missing typed profile application write');
  }

  const genericVerification = findFeature(
    verificationMap,
    'v3.provider_compat_profile_loading',
    'verification',
  );
  if (!(genericVerification?.contract ?? []).includes(
    'v3/crates/routecodex-v3-runtime/tests/glm_anthropic_request_outbound_compat.rs',
  )) {
    failures.push('provider compat verification map missing GLM config-to-wire contract test');
  }
  const v3Verification = findFeature(
    v3VerificationMap,
    'v3.glm_anthropic_request_outbound_compat',
    'features',
  );
  for (const gate of [
    'npm run verify:v3-provider-compat-module-boundary',
    'npm run test:v3-provider-compat-module-boundary-red-fixtures',
    'npm run test:v3-glm-anthropic-request-outbound-compat',
  ]) {
    if (!(v3Verification?.required_gates ?? []).includes(gate)) {
      failures.push(`GLM Anthropic verification map missing gate ${gate}`);
    }
  }

  const providerCompatSource = sources.providerCompatSource ?? '';
  const reqCompatStart = providerCompatSource.indexOf('pub fn run_req_outbound_stage3_compat(');
  const respCompatStart = providerCompatSource.indexOf('pub fn run_resp_inbound_stage3_compat(');
  const reqCompatBlock = reqCompatStart >= 0 && respCompatStart > reqCompatStart
    ? providerCompatSource.slice(reqCompatStart, respCompatStart)
    : '';
  const glmBranchStart = reqCompatBlock.indexOf('if is_glm_profile(profile_id) {');
  const glmBranchEnd = reqCompatBlock.indexOf(
    'if is_deepseek_max_profile(profile_id) {',
    glmBranchStart,
  );
  const glmRequestBranch = glmBranchStart >= 0 && glmBranchEnd > glmBranchStart
    ? reqCompatBlock.slice(glmBranchStart, glmBranchEnd)
    : '';
  if (!/anthropic-messages[\s\S]*payload,[\s\S]*applied_profile:\s*Some\(profile_id\.to_string\(\)\)[\s\S]*native_applied:\s*true/u.test(glmRequestBranch)) {
    failures.push('provider compat core missing GLM Anthropic profile application branch');
  }
  for (const testSymbol of [
    'glm_anthropic_request_profile_preserves_probed_standard_wire_semantics',
    'glm_anthropic_request_without_profile_does_not_claim_glm_compat',
    'glm_anthropic_response_does_not_run_openai_reasoning_tool_harvest',
  ]) {
    if (!providerCompatSource.includes(`fn ${testSymbol}(`)) {
      failures.push(`provider compat core missing regression test ${testSymbol}`);
    }
  }

  const reqCompatSource = sources.reqCompatSource ?? '';
  for (const required of [
    'applied_profile: Option<String>',
    'native_applied: bool',
    'fn apply_v3_provider_req_compat_profile(',
    'run_req_outbound_stage3_compat(ReqOutboundCompatInput',
  ]) {
    if (!reqCompatSource.includes(required)) {
      failures.push(`ProviderReqCompat06 missing typed compat evidence ${required}`);
    }
  }

  const configSection = forwarderSection(sources.configFixture ?? '');
  if (!configSection.includes('provider = "glmrelay_anthropic"')) {
    failures.push('GLM forwarder fixture must select glmrelay_anthropic');
  }
  if (configSection.includes('provider = "glmrelay_openai"')) {
    failures.push('GLM forwarder fixture must exclude glmrelay_openai');
  }
  if (!(sources.configFixture ?? '').includes('compatibility_profile = "chat:glm"')) {
    failures.push('GLM Anthropic provider fixture must declare chat:glm');
  }

  for (const [label, source] of [
    ['Responses-to-Chat codec', sources.genericResponsesCodec],
    ['generic Anthropic codec', sources.genericAnthropicCodec],
    ['generic request outbound codec', sources.genericOutboundCodec],
  ]) {
    if (/glm/u.test(String(source ?? '').toLowerCase())) {
      failures.push(`${label} must not contain GLM-specific behavior`);
    }
  }

  let packageJson = {};
  try {
    packageJson = JSON.parse(sources.packageJson ?? '{}');
  } catch (error) {
    failures.push(`${PATHS.packageJson}: invalid JSON: ${error.message}`);
  }
  for (const script of [
    'verify:v3-provider-compat-module-boundary',
    'test:v3-provider-compat-module-boundary-red-fixtures',
    'test:v3-glm-anthropic-request-outbound-compat',
  ]) {
    if (!packageJson.scripts?.[script]) failures.push(`package.json missing script ${script}`);
  }
  for (const script of [
    'verify:v3-provider-compat-module-boundary',
    'test:v3-provider-compat-module-boundary-red-fixtures',
  ]) {
    if (!(sources.architectureCi ?? '').includes(`'${script}'`)) {
      failures.push(`V3 architecture CI missing ${script}`);
    }
  }

  return failures;
}
