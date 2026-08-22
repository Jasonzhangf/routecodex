#!/usr/bin/env node
import { readFileSync } from 'node:fs';

const kernelPath = 'v3/crates/routecodex-v3-runtime/src/kernel.rs';
const testPath = 'v3/crates/routecodex-v3-runtime/tests/responses_direct_remote_continuation_integration.rs';
const designPath = 'docs/goals/v3-responses-direct-remote-continuation-integration-test-design.md';
const kernel = readFileSync(kernelPath, 'utf8');
const tests = readFileSync(testPath, 'utf8');
const design = readFileSync(designPath, 'utf8');
const failures = [];

requireText(kernel, kernelPath, 'let continuation_disabled = crate::shared::v3_responses_continuation_disabled_for_server(');
requireText(kernel, kernelPath, '(Some(_), _, _) if continuation_disabled =>');
requireText(kernel, kernelPath, 'wrap_v3_direct_sse_remote_stream_for_outcome(');
requireText(kernel, kernelPath, 'if !continuation_disabled {');
requireText(kernel, kernelPath, 'commit_or_release_v3_direct_continuation(');
requireText(tests, testPath, 'continuation_disabled_keeps_repeated_sse_response_ids_out_of_remote_store');
requireText(tests, testPath, 'responses_continuation_disabled = true');
requireText(design, designPath, 'responses_continuation_disabled=true');

const disabledResp04Gates = kernel.match(
  /\(\s*continuation_disabled,\s*continuation_state,\s*continuation_scope\.as_ref\(\),\s*\)/g,
) ?? [];
if (disabledResp04Gates.length !== 1) {
  failures.push(`${kernelPath}: JSON Resp04 path must consume continuation_disabled exactly once; got ${disabledResp04Gates.length}`);
}

if (failures.length) {
  console.error('[verify:v3-responses-continuation-disabled] failed');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log('[verify:v3-responses-continuation-disabled] ok');

function requireText(text, owner, phrase) {
  if (!text.includes(phrase)) failures.push(`${owner}: missing ${phrase}`);
}
