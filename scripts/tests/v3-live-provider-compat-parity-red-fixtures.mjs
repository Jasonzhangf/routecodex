#!/usr/bin/env node
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const repo = process.cwd();
const verifier = resolve(repo, 'scripts/architecture/verify-v3-live-provider-compat-parity.mjs');
const cases = [
  {
    name: 'matrix endpoint transport case removed',
    file: 'docs/architecture/manifests/v3.live_provider_compat.parity.yml',
    marker: '  - id: gemini_generate_content_sse_http\n    endpoint: gemini_generate_content\n    protocol: gemini\n    transport: sse_http\n',
    mutation: '  - id: gemini_generate_content_sse_http\n    endpoint: gemini_generate_content\n    protocol: gemini\n    transport: missing_sse_http\n',
    diagnostic: /missing matrix case for gemini_generate_content x sse_http/,
  },
  {
    name: 'production ready without live evidence',
    file: 'docs/architecture/manifests/v3.live_provider_compat.parity.yml',
    marker: '    production: { status: blocked, blockers: [live_openai_chat_provider_compat_pending] }',
    mutation: '    production: { status: ready, blockers: [] }',
    diagnostic: /production-ready case lacks live evidence/,
  },
  {
    name: '402 error case removed',
    file: 'docs/architecture/manifests/v3.live_provider_compat.parity.yml',
    marker: '  - { id: http_402,',
    mutation: '  - { id: http_402_removed,',
    diagnostic: /missing error case http_402/,
  },
  {
    name: 'codex capability field removed',
    file: 'docs/architecture/manifests/v3.live_provider_compat.parity.yml',
    marker: ', input_modalities]',
    mutation: ']',
    diagnostic: /capability field missing input_modalities/,
  },
  {
    name: 'Hub VR provider-specific ban removed',
    file: 'docs/architecture/manifests/v3.live_provider_compat.parity.yml',
    marker: '  provider_specific_hub_vr_forbidden: true',
    mutation: '  provider_specific_hub_vr_forbidden: false',
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
    if (!source.includes(testCase.marker)) {
      failures.push(testCase.name + ': mutation marker missing');
      continue;
    }
    writeFileSync(target, source.replace(testCase.marker, testCase.mutation));
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
