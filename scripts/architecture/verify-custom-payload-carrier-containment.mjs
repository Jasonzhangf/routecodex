import fs from 'node:fs';
import path from 'node:path';

const repoRoot = process.cwd();

const scanRoots = [
  'src',
  'sharedmodule/llmswitch-core/src',
  'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src',
];

const skipDirNames = new Set([
  '.git',
  'coverage',
  'dist',
  'node_modules',
  'target',
]);

const allowedExtensions = new Set([
  '.js',
  '.mjs',
  '.rs',
  '.ts',
  '.tsx',
]);

const rules = [
  {
    id: 'routecodex_prefix',
    title: '__routecodex* runtime containment',
    regex: /__routecodex[A-Za-z0-9_]*/g,
    allowedFiles: new Set([
      'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/chat_node_result_semantics.rs',
      'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_blocks/router_metadata_input.rs',
      'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_contracts/mod.rs',
      'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_lib/engine.rs',
      'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_lib/tests.rs',
      'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_types/meta_error_carriers.rs',
      'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_resp_outbound_client_semantics_tests.rs',
      'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/server_contracts.rs',
      'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/engine/route.rs',
      'sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-execute-request-stage.ts',
      'src/modules/llmswitch/bridge/responses-response-bridge.ts',
      'src/providers/core/runtime/http-request-executor.ts',
      'src/providers/core/runtime/provider-request-header-orchestrator.ts',
      'src/providers/core/runtime/transport/oauth-header-preflight.ts',
      'src/providers/core/utils/provider-error-reporter.ts',
      'src/providers/core/utils/snapshot-writer-buffer.ts',
      'src/server/handlers/handler-response-common.ts',
      'src/server/handlers/handler-utils.ts',
      'src/server/runtime/http-server/daemon-admin-routes.ts',
      'src/server/runtime/http-server/executor-metadata.ts',
      'src/server/runtime/http-server/executor/provider-response-converter.ts',
      'src/server/runtime/http-server/executor/request-executor-attempt-state.ts',
      'src/server/runtime/http-server/executor/request-executor-response-inspect.ts',
      'src/server/runtime/http-server/executor/servertool-followup-dispatch.ts',
      'src/server/runtime/http-server/executor/servertool-followup-metadata.ts',
      'src/server/runtime/http-server/index.ts',
    ]),
  },
  {
    id: 'sse_prefix',
    title: '__sse_* runtime containment',
    regex: /__sse_[A-Za-z0-9_]*/g,
    allowedFiles: new Set(),
  },
  {
    id: 'response_metadata',
    title: 'response.metadata runtime containment',
    regex: /\bresponse\.metadata\b/g,
    allowedFiles: new Set([
      'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_contracts/mod.rs',
      'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/server_contracts.rs',
      'src/modules/llmswitch/bridge/responses-response-bridge.ts',
      'src/providers/core/hooks/debug-example-hooks.ts',
    ]),
  },
];

function walk(dir, files = []) {
  if (!fs.existsSync(dir)) {
    return files;
  }
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (skipDirNames.has(entry.name)) {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, files);
      continue;
    }
    if (entry.isFile() && allowedExtensions.has(path.extname(entry.name))) {
      files.push(full);
    }
  }
  return files;
}

const violations = [];
const seenByRule = new Map(rules.map((rule) => [rule.id, new Set()]));

for (const scanRoot of scanRoots) {
  for (const file of walk(path.join(repoRoot, scanRoot))) {
    const rel = path.relative(repoRoot, file);
    const text = fs.readFileSync(file, 'utf8');
    const lines = text.split(/\r?\n/);
    for (const rule of rules) {
      if (!rule.regex.test(text)) {
        rule.regex.lastIndex = 0;
        continue;
      }
      rule.regex.lastIndex = 0;
      seenByRule.get(rule.id)?.add(rel);
      if (rule.allowedFiles.has(rel)) {
        continue;
      }
      lines.forEach((line, index) => {
        const matches = [...line.matchAll(rule.regex)];
        if (matches.length === 0) {
          return;
        }
        violations.push({
          rule: rule.id,
          file: rel,
          line: index + 1,
          matches: matches.map((match) => match[0]),
        });
      });
    }
  }
}

if (violations.length > 0) {
  console.error('[verify:custom-payload-carrier-containment] found runtime carrier spread outside allowlist');
  for (const violation of violations) {
    console.error(`- ${violation.file}:${violation.line} [${violation.rule}] ${violation.matches.join(', ')}`);
  }
  process.exit(1);
}

console.log('[verify:custom-payload-carrier-containment] ok');
for (const rule of rules) {
  const files = [...(seenByRule.get(rule.id) ?? new Set())].sort();
  console.log(`- ${rule.id}: ${files.length} allowlisted runtime files`);
}
