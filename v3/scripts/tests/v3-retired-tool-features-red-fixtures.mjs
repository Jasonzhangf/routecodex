#!/usr/bin/env node
// Red fixtures for the V3 retired-tool-feature guard.
//
// Each case mutates one active file in a temporary repository skeleton and
// verifies that the guard rejects it with the expected diagnostic. Positive
// samples verify that ordinary tools, ToolThinking, hosted search, normal
// reasoning, and the retained explicit config rejections stay legal.

import { readFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const v3Root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const guardPath = resolve(v3Root, 'scripts/architecture/verify-v3-retired-tool-features.mjs');

function write(root, relative, content) {
  const abs = join(root, relative);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf8');
}

function buildSkeleton(root) {
  write(
    root,
    'v3/crates/routecodex-v3-runtime/src/hub_v1/resp_chat_process_03_governed.rs',
    'pub(crate) fn parse_v3_tool_thinking_fields_from_object_at_resp03() {}\n',
  );
  write(root, 'v3/crates/routecodex-v3-runtime/src/kernel.rs', 'pub mod kernel;\n');
  write(root, 'v3/crates/routecodex-v3-cli/src/main.rs', 'fn main() {}\n');
  write(
    root,
    'v3/crates/routecodex-v3-runtime/src/hub_v1/tool_thinking_hooks.rs',
    'pub(crate) fn inject_v3_tool_thinking_guidance_at_req04() {}\n',
  );
  write(
    root,
    'v3/crates/routecodex-v3-config/src/provider_config_tests.rs',
    'fn retired_metadata_center_local_search_mode_is_rejected_at_compile() {}\n',
  );
  write(
    root,
    'v3/crates/routecodex-v3-config/src/internal.toml',
    '[features]\ntool_thinking = false\n\n[chat_process.refill]\nmax_consecutive_refills = 1\n',
  );
  write(
    root,
    'v3/crates/routecodex-v3-config/src/types.rs',
    'pub const RETIRED_SEARCH: &[&str] = &["metadata_center_local_search", "servertool_search_backend"];\n',
  );
  write(
    root,
    'v3/package.json',
    JSON.stringify(
      {
        name: 'routecodex-v3',
        type: 'module',
        scripts: {
          'verify:v3-retired-tool-features':
            'node scripts/architecture/verify-v3-retired-tool-features.mjs',
          'test:v3-retired-tool-features-red-fixtures':
            'node scripts/tests/v3-retired-tool-features-red-fixtures.mjs',
        },
      },
      null,
      2,
    ) + '\n',
  );
  write(
    root,
    'v3/scripts/architecture/verify-v3-retired-tool-features.mjs',
    readFileSync(guardPath, 'utf8'),
  );
  write(
    root,
    'v3/scripts/tests/v3-retired-tool-features-red-fixtures.mjs',
    '#!/usr/bin/env node\nconsole.log("fixture placeholder");\n',
  );
  write(
    root,
    'v3/scripts/architecture/verify-v3-architecture-ci.mjs',
    [
      'const STEPS = [',
      "  ['verify:v3-retired-tool-features', 'retired feature guard'],",
      "  ['test:v3-retired-tool-features-red-fixtures', 'retired feature fixtures'],",
      '];',
      'console.log(STEPS.length);',
    ].join('\n') + '\n',
  );
  write(
    root,
    'scripts/ci/repo-sanity.mjs',
    "const removedRoots = new Set(['config.toolreason-10000.toml']);\nconsole.log(removedRoots);\n",
  );
  const emptyYaml = '{}\n';
  for (const file of [
    'docs/architecture/v3-function-map.yml',
    'docs/architecture/v3-resource-operation-map.yml',
    'docs/architecture/v3-mainline-call-map.yml',
    'docs/architecture/v3-verification-map.yml',
    'docs/architecture/function-map.yml',
    'docs/architecture/resource-operation-map.yml',
    'docs/architecture/mainline-call-map.yml',
    'docs/architecture/verification-map.yml',
    'docs/architecture/v3-architecture-audit-locks.yml',
    'docs/architecture/mainline-binding-budget.yml',
  ]) {
    write(root, file, emptyYaml);
  }
  write(root, 'docs/architecture/no-fallback-diff-rules.json', '{}\n');
  mkdirSync(join(root, 'docs/architecture/manifests'), { recursive: true });
}

function runGuard(root) {
  return spawnSync(process.execPath, [guardPath], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, ROUTECODEX_V3_SOURCE_ROOT: root },
  });
}

let passed = 0;
const failures = [];

function expectReject(name, mutate, diagnostic) {
  const root = mkdtempSync(join(tmpdir(), 'v3-retired-reject-'));
  try {
    buildSkeleton(root);
    mutate(root);
    const result = runGuard(root);
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    if (result.status !== 0 && diagnostic.test(output)) {
      passed += 1;
      console.log(`PASS ${name} (exit=${result.status})`);
    } else {
      failures.push(`${name}: wrong outcome (exit=${result.status})\n${output.slice(-1600)}`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function expectAccept(name, mutate) {
  const root = mkdtempSync(join(tmpdir(), 'v3-retired-accept-'));
  try {
    buildSkeleton(root);
    mutate(root);
    const result = runGuard(root);
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    if (result.status === 0) {
      passed += 1;
      console.log(`PASS ${name} (exit=0)`);
    } else {
      failures.push(`${name}: expected acceptance, got exit=${result.status}\n${output.slice(-1600)}`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// 1. Restore a Toolreason runtime hook/symbol.
expectReject(
  'source: restore toolreason runtime symbol',
  (root) => {
    write(
      root,
      'v3/crates/routecodex-v3-runtime/src/hub_v1/resp_chat_process_03_governed.rs',
      'pub(crate) fn map_v3_toolreason_stream_event_at_resp03(_v: &mut serde_json::Value) {}\n',
    );
  },
  /toolreason identifier/u,
);

// 2. Restore an internal Toolreason feature key.
expectReject(
  'config: restore toolreason internal key',
  (root) => {
    write(
      root,
      'v3/crates/routecodex-v3-config/src/internal.toml',
      '[features]\ntool_thinking = false\ntoolreason_client_projection = false\n\n[chat_process.refill]\nmax_consecutive_refills = 1\n',
    );
  },
  /retired toolreason feature key/u,
);

// 3. Restore a servertool crate/module/CLI entry.
expectReject(
  'source: restore servertool module',
  (root) => {
    write(
      root,
      'v3/crates/routecodex-v3-runtime/src/kernel.rs',
      'pub mod servertool_revived { pub fn plan_servertool_outcome_json() {} }\n',
    );
  },
  /servertool outcome planner/u,
);

expectReject(
  'source: restore servertool CLI projection',
  (root) => {
    write(
      root,
      'v3/crates/routecodex-v3-cli/src/main.rs',
      'fn run_servertool_response_stage_json() {}\n',
    );
  },
  /servertool response stage runner/u,
);

// 4. Add retired bindings back to maps/manifests.
expectReject(
  'map: restore servertool lifecycle owner',
  (root) => {
    write(
      root,
      'docs/architecture/verification-map.yml',
      'features:\n  - feature_id: v3.servertool_hook_skeleton_lifecycle\n    status: active\n',
    );
  },
  /servertool_hook_skeleton_lifecycle/u,
);

expectReject(
  'map: restore toolreason active entry',
  (root) => {
    write(
      root,
      'docs/architecture/v3-function-map.yml',
      'features:\n  - feature_id: v3.toolreason_projection\n    status: active\n',
    );
  },
  /toolreason/u,
);

expectReject(
  'manifest: restore retired active manifest file',
  (root) => {
    write(
      root,
      'docs/architecture/manifests/v3.hub_relay.tool_servertool_multiturn_parity.mainline.yml',
      'chain_id: v3.hub_relay.tool_servertool_multiturn_parity\n',
    );
  },
  /retired active manifest restored/u,
);

// 5. Remove the retirement gate from the umbrella.
expectReject(
  'ci: remove retirement gate from umbrella',
  (root) => {
    write(
      root,
      'v3/scripts/architecture/verify-v3-architecture-ci.mjs',
      "const STEPS = [['test:v3-retired-tool-features-red-fixtures', 'fixtures']];\nconsole.log(STEPS.length);\n",
    );
  },
  /verify:v3-retired-tool-features removed from umbrella/u,
);

expectReject(
  'ci: remove red fixture gate from umbrella',
  (root) => {
    write(
      root,
      'v3/scripts/architecture/verify-v3-architecture-ci.mjs',
      "const STEPS = [['verify:v3-retired-tool-features', 'guard']];\nconsole.log(STEPS.length);\n",
    );
  },
  /test:v3-retired-tool-features-red-fixtures removed from umbrella/u,
);

// 6. Put the removed config file back into the allowlist.
expectReject(
  'ci: removed config allowed again',
  (root) => {
    write(
      root,
      'scripts/ci/repo-sanity.mjs',
      "const removedRoots = new Set();\nconsole.log(removedRoots);\n",
    );
  },
  /removedRoots protection for config\.toolreason-10000\.toml removed/u,
);

// 7. Positive retained samples must pass the guard.
expectAccept(
  'positive: ordinary tool, ToolThinking, hosted search, reasoning pass',
  (root) => {
    write(
      root,
      'v3/crates/routecodex-v3-runtime/src/hub_v1/tool_thinking_hooks.rs',
      'pub(crate) fn inject_v3_tool_thinking_guidance_at_req04() { let _ = "reason, goal_alignment_confidence, web_search, thinking, model_id"; }\n',
    );
  },
);

expectAccept(
  'positive: explicit retired-config rejection stays legal',
  (root) => {
    write(
      root,
      'v3/crates/routecodex-v3-config/src/provider_config_tests.rs',
      'fn retired_metadata_center_local_search_mode_is_rejected_at_compile() { let _ = ["metadata_center_local_search", "servertool_search_backend"]; }\n',
    );
  },
);

for (const failure of failures) console.error(failure);
if (failures.length > 0) {
  console.error(`[test:v3-retired-tool-features-red-fixtures] ${failures.length} case(s) failed`);
  process.exit(1);
}
console.log(`[test:v3-retired-tool-features-red-fixtures] ok (${passed} case(s) passed)`);
