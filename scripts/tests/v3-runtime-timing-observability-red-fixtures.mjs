#!/usr/bin/env node

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import process from "node:process";
import YAML from "yaml";

const repo = process.cwd();
const verifier = resolve(
  repo,
  "scripts/architecture/verify-v3-runtime-timing-observability.mjs",
);
const manifestSyncVerifier = resolve(
  repo,
  "scripts/architecture/verify-architecture-mainline-manifest-sync.mjs",
);
const copied = [
  "package.json",
  ".github/workflows/test.yml",
  "v3/crates/routecodex-v3-runtime/src/runtime_timing.rs",
  "v3/crates/routecodex-v3-runtime/src/lib.rs",
  "v3/crates/routecodex-v3-runtime/src/kernel.rs",
  "v3/crates/routecodex-v3-runtime/src/kernel/direct_sse_provider_outcome.rs",
  "v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs",
  "v3/crates/routecodex-v3-server/src/lib.rs",
  "docs/architecture/function-map.yml",
  "docs/architecture/mainline-call-map.yml",
  "docs/architecture/resource-operation-map.yml",
  "docs/architecture/verification-map.yml",
  "docs/architecture/v3-function-map.yml",
  "docs/architecture/v3-mainline-call-map.yml",
  "docs/architecture/v3-resource-operation-map.yml",
  "docs/architecture/v3-verification-map.yml",
  "docs/architecture/manifests",
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
    name: "Server restores successful unreported timing",
    path: "v3/crates/routecodex-v3-server/src/lib.rs",
    mutate: (source) =>
      source.replace(
        "fn format_v3_console_runtime_timing(",
        'const FORBIDDEN_TIMING: &str = "time_i=unreported time_e=unreported";\n\nfn format_v3_console_runtime_timing(',
      ),
    diagnostic: /must not emit unreported Runtime timing/u,
  },
  {
    name: "Server becomes a second timing writer",
    path: "v3/crates/routecodex-v3-server/src/lib.rs",
    mutate: (source) =>
      source.replace(
        "fn format_v3_console_runtime_timing(",
        "fn forbidden_server_timing_writer() { let _ = V3RuntimeTimingSummary { runtime_total: std::time::Duration::ZERO, external: std::time::Duration::ZERO, internal: std::time::Duration::ZERO }; }\n\nfn format_v3_console_runtime_timing(",
      ),
    diagnostic: /must not construct Runtime timing summaries/u,
  },
  {
    name: "Runtime observability drops typed timing",
    path: "v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs",
    mutate: (source) =>
      source.replace(
        "    pub timing: Option<V3RuntimeTimingSummary>,",
        "    pub timing_removed: Option<V3RuntimeTimingSummary>,",
      ),
    diagnostic: /V3RuntimeObservability must carry/u,
  },
  {
    name: "human response restores unreported status",
    path: "v3/crates/routecodex-v3-server/src/lib.rs",
    mutate: (source) =>
      source.replace(
        '.ok_or_else(|| {\n            "successful V3 Runtime observability is missing response_status".to_string()\n        })?;',
        '.unwrap_or("unreported");',
      ),
    diagnostic: /must reject missing response_status|must not contain unreported/u,
  },
  {
    name: "human response reuses diagnostic usage placeholder",
    path: "v3/crates/routecodex-v3-server/src/lib.rs",
    mutate: (source) =>
      source.replace(
        "let human_usage = format_v3_console_human_usage_summary(observability.usage.as_ref());",
        "let human_usage = Some(format_v3_console_usage_summary(observability.usage.as_ref()));",
      ),
    diagnostic: /omit unavailable usage/u,
  },
  {
    name: "Direct SSE decoder stops owning clean EOF timing",
    path: "v3/crates/routecodex-v3-runtime/src/kernel.rs",
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
    path: "v3/crates/routecodex-v3-runtime/src/kernel/direct_sse_provider_outcome.rs",
    mutate: (source) =>
      source.replace(
        '.ok_or_else(|| {\n                    build_v3_error_01_source_raised(\n                        V3ErrorSourceKind::ProviderFailure,\n                        "V3ProviderResp14Raw",\n                        "provider_response_sse_event_invalid",\n                        format!("{event_type} requires non-empty response.error.code"),\n                    )\n                })?;',
        '.unwrap_or("provider_response_failed");',
      ),
    diagnostic: /must not invent missing error code or message/u,
  },
  {
    name: "Direct SSE provider failure restores alternate top-level envelope",
    path: "v3/crates/routecodex-v3-runtime/src/kernel/direct_sse_provider_outcome.rs",
    mutate: (source) =>
      source.replace(
        'event\n                .get("response")\n                .and_then(Value::as_object)',
        'event\n                .get("response")\n                .unwrap_or(&event)\n                .as_object()',
      ),
    diagnostic: /must (?:require the canonical response object|reject a missing response object)/u,
  },
  {
    name: "Direct SSE outcome stops rejecting event and JSON type mismatch",
    path: "v3/crates/routecodex-v3-runtime/src/kernel/direct_sse_provider_outcome.rs",
    mutate: (source) =>
      source.replace(
        "if sse_event_type != json_event_type {",
        "if false {",
      ),
    diagnostic: /must reject mismatched SSE event and JSON types/u,
  },
  {
    name: "Direct SSE mismatch regression is deleted",
    path: "v3/crates/routecodex-v3-runtime/src/kernel.rs",
    mutate: (source) =>
      source.replace(
        "async fn direct_sse_event_name_json_type_mismatch_is_protocol_invalid()",
        "async fn direct_sse_event_name_json_type_mismatch_removed()",
      ),
    diagnostic: /mismatch regression must prove explicit failure/u,
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
    diagnostic: /must bind all Runtime timing edges 01 through 12/u,
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
    diagnostic: /must bind all Runtime timing edges 01 through 12/u,
  },
  {
    name: "manifest sync allows global and V3 timing callable drift",
    path: "docs/architecture/v3-mainline-call-map.yml",
    verifier: manifestSyncVerifier,
    mutate: (source) => {
      const chainStart = source.indexOf(
        "chain_id: v3.runtime_timing_observability.mainline",
      );
      const head = source.slice(0, chainStart);
      const chain = source.slice(chainStart).replace(
        "caller_symbol: execute_v3_responses_relay_runtime_inner",
        "caller_symbol: execute_v3_responses_relay_runtime_inner_drifted",
      );
      return head + chain;
    },
    diagnostic: /global and V3 mainline callable bindings differ/u,
  },
  {
    name: "manifest sync allows global and V3 timing resource drift",
    path: "docs/architecture/v3-mainline-call-map.yml",
    verifier: manifestSyncVerifier,
    mutate: (source) =>
      mutateTimingChain(source, (chain) => {
        chain.edges[0].resource_flow.side_channel_writes = [
          "v3.runtime.responses_observability",
        ];
      }),
    diagnostic: /global and V3 mainline resource flows differ/u,
  },
  {
    name: "manifest sync allows lifecycle timing resource drift",
    path: "docs/architecture/manifests/v3.runtime_timing_observability.mainline.yml",
    verifier: manifestSyncVerifier,
    mutate: (source) => {
      const edgeStart = source.indexOf("  - step_id: v3-runtime-timing-12");
      const head = source.slice(0, edgeStart);
      const edge = source.slice(edgeStart).replace(
        "      - v3.runtime.responses_observability",
        "      - v3.runtime.responses_timing_observability",
      );
      return head + edge;
    },
    diagnostic: /mainline resource flows differ from lifecycle manifest/u,
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
        "      - v3/crates/routecodex-v3-runtime/src/kernel/direct_sse_provider_outcome.rs\n",
        "",
      ),
    diagnostic: /global function map must register the Direct SSE outcome owner path/u,
  },
  {
    name: "V3 timing owner drops Direct SSE outcome path",
    path: "docs/architecture/v3-function-map.yml",
    mutate: (source) =>
      source.replace(
        "      - v3/crates/routecodex-v3-runtime/src/kernel/direct_sse_provider_outcome.rs\n",
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
    path: "v3/crates/routecodex-v3-server/src/lib.rs",
    mutate: (source) =>
      source.replace(
        '        assert!(!log.contains("event=completed"), "{log}");\n        assert!(!log.contains("event=failed"), "{log}");\n',
        '        assert!(!log.contains("event=failed"), "{log}");\n',
      ),
    diagnostic: /pre-EOF terminal-drop test must reject fabricated completion/u,
  },
  {
    name: "Direct SSE pre-EOF drop loses the missing-timing guard",
    path: "v3/crates/routecodex-v3-server/src/lib.rs",
    mutate: (source) =>
      source.replace(
        "                if self.observability.timing.is_none() {\n                    return;\n                }\n                self.emit_direct_sse_complete_console_lines();",
        "                self.emit_direct_sse_complete_console_lines();",
      ),
    diagnostic: /pre-EOF drop must suppress terminal projection/u,
  },
  {
    name: "Direct SSE clean EOF suppresses missing timing",
    path: "v3/crates/routecodex-v3-server/src/lib.rs",
    mutate: (source) =>
      source.replace(
        "    fn emit_direct_sse_complete_console_lines(self) {\n",
        "    fn emit_direct_sse_complete_console_lines(self) {\n        if self.observability.timing.is_none() {\n            return;\n        }\n",
      ),
    diagnostic: /clean-EOF completion must not suppress/u,
  },
  {
    name: "Direct SSE clean EOF test stops requiring timing contract failure",
    path: "v3/crates/routecodex-v3-server/src/lib.rs",
    mutate: (source) =>
      source.replace(
        '        assert!(\n            log.contains("subcode=runtime_observability_contract"),\n            "{log}"\n        );\n',
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
    name: "CI skips Runtime timing red fixtures",
    path: ".github/workflows/test.yml",
    mutate: (source) =>
      source.replaceAll(
        "        run: npm run test:v3-runtime-timing-observability-red-fixtures\n",
        "",
      ),
    diagnostic: /CI must run the Runtime timing red fixtures/u,
  },
];

const failures = [];
for (const testCase of cases) {
  const root = mkdtempSync(join(tmpdir(), "v3-runtime-timing-red-"));
  try {
    for (const relative of copied) {
      cpSync(resolve(repo, relative), resolve(root, relative), { recursive: true });
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
