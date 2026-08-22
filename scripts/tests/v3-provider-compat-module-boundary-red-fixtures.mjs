#!/usr/bin/env node
import {
  loadProviderCompatBoundarySources,
  verifyProviderCompatBoundary,
} from '../architecture/v3-provider-compat-module-boundary-lib.mjs';

const baseline = loadProviderCompatBoundarySources();
const cases = [
  {
    name: 'module owner removed',
    key: 'moduleRegistry',
    mutate: (source) => source.replace(
      'module_id: v3-provider-compat-profile-loading',
      'module_id: removed-provider-compat-profile-loading',
    ),
    diagnostic: /provider compat module must be active/u,
  },
  {
    name: 'typed resource removed',
    key: 'resourceMap',
    mutate: (source) => source.replace(
      'resource_id: v3.provider_compat.profile_application',
      'resource_id: v3.provider_compat.removed_profile_application',
    ),
    diagnostic: /profile application resource must be anchored/u,
  },
  {
    name: 'GLM feature lifecycle status removed',
    key: 'v3FunctionMap',
    mutate: (source) => source.replace(
      'status: runtime_live_verified_7777_20260819',
      'status: unregistered',
    ),
    diagnostic: /independent source or runtime verified status/u,
  },
  {
    name: 'compat core call edge bypassed',
    key: 'mainlineMap',
    mutate: (source) => source.replace(
      'callee_symbol: run_req_outbound_stage3_compat',
      'callee_symbol: bypass_req_outbound_stage3_compat',
    ),
    diagnostic: /bind V3 helper directly to compat core/u,
  },
  {
    name: 'forwarder regresses to OpenAI provider',
    key: 'configFixture',
    mutate: (source) => source.replace(
      'provider = "glmrelay_anthropic", model = "glm-5.2", priority = 1',
      'provider = "glmrelay_openai", model = "glm-5.2", priority = 1',
    ),
    diagnostic: /forwarder fixture must select glmrelay_anthropic/u,
  },
  {
    name: 'typed profile evidence removed',
    key: 'reqCompatSource',
    mutate: (source) => source.replace(
      'applied_profile: Option<String>',
      'removed_profile_evidence: Option<String>',
    ),
    diagnostic: /missing typed compat evidence applied_profile/u,
  },
  {
    name: 'GLM Anthropic profile branch removed',
    key: 'providerCompatSource',
    mutate: (source) => {
      const marker = 'if is_glm_profile(profile_id) {';
      const start = source.indexOf(marker);
      const end = source.indexOf('if is_deepseek_max_profile(profile_id) {', start);
      const branch = source
        .slice(start, end)
        .replace('"anthropic-messages"', '"other-provider-protocol"');
      return source.slice(0, start) + branch + source.slice(end);
    },
    diagnostic: /missing GLM Anthropic profile application branch/u,
  },
  {
    name: 'GLM branch leaks into generic Anthropic codec',
    key: 'genericAnthropicCodec',
    mutate: (source) => `${source}\n// glm provider branch`,
    diagnostic: /generic Anthropic codec must not contain GLM-specific behavior/u,
  },
];

const failures = [];
for (const testCase of cases) {
  const mutated = {
    ...baseline,
    [testCase.key]: testCase.mutate(baseline[testCase.key]),
  };
  const diagnostics = verifyProviderCompatBoundary(mutated);
  if (!diagnostics.some((diagnostic) => testCase.diagnostic.test(diagnostic))) {
    failures.push(`${testCase.name}: expected diagnostic ${testCase.diagnostic}`);
  }
}

if (failures.length > 0) {
  console.error('[test:v3-provider-compat-module-boundary-red-fixtures] failed');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(
  `[test:v3-provider-compat-module-boundary-red-fixtures] ok (${cases.length} red fixtures)`,
);
