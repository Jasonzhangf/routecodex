#!/usr/bin/env node

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import YAML from "yaml";

const v3Root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const admissionRoot = resolve(v3Root, "build-contracts", "architecture-admission", "repo");
const repo = process.cwd();
const verifier = resolve(
  repo,
  "scripts/architecture/verify-v3-runtime-timing-observability.mjs",
);
const copied = [
  "package.json",
  ".github/workflows/test.yml",
  "v3/crates/routecodex-v3-runtime/src/runtime_timing.rs",
  "v3/crates/routecodex-v3-runtime/src/lib.rs",
  "v3/crates/routecodex-v3-runtime/src/kernel.rs",
  "v3/crates/routecodex-v3-runtime/src/kernel/direct_state.rs",
  "v3/crates/routecodex-v3-runtime/src/kernel/direct_resp15_finalize.rs",
  "v3/crates/routecodex-v3-runtime/src/kernel/direct_runtime_helpers.rs",
  "v3/crates/routecodex-v3-runtime/src/kernel/direct_runtime_helpers_stream.rs",
  "v3/crates/routecodex-v3-runtime/src/kernel/tests.rs",
  "v3/crates/routecodex-v3-runtime/src/kernel/direct_sse_provider_outcome.rs",
  "v3/crates/routecodex-v3-runtime/src/hub_v1/provider_sse_json_codec.rs",
  "v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs",
  "v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime_inner.rs",
  "v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_types.rs",
  "v3/crates/routecodex-v3-runtime/tests/support/kernel_unit.rs",
  "v3/crates/routecodex-v3-server/src/lib.rs",
  "v3/crates/routecodex-v3-server/src/console/impl_bulk.rs",
  "v3/crates/routecodex-v3-server/src/responses_direct_server_outcome.rs",
  "v3/crates/routecodex-v3-server/src/tests/mod.rs",
  "docs/architecture/function-map.yml",
  "docs/architecture/mainline-call-map.yml",
  "docs/architecture/resource-operation-map.yml",
  "docs/architecture/verification-map.yml",
  "docs/architecture/v3-function-map.yml",
  "docs/architecture/v3-mainline-call-map.yml",
  "docs/architecture/v3-resource-operation-map.yml",
  "docs/architecture/v3-verification-map.yml",
  "docs/architecture/manifests",
  "docs/architecture/mainline-manifests",
  "docs/architecture/wiki/mainline-call-graph.md",
  "docs/architecture/wiki/response-mainline-call-graph.md",
  "docs/architecture/wiki/error-mainline-call-graph.md",
  "docs/architecture/wiki/internal-error-numbering-mainline-source.md",
  "docs/architecture/wiki/runtime-lifecycle-call-graph.md",
  "docs/architecture/wiki/stopless-session-mainline-source.md",
  "docs/architecture/wiki/metadata-center-mainline-source.md",
];

function mutateTimingChain(source, mutate) {
  const parsed = YAML.parse(source);
  const chain = (parsed.chains ?? []).find(
    (candidate) =>
      candidate?.chain_id === "v3.runtime_timing_observability.mainline",
  );
  if (!chain) {
    return source;
  }
  mutate(chain);
  return YAML.stringify(parsed, { lineWidth: 0 });
}

const cases = [
  {
    name: "Direct-to-Relay handoff drops the Runtime accumulator",
    path: "v3/crates/routecodex-v3-runtime/src/kernel/direct_state.rs",
    mutate: (source) =>
      source.replace(
        "    pub observability_accumulator: V3RuntimeObservabilityAccumulator,",
        "    pub observability_accumulator_removed: V3RuntimeObservabilityAccumulator,",
      ),
    diagnostic: /Both typed protocol handoff directions must carry/u,
  },
  {
    name: "Server restores successful unreported timing",
    path: "v3/crates/routecodex-v3-server/src/console/impl_bulk.rs",
    mutate: (source) =>
      source.replace(
        "fn format_v3_console_runtime_timing(",
        'const FORBIDDEN_TIMING: &str = "time_i=unreported time_e=unreported";\n\nfn format_v3_console_runtime_timing(',
      ),
    diagnostic: /must not emit unreported Runtime timing/u,
  },
  {
    name: "Server becomes a second timing writer",
    path: "v3/crates/routecodex-v3-server/src/console/impl_bulk.rs",
    mutate: (source) =>
      source.replace(
        "fn format_v3_console_runtime_timing(",
        "fn forbidden_server_timing_writer() { let _ = V3RuntimeTimingSummary { runtime_total: std::time::Duration::ZERO, external: std::time::Duration::ZERO, internal: std::time::Duration::ZERO }; }\n\nfn format_v3_console_runtime_timing(",
      ),
    diagnostic: /must not construct Runtime timing summaries/u,
  },
  {
    name: "Runtime observability drops typed timing",
    path: "v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_types.rs",
    mutate: (source) =>
      source.replace(
        "    pub timing: Option<V3RuntimeTimingSummary>,",
        "    pub timing_removed: Option<V3RuntimeTimingSummary>,",
      ),
    diagnostic: /V3RuntimeObservability must carry/u,
  },
  {
    name: "human response restores unreported status",
    path: "v3/crates/routecodex-v3-server/src/console/impl_bulk.rs",
    mutate: (source) =>
      source.replace(
        '.ok_or_else(|| {\n            "successful V3 Runtime observability is missing response_status".to_string()\n        })?;',
        '.unwrap_or("unreported");',
      ),
    diagnostic: /must reject missing response_status|must not contain unreported/u,
  },
  {
    name: "human response reuses diagnostic usage placeholder",
    path: "v3/crates/routecodex-v3-server/src/console/impl_bulk.rs",
    mutate: (source) =>
      source.replace(
        "let human_usage = format_v3_console_human_usage_summary(observability.usage.as_ref());",
        "let human_usage = Some(format_v3_console_usage_summary(observability.usage.as_ref()));",
      ),
    diagnostic: /omit unavailable usage/u,
  },
  {
    name: "Direct SSE decoder stops owning clean EOF timing",
    path: "v3/crates/routecodex-v3-runtime/src/kernel/direct_runtime_helpers_stream.rs",
    mutate: (source) =>
      source.replace(
        "                        Ok(()) => match state.runtime_timing.finish_external() {",
        "                        Ok(()) => match state.runtime_timing.close_external_removed() {",
      ),
    diagnostic: /external timing must close only after decoder clean EOF/u,
  },
  {
    name: "Direct SSE terminal timing owner is deleted",
    path: "v3/crates/routecodex-v3-runtime/src/kernel/direct_sse_provider_outcome.rs",
    mutate: (source) =>
      source.replace(
        "state.runtime_timing.finish_runtime()",
        "state.runtime_timing.finish_runtime_removed()",
      ),
    diagnostic: /must call finish_runtime exactly once/u,
  },
  {
    name: "Direct SSE terminal timing closes before terminal validation",
    path: "v3/crates/routecodex-v3-runtime/src/kernel/direct_sse_provider_outcome.rs",
    mutate: (source) =>
      source
        .replace(
          "                    let timing = match state.runtime_timing.finish_runtime() {",
          "                    let timing = match state.runtime_timing.finish_runtime_removed() {",
        )
        .replace(
          "                    if !state.provider_outcome.terminal {",
          "                    let _premature_timing = state.runtime_timing.finish_runtime();\n                    if !state.provider_outcome.terminal {",
        ),
    diagnostic: /must follow decoder clean EOF, terminal validation, and provider success/u,
  },
  {
    name: "Direct SSE terminal timing gains a second writer",
    path: "v3/crates/routecodex-v3-runtime/src/kernel/direct_sse_provider_outcome.rs",
    mutate: (source) =>
      source.replace(
        "                    let timing = match state.runtime_timing.finish_runtime() {",
        "                    let _duplicate_timing = state.runtime_timing.finish_runtime();\n                    let timing = match state.runtime_timing.finish_runtime() {",
      ),
    diagnostic: /must call finish_runtime exactly once/u,
  },
  {
    name: "Direct SSE provider failure restores invented error fields",
    path: "v3/crates/routecodex-v3-runtime/src/hub_v1/provider_sse_json_codec.rs",
    mutate: (source) =>
      source.replace(
        '.ok_or_else(|| format!("{event_type} requires a non-empty error code"))?;',
        '.unwrap_or("provider_response_failed");',
      ),
    diagnostic: /must not invent missing error code or message/u,
  },
  {
    name: "Direct SSE provider failure restores alternate top-level envelope",
    path: "v3/crates/routecodex-v3-runtime/src/hub_v1/provider_sse_json_codec.rs",
    mutate: (source) =>
      source.replace(
        '.pointer("/response/error")',
        '.pointer("/missing/error")',
      ),
    diagnostic: /must (?:require the canonical response object|reject a missing response object)/u,
  },
  {
    name: "Direct SSE outcome restores event-name authority",
    path: "v3/crates/routecodex-v3-runtime/src/kernel/direct_sse_provider_outcome.rs",
    mutate: (source) =>
      source.replace(
        "let data = collect_v3_provider_sse_json_data(fields);",
        "let data = collect_v3_provider_sse_json_data(fields);\n        let sse_event_type = fields.len();",
      ),
    diagnostic: /must not use opaque SSE event metadata as semantic source/u,
  },
  {
    name: "Direct SSE mismatch regression is deleted",
    path: "v3/crates/routecodex-v3-runtime/tests/support/kernel_unit.rs",
    mutate: (source) =>
      source.replace(
        "async fn red_sse_semantics_must_use_json_type_not_event_name()",
        "async fn red_sse_semantics_must_use_json_type_removed()",
      ),
    diagnostic: /mismatch regression must prove JSON failure authority/u,
  },
  {
    name: "V3 timing mainline drops Relay and Server edges",
    path: "docs/architecture/v3-mainline-call-map.yml",
    mutate: (source) =>
      mutateTimingChain(source, (chain) => {
        chain.edges = chain.edges.filter(
          (edge) => edge?.step_id !== "v3-runtime-timing-01",
        );
      }),
    diagnostic: /must bind all Runtime timing edges 01 through 14/u,
  },
  {
    name: "Direct SSE timing publication edge is deleted",
    path: "docs/architecture/v3-mainline-call-map.yml",
    mutate: (source) =>
      mutateTimingChain(source, (chain) => {
        chain.edges = chain.edges.filter(
          (edge) => edge?.step_id !== "v3-runtime-timing-12",
        );
      }),
    diagnostic: /must bind all Runtime timing edges 01 through 14/u,
  },
  {
    name: "Direct SSE timing publication restores timing-state write",
    path: "docs/architecture/v3-mainline-call-map.yml",
    mutate: (source) =>
      mutateTimingChain(source, (chain) => {
        const edge = chain.edges.find(
          (candidate) => candidate?.step_id === "v3-runtime-timing-12",
        );
        edge.resource_flow.produces = [
          "v3.runtime.responses_timing_observability",
        ];
        edge.resource_flow.side_channel_writes = [
          "v3.runtime.responses_timing_observability",
        ];
      }),
    diagnostic: /record_timing edges must consume Runtime timing and write Runtime stream observability/u,
  },
  {
    name: "global timing owner drops Direct SSE outcome path",
    path: "docs/architecture/function-map.yml",
    mutate: (source) =>
      source.replace(
        "  - v3/crates/routecodex-v3-runtime/src/kernel/direct_sse_provider_outcome.rs\n",
        "",
      ),
    diagnostic: /global function map must register the Direct SSE outcome owner path/u,
  },
  {
    name: "V3 timing owner drops Direct SSE outcome path",
    path: "docs/architecture/v3-function-map.yml",
    mutate: (source) =>
      source.replace(
        "  - v3/crates/routecodex-v3-runtime/src/kernel/direct_sse_provider_outcome.rs\n",
        "",
      ),
    diagnostic: /V3 function map must register the Direct SSE outcome owner path/u,
  },
  {
    name: "timing stream projection restores a fake merge-to-emitter edge",
    path: "docs/architecture/mainline-call-map.yml",
    mutate: (source) =>
      source
        .replace(
          "caller_symbol: complete_relay_sse",
          "caller_symbol: merge_v3_runtime_stream_observation",
        )
        .replace(
          "callee_symbol: merge_v3_runtime_stream_observation",
          "callee_symbol: emit_v3_request_complete_console_line",
        ),
    diagnostic: /must bind the real finalizer-to-stream-observation merge call/u,
  },
  {
    name: "Direct SSE closeout fabricates completion before Runtime EOF",
    path: "v3/crates/routecodex-v3-server/src/tests/mod.rs",
    mutate: (source) =>
      source.replace(
        '    assert!(!log.contains("event=completed"), "{log}");\n    assert!(!log.contains("event=failed"), "{log}");\n',
        '    assert!(!log.contains("event=failed"), "{log}");\n',
      ),
    diagnostic: /pre-EOF terminal-drop test must reject fabricated completion/u,
  },
  {
    name: "Direct SSE pre-EOF drop loses the missing-timing guard",
    path: "v3/crates/routecodex-v3-server/src/console/impl_bulk.rs",
    mutate: (source) =>
      source.replace(
        "                if self.observability.timing.is_none() {\n                    return;\n                }\n                self.emit_direct_sse_complete_console_lines();",
        "                self.emit_direct_sse_complete_console_lines();",
      ),
    diagnostic: /pre-EOF drop must suppress terminal projection/u,
  },
  {
    name: "Direct SSE clean EOF suppresses missing timing",
    path: "v3/crates/routecodex-v3-server/src/console/impl_bulk.rs",
    mutate: (source) =>
      source.replace(
        "    pub(crate) fn emit_direct_sse_complete_console_lines(self) {\n",
        "    pub(crate) fn emit_direct_sse_complete_console_lines(self) {\n        if self.observability.timing.is_none() {\n            return;\n        }\n",
      ),
    diagnostic: /clean-EOF completion must not suppress/u,
  },
  {
    name: "Direct SSE clean EOF test stops requiring timing contract failure",
    path: "v3/crates/routecodex-v3-server/src/tests/mod.rs",
    mutate: (source) =>
      source.replace(
        '    assert!(\n        log.contains("subcode=runtime_observability_contract"),\n        "{log}"\n    );\n',
        "",
      ),
    diagnostic: /clean-EOF missing-timing test must require the Runtime observability contract code/u,
  },
  {
    name: "build skips Runtime timing verifier",
    path: "package.json",
    mutate: (source) => {
      const parsed = JSON.parse(source);
      parsed.scripts["build:v3-cli"] = parsed.scripts["build:v3-cli"].replace(
        "npm run verify:v3-runtime-timing-observability && ",
        "",
      );
      return `${JSON.stringify(parsed, null, 2)}\n`;
    },
    diagnostic: /build:v3-cli must run verify:v3-runtime-timing-observability/u,
  },
  {
    name: "CI skips canonical V3 verification",
    path: ".github/workflows/test.yml",
    mutate: (source) =>
      source.replaceAll("        run: npm --prefix v3 run verify:ci\n", ""),
    diagnostic: /CI must dispatch the canonical V3 verification stack/u,
  },
];

const failures = [];
for (const testCase of cases) {
  const root = mkdtempSync(join(tmpdir(), "v3-runtime-timing-red-"));
  try {
    for (const relative of copied) {
      const source = relative === "package.json"
        ? resolve(v3Root, relative)
        : relative.startsWith("v3/")
          ? resolve(v3Root, relative.slice("v3/".length))
          : resolve(admissionRoot, relative);
      cpSync(source, resolve(root, relative), { recursive: true });
    }
    const target = resolve(root, testCase.path);
    const original = readFileSync(target, "utf8");
    const mutated = testCase.mutate(original);
    if (mutated === original) {
      failures.push(`${testCase.name}: mutation did not change ${testCase.path}`);
      continue;
    }
    writeFileSync(target, mutated);
    const result = spawnSync(process.execPath, [testCase.verifier ?? verifier], {
      cwd: root,
      env: { ...process.env, ROUTECODEX_V3_SOURCE_ROOT: root },
      encoding: "utf8",
    });
    const output = `${result.stdout || ""}\n${result.stderr || ""}`;
    if (result.status === 0) {
      failures.push(`${testCase.name}: verifier unexpectedly passed`);
    } else if (!testCase.diagnostic.test(output)) {
      failures.push(
        `${testCase.name}: wrong diagnostic: ${output.slice(-1200)}`,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (failures.length > 0) {
  console.error("[test:v3-runtime-timing-observability-red-fixtures] FAIL");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log(
  `[test:v3-runtime-timing-observability-red-fixtures] PASS (${cases.length} forbidden mutations rejected)`,
);
