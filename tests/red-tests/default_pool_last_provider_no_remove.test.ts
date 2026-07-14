/**
 * Default pool last provider no-remove red test.
 *
 * Locks:
 * - ErrorErr05 route availability: for "default" route, default tier targets must
 *   still count as available even if present in route_pool (they ARE the default pool).
 * - ErrorErr05 execution decision: default pool singleton with prior exclusions must
 *   retry same-provider (excluded_current_provider=false) rather than exclude and reroute.
 * - Request executor: singleton exhaustion wait must clear excludedProviderKeys before replay.
 * - Server contracts: describe_server_contracts must document this invariant.
 *
 * Owner: vr.route_availability_floor + error.provider_failure_policy + error.execution_decision_consumer
 */

import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();

function readSrc(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

const RUST_ERROR_ERR05_AVAILABILITY =
  'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/routing/error_err05_availability.rs';
const RUST_FAILURE_POLICY =
  'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/failure_policy.rs';
const TS_EXECUTOR =
  'src/server/runtime/http-server/request-executor.ts';
const RUST_SERVER_CONTRACTS =
  'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/server_contracts.rs';

describe('Default pool last provider no-remove', () => {
  // Gap 1: error_err05_availability.rs resolve_default_pool_available
  it('Rust availability: default route targets must be available even when in route_pool', () => {
    const src = readSrc(RUST_ERROR_ERR05_AVAILABILITY);
    expect(src).toMatch(/fn resolve_default_pool_available\s*\(/);
    expect(src).toContain('default_pool_singleton_provider');
    expect(src).toContain('if route_name.as_deref() == Some("default")');
  });

  // Gap 2: failure_policy.rs may_retry_verified_last_provider blocked by default_pool_available
  it('Rust failure policy: default pool singleton with exclusions retries same provider', () => {
    const src = readSrc(RUST_FAILURE_POLICY);
    expect(src).toMatch(/only_current_provider/);
    expect(src).toContain('may_retry_default_pool_singleton_provider');
    expect(src).toContain('excluded.retain(|value| value != key)');
  });

  // Gap 3: request-executor.ts singleton wait clears excluded
  it('TS executor: singleton exhaustion wait must clear excludedProviderKeys before replay', () => {
    const src = readSrc(TS_EXECUTOR);
    const blockStart = src.indexOf('if (singletonPoolDecision.shouldBlock)');
    const blockEnd = src.indexOf('if (lastError && excludedProviderKeys.size > 0)', blockStart);
    expect(blockStart).toBeGreaterThanOrEqual(0);
    expect(blockEnd).toBeGreaterThan(blockStart);
    const block = src.slice(blockStart, blockEnd);
    expect(block).toMatch(
      /provider\.route_pool_cooldown_wait\.completed[\s\S]*excludedProviderKeys\.clear\(\);[\s\S]*continue;/
    );
  });

  // Gap 4: server_contracts.rs documents the fixed blocking-wait cycle
  it('Server contracts: documents the 1s/2s/3s fixed cycle', () => {
    const src = readSrc(RUST_SERVER_CONTRACTS);
    expect(src).toContain('blocking_wait_1s_2s_3s_cycle');
    expect(src).toContain('1s -> 2s -> 3s -> repeat');
  });
});
