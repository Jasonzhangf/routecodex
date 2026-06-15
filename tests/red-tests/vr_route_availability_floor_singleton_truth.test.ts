/**
 * VR route availability floor singleton truth red test.
 * Locks:
 * - singleton/default hold decision must live in Rust VR owner
 * - TS executor shell may only delegate to native helper
 * - route-order tests must keep `search -> tools -> default` in Rust owner
 */

import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();

function readSrc(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

const RUST_SELECTION =
  'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/engine/selection.rs';
const RUST_ROUTING_CONFIG =
  'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/routing/config.rs';
const RUST_LIB =
  'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/lib.rs';
const RUST_PRIMARY_EXHAUSTED_BLOCKS =
  'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/primary_exhausted_to_default_pool_blocks.rs';
const REQUIRED_EXPORTS =
  'sharedmodule/llmswitch-core/src/native/router-hotpath/native-router-hotpath-required-exports.ts';
const NATIVE_EXPORTS = 'src/modules/llmswitch/bridge/native-exports.ts';
const EXECUTOR_CORE_UTILS =
  'src/server/runtime/http-server/executor/request-executor-core-utils.ts';

describe('VR route availability floor singleton truth', () => {
  it('Rust selection owns singleton route-pool exhaustion decision', () => {
    const src = readSrc(RUST_SELECTION);
    expect(src).toMatch(/pub\(crate\)\s+fn\s+evaluate_singleton_route_pool_exhaustion/);
    expect(src).toMatch(/ROUTE_POOL_COOLDOWN_WAIT_MAX_MS/);
    expect(src).toMatch(/candidate_provider_count == Some\(1\)/);
  });

  it('native export surface exposes singleton route-pool exhaustion decision', () => {
    expect(readSrc(RUST_LIB)).toMatch(/evaluate_singleton_route_pool_exhaustion_json/);
    expect(readSrc(REQUIRED_EXPORTS)).toMatch(/evaluateSingletonRoutePoolExhaustionJson/);
    expect(readSrc(NATIVE_EXPORTS)).toMatch(/evaluateSingletonRoutePoolExhaustionNative/);
  });

  it('TS executor core utils no longer implement singleton hold semantics locally', () => {
    const src = readSrc(EXECUTOR_CORE_UTILS);
    expect(src).toMatch(/evaluateSingletonRoutePoolExhaustionNative/);
    expect(src).not.toMatch(/POOL_COOLDOWN_WAIT_MAX_MS/);
    expect(src).not.toMatch(/function\s+coercePositiveMs/);
    expect(src).not.toMatch(/function\s+resolvePoolCooldownCandidateProviderCount/);
    expect(src).not.toMatch(/candidateProviderCount === 1/);
    expect(src).not.toMatch(/recoverableCooldownHints/);
  });

  it('Rust primary_exhausted_to_default_pool contract is reachable through the native export', () => {
    expect(readSrc(RUST_PRIMARY_EXHAUSTED_BLOCKS)).toMatch(/plan_primary_exhausted_to_default_pool_json/);
    expect(readSrc(RUST_LIB)).toMatch(/mod\s+primary_exhausted_to_default_pool_blocks/);
    expect(readSrc(REQUIRED_EXPORTS)).toMatch(/planPrimaryExhaustedToDefaultPoolJson/);
    expect(readSrc(NATIVE_EXPORTS)).toMatch(/planPrimaryExhaustedToDefaultPoolNative/);
  });

  it('Rust route-order tests lock search -> tools -> default ordering', () => {
    const src = readSrc(RUST_ROUTING_CONFIG);
    expect(src).toMatch(/fn\s+search_route_inserts_tools_before_default/);
    expect(src).toMatch(/fn\s+search_tool_continuation_inserts_tools_before_default/);
    expect(src).toMatch(/vec!\[\s*"search"\.to_string\(\),\s*"tools"\.to_string\(\),\s*"default"\.to_string\(\)/s);
  });
});
