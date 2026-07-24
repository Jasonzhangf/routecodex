#!/usr/bin/env node
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const repo = process.cwd();
const verifier = 'scripts/architecture/verify-v3-stopless-state-machine-docs.mjs';
const copied = [
  'package.json',
  'docs/architecture/manifests/v3.servertool_hook_skeleton_lifecycle.mainline.yml',
  'docs/architecture/v3-mainline-call-map.yml',
  'docs/architecture/wiki',
  'scripts/architecture/render-v3-stopless-state-machine-docs.mjs',
  'scripts/architecture/verify-v3-stopless-state-machine-docs.mjs',
  'scripts/architecture/wiki-html-lib.mjs',
  'scripts/architecture/architecture-wiki-lib.mjs',
  'scripts/architecture/mainline-call-map-lib.mjs',
  'scripts/architecture/v3-mainline-caller-flow-lib.mjs',
  'scripts/architecture/v3-req04-tool-governance-review-lib.mjs',
];

const cases = [
  {
    name: 'manifest loses GuardTerminal state',
    path: 'docs/architecture/manifests/v3.servertool_hook_skeleton_lifecycle.mainline.yml',
    marker: '    - { id: GuardTerminal, kind: terminal, visible_to_client: true, visible_to_provider: false, stored: false, description: "The configured consecutive-stop guard is reached; current provider stop passes through without no-op or internal diagnostic and StoplessCenter is cleared." }\n',
    replacement: '',
    diagnostic: /missing StoplessCenter state GuardTerminal/u,
  },
  {
    name: 'manifest loses abnormal transition class',
    path: 'docs/architecture/manifests/v3.servertool_hook_skeleton_lifecycle.mainline.yml',
    mutate(source) {
      return source.replaceAll('class: abnormal', 'class: normal');
    },
    diagnostic: /state_machine\.transitions must include abnormal edges/u,
  },
  {
    name: 'manifest loses generated html binding',
    path: 'docs/architecture/manifests/v3.servertool_hook_skeleton_lifecycle.mainline.yml',
    marker: '  generated_html: docs/architecture/wiki/html/stopless-session-mainline-source.html\n',
    replacement: '  generated_html: docs/architecture/wiki/html/stopless-session-mainline-source-stale.html\n',
    diagnostic: /missing generated html|HTML renderer did not return|edge_flow_docs\.generated_html/u,
  },
  {
    name: 'markdown is hand edited stale',
    path: 'docs/architecture/wiki/stopless-session-mainline-source.md',
    mutate(source) {
      return source.replace('# Stopless Session Mainline Source', '# Stopless Session Mainline Source Stale');
    },
    diagnostic: /generated markdown is stale/u,
  },
  {
    name: 'html is hand edited stale',
    path: 'docs/architecture/wiki/html/stopless-session-mainline-source.html',
    mutate(source) {
      return source.replace('Stopless Session Mainline Source', 'Stopless Session Mainline Source Stale');
    },
    diagnostic: /generated html is stale/u,
  },
  {
    name: 'package architecture docs gate omits state-machine docs verifier',
    path: 'package.json',
    marker: ' && npm run verify:v3-stopless-state-machine-docs',
    replacement: '',
    diagnostic: /verify:v3-architecture-docs must include verify:v3-stopless-state-machine-docs/u,
  },
  {
    name: 'manifest omits state-machine verifier gate',
    path: 'docs/architecture/manifests/v3.servertool_hook_skeleton_lifecycle.mainline.yml',
    marker: '  - npm run verify:v3-stopless-state-machine-docs\n',
    replacement: '',
    diagnostic: /verification_gates must include npm run verify:v3-stopless-state-machine-docs/u,
  },
  {
    name: 'manifest allows provider-request dry-run to write StoplessCenter',
    path: 'docs/architecture/manifests/v3.servertool_hook_skeleton_lifecycle.mainline.yml',
    marker: '  provider_request_dry_run_writes_stopless_control: forbidden\n',
    replacement: '  provider_request_dry_run_writes_stopless_control: allowed\n',
    diagnostic: /dry_run_contract\.provider_request_dry_run_writes_stopless_control must be forbidden/u,
  },
  {
    name: 'manifest allows stopless guideline history persistence',
    path: 'docs/architecture/manifests/v3.servertool_hook_skeleton_lifecycle.mainline.yml',
    marker: '  history_persistence: forbidden\n',
    replacement: '  history_persistence: allowed\n',
    diagnostic: /guidance_rewrite\.history_persistence must be forbidden/u,
  },
];

const failures = [];

for (const fixture of cases) {
  const root = mkdtempSync(join(tmpdir(), 'v3-stopless-state-machine-red-'));
  try {
    const repoNodeModules = resolve(repo, 'node_modules');
    if (existsSync(repoNodeModules)) {
      symlinkSync(repoNodeModules, resolve(root, 'node_modules'), 'dir');
    }
    for (const rel of copied) {
      const source = resolve(repo, rel);
      const target = resolve(root, rel);
      mkdirSync(dirname(target), { recursive: true });
      cpSync(source, target, { recursive: true });
    }
    const target = resolve(root, fixture.path);
    const original = readFileSync(target, 'utf8');
    let mutated;
    if (fixture.mutate) {
      mutated = fixture.mutate(original);
    } else {
      if (!original.includes(fixture.marker)) {
        failures.push(`${fixture.name}: mutation marker missing`);
        continue;
      }
      mutated = original.replace(fixture.marker, fixture.replacement);
    }
    if (mutated === original) {
      failures.push(`${fixture.name}: mutation did not change ${fixture.path}`);
      continue;
    }
    writeFileSync(target, mutated, 'utf8');
    const result = spawnSync(process.execPath, [verifier], { cwd: root, encoding: 'utf8' });
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    if (result.status === 0) failures.push(`${fixture.name}: verifier unexpectedly passed`);
    else if (!fixture.diagnostic.test(output)) {
      failures.push(`${fixture.name}: wrong diagnostic: ${output.slice(-1600)}`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (failures.length > 0) {
  console.error('[test:v3-stopless-state-machine-docs-red-fixtures] failed');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`[test:v3-stopless-state-machine-docs-red-fixtures] ok (${cases.length} forbidden mutations rejected)`);
