#!/usr/bin/env node

// feature_id: hub.pipeline_engine_failfast_closeout

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * @typedef {{
 *   id: string,
 *   file: string,
 *   detail: string
 * }} HubPipelineEngineFailfastViolation
 */

const ENGINE = 'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_lib/engine.rs';
const NAPI_BINDINGS = 'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_blocks/napi_bindings.rs';
const ROUTER_METADATA = 'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_blocks/router_metadata_input.rs';

const rules = [
  {
    id: 'request-id-fixed-fallback',
    file: ENGINE,
    pattern: /hub_pipeline_rust_lib_request/,
    detail: 'blank requestId must fail fast instead of using a fixed synthetic id'
  },
  {
    id: 'client-protocol-endpoint-fallback-engine',
    file: ENGINE,
    pattern: /resolve_hub_client_protocol\s*\(\s*entry_endpoint\s*\)/,
    detail: 'Hub engine must consume typed client protocol truth instead of deriving it from endpoint'
  },
  {
    id: 'client-protocol-endpoint-fallback-napi',
    file: NAPI_BINDINGS,
    pattern: /unwrap_or_else\s*\(\s*\|\|\s*resolve_hub_client_protocol\s*\(/,
    detail: 'materialized NAPI input must not derive protocol from endpoint'
  },
  {
    id: 'provider-protocol-flat-metadata-engine',
    file: ENGINE,
    pattern: /normalized_metadata\.get\s*\(\s*"providerProtocol"\s*\)/,
    detail: 'providerProtocol must come from the typed/runtime-control owner, not flat metadata'
  },
  {
    id: 'provider-protocol-flat-metadata-napi',
    file: NAPI_BINDINGS,
    pattern: /flat_metadata_provider_protocol/,
    detail: 'NAPI materialization must not preserve a flat metadata providerProtocol source'
  },
  {
    id: 'excluded-provider-flat-mirror-engine',
    file: ENGINE,
    pattern: /metadata\s*\n?\s*\.get\s*\(\s*"excludedProviderKeys"\s*\)/,
    detail: 'engine must consume one route/error exclusion carrier instead of flat metadata'
  },
  {
    id: 'excluded-provider-flat-mirror-napi',
    file: NAPI_BINDINGS,
    pattern: /row\.get\s*\(\s*"excludedProviderKeys"\s*\)/,
    detail: 'NAPI snapshot materialization must not mirror flat exclusions into MetadataCenter'
  },
  {
    id: 'excluded-provider-flat-mirror-router',
    file: ROUTER_METADATA,
    pattern: /metadata_obj\s*\n?\s*\.get\s*\(\s*"excludedProviderKeys"\s*\)/,
    detail: 'router metadata parser must consume the canonical exclusion carrier only'
  },
  {
    id: 'stopless-multi-source-activation',
    file: ENGINE,
    pattern: /has_stop_message_response_runtime_enabled_value/,
    detail: 'stopless/stop-message activation must not recursively inspect flat metadata or nested mirrors'
  },
  {
    id: 'stopless-flat-activation-input',
    file: ENGINE,
    pattern: /fn\s+is_stopless_runtime_active\s*\(\s*metadata:\s*&Value\s*,/,
    detail: 'stopless activation must read the MetadataCenter family only'
  },
  {
    id: 'terminal-chat-response-runtime-fallback',
    file: ENGINE,
    pattern: /runtime_output\.get\s*\(\s*"chatResponse"\s*\)/,
    detail: 'required terminal chatResponse must not fall back to runtime output'
  },
  {
    id: 'terminal-chat-response-payload-fallback',
    file: ENGINE,
    pattern: /unwrap_or_else\s*\(\s*\|\|\s*chatprocess_payload\.clone\s*\(\s*\)\s*\)/,
    detail: 'required terminal chatResponse must not fall back to the original payload'
  },
  {
    id: 'state-clock-zero-fallback',
    file: ENGINE,
    pattern: /\.unwrap_or\s*\(\s*0\s*\)/,
    detail: 'state clock failure must be explicit and must not write timestamp zero'
  }
];

function readSource(root, relativePath) {
  const absolutePath = path.join(root, relativePath);
  if (!fs.existsSync(absolutePath)) {
    throw new Error(`required source missing: ${relativePath}`);
  }
  return fs.readFileSync(absolutePath, 'utf8');
}

export function collectHubPipelineEngineFailfastViolations(root) {
  const cache = new Map();
  return rules.flatMap((rule) => {
    const source = cache.get(rule.file) ?? readSource(root, rule.file);
    cache.set(rule.file, source);
    if (!rule.pattern.test(source)) {
      return [];
    }
    return [{
      id: rule.id,
      file: rule.file,
      detail: rule.detail
    }];
  });
}

function resolveRoot(argv) {
  const rootIndex = argv.indexOf('--root');
  if (rootIndex === -1) {
    return process.cwd();
  }
  const value = argv[rootIndex + 1];
  if (!value) {
    throw new Error('--root requires a path');
  }
  return path.resolve(value);
}

function main() {
  const root = resolveRoot(process.argv.slice(2));
  const violations = collectHubPipelineEngineFailfastViolations(root);
  if (violations.length > 0) {
    console.error('Hub Pipeline engine fail-fast closeout violations:');
    for (const violation of violations) {
      console.error(`- [${violation.id}] ${violation.file}: ${violation.detail}`);
    }
    process.exitCode = 1;
    return;
  }
  console.log('Hub Pipeline engine fail-fast closeout verification passed.');
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  main();
}
