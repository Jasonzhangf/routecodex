/**
 * Error chain singleton truth red test.
 * Locks: isProviderFailureNetworkTransportLike and isBlockingRecoverableProviderFailure
 * have exactly one definition site (provider-failure-policy-impl.ts).
 * Executor layer must NOT redefine network-transport-like or blocking-recoverable logic.
 */

import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();

function readSrc(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

const PROVIDER_FAILURE_IMPL = 'src/providers/core/runtime/provider-failure-policy-impl.ts';
const PROVIDER_FAILURE_POLICY = 'src/providers/core/runtime/provider-failure-policy.ts';
const EXECUTOR_ERROR_REPORT = 'src/server/runtime/http-server/executor/request-executor-error-report.ts';
const EXECUTOR_RETRY_DECISION = 'src/server/runtime/http-server/executor/request-executor-retry-decision.ts';
const EXECUTOR_PROVIDER_FAILURE = 'src/server/runtime/http-server/executor/request-executor-provider-failure.ts';
const REQUEST_EXECUTOR = 'src/server/runtime/http-server/request-executor.ts';

describe('Error chain singleton truth — no executor-layer redefinition', () => {
  it('isProviderFailureNetworkTransportLike: exactly one definition in provider-failure-policy-impl.ts', () => {
    const impl = readSrc(PROVIDER_FAILURE_IMPL);
    const matches = [...impl.matchAll(/export\s+function\s+isProviderFailureNetworkTransportLike/g)];
    expect(matches).toHaveLength(1);
  });

  it('isProviderFailureNetworkTransportLike: NOT redefined in request-executor-error-report.ts', () => {
    const report = readSrc(EXECUTOR_ERROR_REPORT);
    expect(report).not.toMatch(/export\s+function\s+isNetworkTransportLikeError/);
    expect(report).not.toMatch(/function\s+isNetworkTransportLikeError/);
  });

  it('isProviderFailureNetworkTransportLike: NOT redefined in request-executor-retry-decision.ts', () => {
    const decision = readSrc(EXECUTOR_RETRY_DECISION);
    expect(decision).not.toMatch(/function\s+isNetworkTransportLikeError/);
  });

  it('isBlockingRecoverableProviderFailure: NOT imported in request-executor.ts (dead import must be removed)', () => {
    const executor = readSrc(REQUEST_EXECUTOR);
    expect(executor).not.toMatch(/isBlockingRecoverableProviderFailure/);
  });

  it('isBlockingRecoverableProviderFailure: NOT imported in request-executor-provider-failure.ts', () => {
    const pf = readSrc(EXECUTOR_PROVIDER_FAILURE);
    expect(pf).not.toMatch(/isBlockingRecoverableProviderFailure/);
  });

  it('isBlockingRecoverableProviderFailure: re-exported only from provider-failure-policy.ts', () => {
    const policy = readSrc(PROVIDER_FAILURE_POLICY);
    const impl = readSrc(PROVIDER_FAILURE_IMPL);
    expect(impl).toMatch(/export\s+function\s+isBlockingRecoverableProviderFailure/);
    expect(policy).toMatch(/isBlockingRecoverableProviderFailure/);
  });

  it('request-executor-retry-decision.ts delegates to provider-failure-policy for network-transport detection', () => {
    const decision = readSrc(EXECUTOR_RETRY_DECISION);
    // Must import from policy, not define locally
    expect(decision).toMatch(/isProviderFailureNetworkTransportLike/);
    expect(decision).not.toMatch(/function\s+isNetworkTransportLikeError/);
  });
});
