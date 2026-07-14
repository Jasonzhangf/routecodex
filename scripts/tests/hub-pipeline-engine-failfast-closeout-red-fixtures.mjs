#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  collectHubPipelineEngineFailfastViolations
} from '../architecture/verify-hub-pipeline-engine-failfast-closeout.mjs';

const ENGINE = 'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_lib/engine.rs';
const NAPI_BINDINGS = 'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_blocks/napi_bindings.rs';
const ROUTER_METADATA = 'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_blocks/router_metadata_input.rs';

const fixtures = [
  ['request-id-fixed-fallback', ENGINE, 'let request_id = "hub_pipeline_rust_lib_request";'],
  ['client-protocol-endpoint-fallback-engine', ENGINE, 'resolve_hub_client_protocol(entry_endpoint);'],
  ['client-protocol-endpoint-fallback-napi', NAPI_BINDINGS, 'value.unwrap_or_else(|| resolve_hub_client_protocol(&entry_endpoint));'],
  ['provider-protocol-flat-metadata-engine', ENGINE, 'normalized_metadata.get("providerProtocol");'],
  ['provider-protocol-flat-metadata-napi', NAPI_BINDINGS, 'let flat_metadata_provider_protocol = None;'],
  ['excluded-provider-flat-mirror-engine', ENGINE, 'metadata\n  .get("excludedProviderKeys");'],
  ['excluded-provider-flat-mirror-napi', NAPI_BINDINGS, 'row.get("excludedProviderKeys");'],
  ['excluded-provider-flat-mirror-router', ROUTER_METADATA, 'metadata_obj\n  .get("excludedProviderKeys");'],
  ['stopless-multi-source-activation', ENGINE, 'has_stop_message_response_runtime_enabled_value(metadata);'],
  ['stopless-flat-activation-input', ENGINE, 'fn is_stopless_runtime_active(metadata: &Value, snapshot: &Value) -> bool { false }'],
  ['terminal-chat-response-runtime-fallback', ENGINE, 'runtime_output.get("chatResponse");'],
  ['terminal-chat-response-payload-fallback', ENGINE, 'value.unwrap_or_else(|| chatprocess_payload.clone());'],
  ['state-clock-zero-fallback', ENGINE, 'duration_since(epoch).unwrap_or(0);']
];

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'routecodex-engine-failfast-'));

try {
  for (const relativePath of [ENGINE, NAPI_BINDINGS, ROUTER_METADATA]) {
    const absolutePath = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, '// clean fixture\n');
  }

  for (const [expectedId, relativePath, source] of fixtures) {
    const absolutePath = path.join(root, relativePath);
    fs.writeFileSync(absolutePath, `${source}\n`);
    const violations = collectHubPipelineEngineFailfastViolations(root);
    assert(
      violations.some((violation) => violation.id === expectedId),
      `fixture ${expectedId} did not trigger its verifier rule`
    );
    fs.writeFileSync(absolutePath, '// clean fixture\n');
  }

  const cleanViolations = collectHubPipelineEngineFailfastViolations(root);
  assert.deepEqual(cleanViolations, [], 'clean fixture unexpectedly violated the closeout gate');
  console.log(`Hub Pipeline engine fail-fast red fixtures passed: ${fixtures.length}/${fixtures.length}`);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
