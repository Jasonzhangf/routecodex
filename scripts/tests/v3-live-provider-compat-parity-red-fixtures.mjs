#!/usr/bin/env node
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';

const repo = process.cwd();
const verifier = resolve(repo, 'scripts/architecture/verify-v3-live-provider-compat-parity.mjs');
const cases = [
  {
    name: 'matrix endpoint transport case removed',
    file: 'docs/architecture/manifests/v3.live_provider_compat.parity.yml',
    mutateYaml: (doc) => {
      const target = doc.cases.find((entry) => entry.id === 'gemini_generate_content_sse_http');
      target.transport = 'missing_sse_http';
    },
    diagnostic: /missing matrix case for gemini_generate_content x sse_http/,
  },
  {
    name: 'production ready without live evidence',
    file: 'docs/architecture/manifests/v3.live_provider_compat.parity.yml',
    mutateYaml: (doc) => {
      const target = doc.cases.find((entry) => entry.id === 'openai_chat_json_http');
      target.live_evidence = {
        status: 'pending',
        refs: [],
        blockers: ['live_openai_chat_json_provider_replay_pending'],
      };
      target.production = { status: 'ready', blockers: [] };
    },
    diagnostic: /production-ready case lacks live evidence/,
  },
  {
    name: '402 error case removed',
    file: 'docs/architecture/manifests/v3.live_provider_compat.parity.yml',
    mutateYaml: (doc) => {
      const target = doc.error_cases.find((entry) => entry.id === 'http_402');
      target.id = 'http_402_removed';
    },
    diagnostic: /missing error case http_402/,
  },
  {
    name: 'reroutable provider failure regressed to pending',
    file: 'docs/architecture/manifests/v3.live_provider_compat.parity.yml',
    mutateYaml: (doc) => {
      const target = doc.error_cases.find((entry) => entry.id === 'http_401');
      target.status = 'pending';
      delete target.controlled_evidence;
    },
    diagnostic: /reroutable provider failure case must not be vague pending http_401/,
  },
  {
    name: 'timeout live pending blocker removed',
    file: 'docs/architecture/manifests/v3.live_provider_compat.parity.yml',
    mutateYaml: (doc) => {
      const target = doc.error_cases.find((entry) => entry.id === 'timeout');
      target.live_evidence = { status: 'live_pending', refs: [], gates: [] };
    },
    diagnostic: /error case timeout live evidence must name blockers when not live_verified/,
  },
  {
    name: 'provider failure blackbox gate removed from manifest',
    file: 'docs/architecture/manifests/v3.live_provider_compat.parity.yml',
    mutateYaml: (doc) => {
      doc.verification_gates = doc.verification_gates.filter((gate) => gate !== 'npm run verify:provider-failure-ban-blackbox');
    },
    diagnostic: /missing npm run verify:provider-failure-ban-blackbox/,
  },
  {
    name: 'stale Anthropic endpoint blocker reintroduced',
    file: 'docs/architecture/manifests/v3.live_provider_compat.parity.yml',
    mutateYaml: (doc) => {
      doc.production_blockers.push({
        blocker_id: 'final_5555_profile_anthropic_endpoint_not_enabled',
        owner_feature_id: 'v3.anthropic_relay_runtime_integration',
        evidence: 'stale',
      });
    },
    diagnostic: /stale current Anthropic production blocker reintroduced final_5555_profile_anthropic_endpoint_not_enabled/,
  },
  {
    name: 'current 5555 provider removed',
    file: 'docs/architecture/manifests/v3.live_provider_compat.parity.yml',
    mutateYaml: (doc) => {
      doc.current_5555_profile_audit.providers = doc.current_5555_profile_audit.providers
        .filter((provider) => provider !== 'glmrelay_anthropic');
    },
    diagnostic: /missing glmrelay_anthropic in current_5555_profile_audit\.providers/,
  },
  {
    name: 'Anthropic JSON current evidence downgraded to blocker',
    file: 'docs/architecture/manifests/v3.live_provider_compat.parity.yml',
    mutateYaml: (doc) => {
      const target = doc.cases.find((entry) => entry.id === 'anthropic_messages_json_http');
      target.live_evidence = {
        status: 'blocker',
        refs: [],
        blockers: ['live_anthropic_messages_json_provider_replay_pending'],
      };
      target.production = {
        status: 'blocked',
        blockers: ['live_anthropic_provider_compat_pending'],
      };
    },
    diagnostic: /Anthropic Messages current 5555 case must be live_verified and ready anthropic_messages_json_http/,
  },
  {
    name: 'Responses Relay WebSocket live evidence downgraded',
    file: 'docs/architecture/manifests/v3.live_provider_compat.parity.yml',
    mutateYaml: (doc) => {
      const target = doc.cases.find((entry) => entry.id === 'responses_relay_websocket_v2');
      target.live_evidence = {
        status: 'pending',
        refs: [],
        blockers: ['live_inbound_websocket_provider_replay_pending'],
      };
      target.production = {
        status: 'blocked',
        blockers: ['live_inbound_websocket_replay_pending'],
      };
    },
    diagnostic: /Responses Relay WebSocket v2 must cite current managed 5555 live_verified evidence and be ready/,
  },
  {
    name: 'remote continuation exact-pin blocker removed',
    file: 'docs/architecture/manifests/v3.live_provider_compat.parity.yml',
    mutateYaml: (doc) => {
      doc.production_blockers = doc.production_blockers
        .filter((entry) => entry.blocker_id !== 'remote_continuation_exact_pin_provider_profile_unavailable');
    },
    diagnostic: /missing explicit remote continuation exact-pin provider\/profile blocker/,
  },
  {
    name: 'live evidence confused with controlled evidence',
    file: 'docs/architecture/manifests/v3.live_provider_compat.parity.yml',
    mutateYaml: (doc) => {
      const target = doc.cases.find((entry) => entry.id === 'anthropic_messages_sse_http');
      target.live_evidence.status = 'controlled_verified';
      target.production = { status: 'ready', blockers: [] };
    },
    diagnostic: /live_evidence must not reuse controlled evidence status in case anthropic_messages_sse_http/,
  },
  {
    name: 'codex capability field removed',
    file: 'docs/architecture/manifests/v3.live_provider_compat.parity.yml',
    mutateYaml: (doc) => {
      const target = doc.capability_cases.find((entry) => entry.id === 'codex_models_capability_catalog');
      target.required_fields = target.required_fields.filter((field) => field !== 'input_modalities');
    },
    diagnostic: /capability field missing input_modalities/,
  },
  {
    name: 'codex selector absence field removed',
    file: 'docs/architecture/manifests/v3.live_provider_compat.parity.yml',
    mutateYaml: (doc) => {
      const target = doc.capability_cases.find((entry) => entry.id === 'codex_models_capability_catalog');
      target.selector_absence_fields = target.selector_absence_fields.filter((field) => field !== 'tool_mode');
    },
    diagnostic: /selector absence field missing tool_mode/,
  },
  {
    name: 'Hub VR provider-specific ban removed',
    file: 'docs/architecture/manifests/v3.live_provider_compat.parity.yml',
    mutateYaml: (doc) => {
      doc.production_policy.provider_specific_hub_vr_forbidden = false;
    },
    diagnostic: /Hub\/VR provider-specific branch ban missing/,
  },
  {
    name: 'package verifier script removed',
    file: 'package.json',
    marker: '    "verify:v3-live-provider-compat-parity": "node scripts/architecture/verify-v3-live-provider-compat-parity.mjs",\n',
    mutation: '',
    diagnostic: /missing script verify:v3-live-provider-compat-parity/,
  },
  {
    name: 'function map binding removed',
    file: 'docs/architecture/v3-function-map.yml',
    marker: '  - feature_id: v3.live_provider_compat_parity_closeout\n',
    mutation: '  - feature_id: v3.live_provider_compat_parity_closeout_removed\n',
    diagnostic: /missing feature entry v3.live_provider_compat_parity_closeout/,
  },
  {
    name: 'wiki production rule removed',
    file: 'docs/architecture/wiki/v3-live-provider-compat-parity.md',
    marker: 'production ready requires controlled + live evidence',
    mutation: 'production ready requires a maintainer note',
    diagnostic: /missing production ready requires controlled \+ live evidence/,
  },
];

const copyPaths = [
  'docs/architecture/manifests/v3.live_provider_compat.parity.yml',
  'docs/architecture/v3-function-map.yml',
  'docs/architecture/v3-mainline-call-map.yml',
  'docs/architecture/v3-resource-operation-map.yml',
  'docs/architecture/v3-verification-map.yml',
  'docs/architecture/wiki/v3-live-provider-compat-parity.md',
  'docs/goals/v3-live-provider-compat-parity-closeout-plan.md',
  'package.json',
];

const failures = [];
for (const testCase of cases) {
  const root = mkdtempSync(join(tmpdir(), 'v3-live-provider-compat-red-'));
  try {
    for (const relative of copyPaths) {
      cpSync(resolve(repo, relative), resolve(root, relative), { recursive: true });
    }
    const target = resolve(root, testCase.file);
    const source = readFileSync(target, 'utf8');
    if (testCase.mutateYaml) {
      const doc = YAML.parse(source);
      testCase.mutateYaml(doc);
      writeFileSync(target, YAML.stringify(doc));
    } else {
      if (!source.includes(testCase.marker)) {
        failures.push(testCase.name + ': mutation marker missing');
        continue;
      }
      writeFileSync(target, source.replace(testCase.marker, testCase.mutation));
    }
    const result = spawnSync(process.execPath, [verifier], { cwd: root, encoding: 'utf8' });
    const output = (result.stdout ?? '') + '\n' + (result.stderr ?? '');
    if (result.status === 0) failures.push(testCase.name + ': verifier unexpectedly passed');
    else if (!testCase.diagnostic.test(output)) {
      failures.push(testCase.name + ': wrong diagnostic: ' + output.slice(-700));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (failures.length) {
  console.error('[test:v3-live-provider-compat-parity-red-fixtures] failed');
  for (const failure of failures) console.error('- ' + failure);
  process.exit(1);
}
console.log('[test:v3-live-provider-compat-parity-red-fixtures] ok (' + cases.length + ' forbidden mutations rejected)');
