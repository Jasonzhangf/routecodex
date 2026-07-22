#!/usr/bin/env node
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const repo = process.cwd();
const verifier = resolve(repo, 'scripts/architecture/verify-v3-stopless-resource-control.mjs');
const copied = [
  'package.json',
  'docs/architecture/v3-resource-operation-map.yml',
  'docs/architecture/v3-function-map.yml',
  'docs/architecture/v3-mainline-call-map.yml',
  'docs/architecture/v3-verification-map.yml',
  'docs/architecture/manifests/v3.servertool_hook_skeleton_lifecycle.mainline.yml',
  'docs/architecture/snapshot-stage-contract.md',
  'scripts/architecture/verify-v3-stopless-resource-control.mjs',
  'scripts/tests/v3-stopless-resource-control-red-fixtures.mjs',
  'v3/crates/routecodex-v3-runtime/src/hub_v1.rs',
  'v3/crates/routecodex-v3-runtime/src/hub_v1/common.rs',
  'v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs',
  'v3/crates/routecodex-v3-runtime/src/hub_v1/servertool_hooks.rs',
  'v3/crates/routecodex-v3-runtime/tests/responses_relay_local_continuation_integration.rs',
  'v3/crates/routecodex-v3-debug/src/lib.rs',
];

const cases = [
  {
    name: 'runtime adapter promoted to semantic owner',
    path: 'docs/architecture/v3-resource-operation-map.yml',
    marker: '    owner_node: StoplessCenterMetadataControl\n',
    replacement: '    owner_node: V3ResponsesRelayStoplessControlState\n',
    diagnostic: /owner_node must equal "StoplessCenterMetadataControl"/u,
  },
  {
    name: 'StoplessCenter moved out of Metadata Center lifecycle',
    path: 'docs/architecture/v3-resource-operation-map.yml',
    marker: '    lifecycle: v3.metadata.center.mainline\n    owner_feature_id: v3.servertool_hook_skeleton_lifecycle\n',
    replacement: '    lifecycle: v3.servertool_hook_skeleton_lifecycle\n    owner_feature_id: v3.servertool_hook_skeleton_lifecycle\n',
    diagnostic: /lifecycle must equal "v3\.metadata\.center\.mainline"/u,
  },
  {
    name: 'CLI carries scope',
    path: 'docs/architecture/v3-resource-operation-map.yml',
    marker: 'cli_contract: { carries_scope: false, carries_state: false, parameters: none',
    replacement: 'cli_contract: { carries_scope: true, carries_state: false, parameters: none',
    diagnostic: /cli_contract\.carries_scope must equal false/u,
  },
  {
    name: 'CLI carries StoplessCenter state',
    path: 'docs/architecture/v3-resource-operation-map.yml',
    marker: 'cli_contract: { carries_scope: false, carries_state: false, parameters: none',
    replacement: 'cli_contract: { carries_scope: false, carries_state: true, parameters: stopless_state',
    diagnostic: /cli_contract\.carries_state must equal false/u,
  },
  {
    name: 'generic Hub closeout claims StoplessCenter',
    path: 'docs/architecture/v3-mainline-call-map.yml',
    marker: 'step_id: v3-hub-relay-closeout-03,',
    replacement: 'step_id: v3-hub-relay-closeout-03,',
    mutate(source) {
      const marker = 'step_id: v3-hub-relay-closeout-03,';
      const start = source.indexOf(marker);
      const end = source.indexOf('\n', start);
      return source.slice(0, start)
        + source.slice(start, end).replace('side_channel_writes: []', `side_channel_writes: [${resourceId}]`)
        + source.slice(end);
    },
    diagnostic: /undeclared cross-SOP StoplessCenter access outside/u,
  },
  {
    name: 'server aggregate edge claims control write',
    path: 'docs/architecture/v3-mainline-call-map.yml',
    mutate(source) {
      const marker = 'step_id: v3-responses-relay-server-02,';
      const start = source.indexOf(marker);
      const end = source.indexOf('\n', start);
      return source.slice(0, start)
        + source.slice(start, end).replace('side_channel_writes: []', `side_channel_writes: [${resourceId}]`)
        + source.slice(end);
    },
    diagnostic: /undeclared cross-SOP StoplessCenter access outside|aggregate server edge must not claim control\/resource writes/u,
  },
  {
    name: 'local continuation carrier owns StoplessCenter',
    path: 'v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs',
    marker: "struct V3ResponsesRelayLocalContinuationExecution<'state> {\n",
    replacement: "struct V3ResponsesRelayLocalContinuationExecution<'state> {\n    stopless_control: &'state V3ResponsesRelayStoplessControlState,\n",
    diagnostic: /local continuation execution must not own stopless_control/u,
  },
  {
    name: 'request fallback scope can write StoplessCenter',
    path: 'v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs',
    marker: 'session_id.starts_with("request:")',
    replacement: 'session_id.starts_with("routecodex-disabled-request-fallback:")',
    diagnostic: /request-fallback scope guard missing session_id\.starts_with\("request:"\)/u,
  },
  {
    name: 'StoplessCenter state loses max_stop_budget field',
    path: 'v3/crates/routecodex-v3-runtime/src/hub_v1/common.rs',
    marker: '    max_stop_budget: u32,\n',
    replacement: '',
    diagnostic: /V3StoplessCenterState missing max_stop_budget/u,
  },
  {
    name: 'StoplessCenter state loses updated_at field',
    path: 'v3/crates/routecodex-v3-runtime/src/hub_v1/common.rs',
    marker: '    updated_at: u64,\n',
    replacement: '',
    diagnostic: /V3StoplessCenterState missing updated_at/u,
  },
  {
    name: 'resource map loses StoplessCenter updated_at field',
    path: 'docs/architecture/v3-resource-operation-map.yml',
    marker: ', updated_at]',
    replacement: ']',
    diagnostic: /state_fields must include updated_at/u,
  },
  {
    name: 'no-op CLI carries session scope',
    path: 'v3/crates/routecodex-v3-runtime/src/hub_v1/servertool_hooks.rs',
    mutate(source) {
      return source.replace(
        /"routecodex hook run reasoningStop(?: --input-json '\{\}')?"/u,
        '"routecodex hook run reasoningStop --sessionId session-1"',
      );
    },
    diagnostic: /reasoningStop CLI must not carry sessionId/u,
  },
  {
    name: 'no-op CLI revives empty input-json envelope',
    path: 'v3/crates/routecodex-v3-runtime/src/hub_v1/servertool_hooks.rs',
    mutate(source) {
      return source.replace(
        /"routecodex hook run reasoningStop(?: --input-json '\{\}')?"/u,
        '"routecodex hook run reasoningStop --input-json \'{\\"repeatCount\\":1}\'"',
      );
    },
    diagnostic: /reasoningStop CLI must be no-input and must not include --input-json/u,
  },
  {
    name: 'no-op CLI parses stdout state',
    path: 'v3/crates/routecodex-v3-runtime/src/hub_v1/servertool_hooks.rs',
    marker: 'fn build_stopless_cli_command() -> String {\n',
    replacement: 'fn build_stopless_cli_command() -> String {\n    let _parsed_stdout = serde_json::from_str::<Value>("{}");\n',
    diagnostic: /reasoningStop CLI must not parse stdout\/state JSON/u,
  },
  {
    name: 'request-side continuation guideline collapses to terse continue',
    path: 'v3/crates/routecodex-v3-runtime/src/hub_v1/servertool_hooks.rs',
    marker: '请基于已经恢复的完整上下文继续推理：',
    replacement: '继续。',
    diagnostic: /full transparent stopless continuation guideline missing 基于已经恢复的完整上下文/u,
  },
  {
    name: 'provider-visible guideline leaks RouteCodex bridge label',
    path: 'v3/crates/routecodex-v3-runtime/src/hub_v1/servertool_hooks.rs',
    marker: '继续当前目标。\n\n请基于已经恢复的完整上下文继续推理：',
    replacement: '继续当前目标。\nRouteCodex stopless continuation。\n\n请基于已经恢复的完整上下文继续推理：',
    diagnostic: /provider-visible stopless guideline must not contain RouteCodex stopless continuation/u,
  },
  {
    name: 'provider-visible guideline leaks no-op CLI mechanism',
    path: 'v3/crates/routecodex-v3-runtime/src/hub_v1/servertool_hooks.rs',
    marker: '继续当前目标。\n\n请基于已经恢复的完整上下文继续推理：',
    replacement: '继续当前目标。\n上一轮 reasoningStop CLI no-op 只表示客户端工具轮已经闭合。\n\n请基于已经恢复的完整上下文继续推理：',
    diagnostic: /provider-visible stopless guideline must not contain 上一轮 reasoningStop CLI|provider-visible stopless guideline must not contain no-op/u,
  },
  {
    name: 'provider-visible guideline leaks internal counter budget',
    path: 'v3/crates/routecodex-v3-runtime/src/hub_v1/servertool_hooks.rs',
    marker: '请更严格地推进到工具动作、明确完成证据、或明确阻塞证据之一，避免空泛总结。',
    replacement: '这是连续第 2 次需要继续推进（最多 3 次）。请更严格地推进到工具动作、明确完成证据、或明确阻塞证据之一，避免空泛总结。',
    diagnostic: /provider-visible stopless guideline must not contain 这是连续第|provider-visible stopless guideline must not contain 最多/u,
  },
  {
    name: 'manifest revives no-op lifecycle explanation',
    path: 'docs/architecture/manifests/v3.servertool_hook_skeleton_lifecycle.mainline.yml',
    marker: '  model_visible_bridge_transparency: required\n  must_include:\n',
    replacement: '  must_explain:\n    - no-op only closes the client tool round\n  must_include:\n',
    diagnostic: /model_visible_bridge_transparency.*must equal "required"|must_explain must not revive no-op lifecycle explanations/u,
  },
  {
    name: 'manifest stops forbidding no-op in provider-visible prompt',
    path: 'docs/architecture/manifests/v3.servertool_hook_skeleton_lifecycle.mainline.yml',
    marker: '    - no-op\n',
    replacement: '',
    diagnostic: /guidance_rewrite\.forbidden_model_visible must include no-op/u,
  },
  {
    name: 'snapshot restores StoplessCenter truth',
    path: 'v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs',
    marker: 'use serde_json::{json, Map, Value};\n',
    replacement: 'use serde_json::{json, Map, Value};\nfn restore_stopless_from_snapshot_runtime_json() {}\n',
    diagnostic: /snapshot\/debug artifacts must not restore StoplessCenter control truth/u,
  },
  {
    name: 'snapshot contract loses observability-only lock',
    path: 'docs/architecture/snapshot-stage-contract.md',
    marker: 'diagnostic correlation only',
    replacement: 'diagnostic lookup',
    diagnostic: /snapshot-stage-contract\.md missing diagnostic correlation only/u,
  },
];

const resourceId = 'v3.metadata.runtime_control_stopless';
const failures = [];

for (const fixture of cases) {
  const root = mkdtempSync(join(tmpdir(), 'v3-stopless-resource-control-red-'));
  try {
    for (const rel of copied) cpSync(resolve(repo, rel), resolve(root, rel), { recursive: true });
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
    writeFileSync(target, mutated);
    const result = spawnSync(process.execPath, [verifier], { cwd: root, encoding: 'utf8' });
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    if (result.status === 0) failures.push(`${fixture.name}: verifier unexpectedly passed`);
    else if (!fixture.diagnostic.test(output)) {
      failures.push(`${fixture.name}: wrong diagnostic: ${output.slice(-1200)}`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (failures.length > 0) {
  console.error('[test:v3-stopless-resource-control-red-fixtures] failed');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`[test:v3-stopless-resource-control-red-fixtures] ok (${cases.length} forbidden mutations rejected)`);
