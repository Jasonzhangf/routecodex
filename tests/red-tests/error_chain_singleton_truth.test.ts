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
const PROVIDER_ERROR_CLASSIFIER = 'src/providers/core/runtime/provider-error-classifier.ts';
const PROVIDER_ERROR_REPORTER = 'src/providers/core/utils/provider-error-reporter.ts';
const EXECUTOR_ERROR_REPORT = 'src/server/runtime/http-server/executor/request-executor-error-report.ts';
const EXECUTOR_RETRY_DECISION = 'src/server/runtime/http-server/executor/request-executor-retry-decision.ts';
const EXECUTOR_RETRY_EXECUTION_PLAN = 'src/server/runtime/http-server/executor/request-executor-retry-execution-plan.ts';
const EXECUTOR_PROVIDER_FAILURE = 'src/server/runtime/http-server/executor/request-executor-provider-failure.ts';
const REQUEST_EXECUTOR = 'src/server/runtime/http-server/request-executor.ts';
const ERROR_CHAIN_DOCS = [
  'docs/design/pipeline-type-topology-and-module-boundaries.md',
  'docs/design/error-pipeline-contract-and-routing-audit.md',
  'docs/design/provider-failure-policy-ssot.md',
  'docs/goals/error-policy-center-unification-plan.md',
];
const ERROR_CHAIN_SKILL_DOCS = [
  '.agents/skills/rcc-dev-skills/SKILL.md'
];
const ERROR_POLICY_SOURCE_GLOBS = [
  'src/providers',
  'src/server/runtime/http-server/executor',
  'src/server/runtime/http-server/router-direct-pipeline.ts',
  'src/server/runtime/http-server/provider-direct-pipeline.ts',
  'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine'
];

function listFiles(rootRel: string): string[] {
  const root = path.join(ROOT, rootRel);
  if (!fs.existsSync(root)) {
    return [];
  }
  const stat = fs.statSync(root);
  if (stat.isFile()) {
    return [rootRel];
  }
  const output: string[] = [];
  for (const entry of fs.readdirSync(root)) {
    const rel = path.join(rootRel, entry);
    const entryPath = path.join(ROOT, rel);
    const entryStat = fs.statSync(entryPath);
    if (entryStat.isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist' || entry === 'target') {
        continue;
      }
      output.push(...listFiles(rel));
      continue;
    }
    if (/\.(ts|tsx|js|mjs)$/.test(entry)) {
      output.push(rel);
    }
  }
  return output;
}

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

  it('request-executor-retry-decision.ts does not redefine network-transport detection locally', () => {
    const decision = readSrc(EXECUTOR_RETRY_DECISION);
    expect(decision).not.toMatch(/isProviderFailureNetworkTransportLike/);
    expect(decision).not.toMatch(/function\s+isNetworkTransportLikeError/);
  });

  it('authoritative docs and skill do not use stale error node names', () => {
    const staleNames = /ErrorErr02CatalogNormalized|ErrorErr03PolicyClassified|ErrorErr04RetryOrFailPlanned|ErrorErr05ClientProjected/;
    for (const rel of [...ERROR_CHAIN_DOCS, ...ERROR_CHAIN_SKILL_DOCS]) {
      expect(readSrc(rel)).not.toMatch(staleNames);
    }
  });

  it('authoritative docs and skill name the full ErrorErr01-06 chain and do not require periodic recovery class', () => {
    for (const rel of ERROR_CHAIN_DOCS) {
      const src = readSrc(rel);
      expect(src).toMatch(/ErrorErr01SourceRaised/);
      expect(src).toMatch(/ErrorErr02HostCaptured/);
      expect(src).toMatch(/ErrorErr03RuntimeClassified/);
      expect(src).toMatch(/ErrorErr04RouterPolicyApplied/);
      expect(src).toMatch(/ErrorErr05ExecutionDecision/);
      expect(src).toMatch(/ErrorErr06ClientProjected/);
      expect(src).not.toMatch(/periodic_recovery/);
    }
    for (const rel of ERROR_CHAIN_SKILL_DOCS) {
      const src = readSrc(rel);
      expect(src).not.toMatch(/periodic_recovery/);
    }
  });

  it('ErrorHandlingCenter is not imported by provider policy, executor retry, direct, or VR policy code', () => {
    const offenders: string[] = [];
    for (const rootRel of ERROR_POLICY_SOURCE_GLOBS) {
      for (const rel of listFiles(rootRel)) {
        const src = readSrc(rel);
        if (/ErrorHandlingCenter|rcc-errorhandling/.test(src)) {
          offenders.push(rel);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('provider-error-reporter requires explicit recoverable and affectsHealth instead of inferring policy defaults', () => {
    const reporter = readSrc(PROVIDER_ERROR_REPORTER);
    expect(reporter).toMatch(/explicit recoverable\/affectsHealth is required/);
    expect(reporter).not.toMatch(/recoverable\s*\?\?/);
    expect(reporter).not.toMatch(/affectsHealth\s*\?\?/);
  });

  it('provider-error-classifier exposes policy outcome classification without local recoverable/affectsHealth derivation', () => {
    const classifier = readSrc(PROVIDER_ERROR_CLASSIFIER);
    expect(classifier).toMatch(/classification:\s*outcome\.classification/);
    expect(classifier).toMatch(/recoverable:\s*outcome\.recoverable/);
    expect(classifier).toMatch(/affectsHealth:\s*outcome\.affectsHealth/);
    expect(classifier).not.toMatch(/const\s+recoverable\s*=\s*outcome\.recoverable/);
    expect(classifier).not.toMatch(/const\s+affectsHealth\s*=\s*outcome\.affectsHealth/);
    expect(classifier).not.toMatch(/recoverable:\s*rateLimitKind|recoverable:\s*isRateLimit|affectsHealth:\s*rateLimitKind|affectsHealth:\s*isRateLimit/);
  });

  it('request-executor-provider-failure reports provider errors from a single policy outcome', () => {
    const pf = readSrc(EXECUTOR_PROVIDER_FAILURE);
    expect(pf).toMatch(/resolveProviderFailureOutcome/);
    expect(pf).toMatch(/recoverable:\s*outcome\.recoverable/);
    expect(pf).toMatch(/affectsHealth:\s*outcome\.affectsHealth/);
    expect(pf).not.toMatch(/isProviderFailureHealthNeutral/);
    expect(pf).not.toMatch(/function\s+isHealthNeutralProviderError/);
    expect(pf).not.toMatch(/function\s+resolveReportedProviderErrorRecoverable/);
    expect(pf).not.toMatch(/classification\s*===\s*['"]recoverable['"][\s\S]{0,180}return\s+true/);
  });

  it('request-executor-reselection delegates keep-excluded classification policy', () => {
    const reselection = readSrc('src/server/runtime/http-server/executor/request-executor-reselection-plan.ts');
    expect(reselection).toMatch(/shouldKeepProviderExcludedForNextAttempt/);
    expect(reselection).not.toMatch(/classification\s*===\s*['"]unrecoverable['"]\s*\|\|\s*hasAlternativeCandidate/);
  });

  it('request-executor-retry-execution delegates terminal classification branch policy', () => {
    const executionPlan = readSrc(EXECUTOR_RETRY_EXECUTION_PLAN);
    expect(executionPlan).not.toMatch(/shouldDirectReturnUnrecoverableWithoutForcedExclusion/);
    expect(executionPlan).not.toMatch(/shouldCancelUnrecoverableRerouteWithoutAlternative/);
    expect(executionPlan).toMatch(/shouldRerouteExcludedFailure/);
    expect(executionPlan).not.toMatch(/classification\s*===\s*['"]periodic_recovery['"]/);
    expect(executionPlan).not.toMatch(/classification\s*===\s*['"]unrecoverable['"][\s\S]{0,240}retrySwitchPlan/);
  });

  it('request-executor thin shell does not import classification or health policy internals directly', () => {
    const executor = readSrc(REQUEST_EXECUTOR);
    expect(executor).not.toMatch(/isProviderFailureHealthNeutral/);
    expect(executor).not.toMatch(/resolveProviderFailureClassification/);
  });

  it('request-executor-provider-failure-plan delegates force-exclude suppression policy', () => {
    const failurePlan = readSrc('src/server/runtime/http-server/executor/request-executor-provider-failure-plan.ts');
    expect(failurePlan).toMatch(/reportPlan\.stageHint === 'host\.response_contract'/);
    expect(failurePlan).toMatch(/reportPlan\.stageHint === 'provider\.followup'/);
  });

  it('executor retry path does not locally reroute recoverable failures away from the policy decision', () => {
    const decision = readSrc(EXECUTOR_RETRY_DECISION);
    const executionPlan = readSrc(EXECUTOR_RETRY_EXECUTION_PLAN);
    expect(decision).not.toMatch(/classification\s*===\s*['"]recoverable['"][\s\S]{0,240}decisionLabel/);
    expect(executionPlan).not.toMatch(/recoverableProviderReroute|terminalRecoverableReroute/);
    expect(executionPlan).not.toMatch(/providerKey\.startsWith\(['"][a-z0-9_-]+\./i);
  });

  it('executor retry path does not locally reroute unrecoverable failures away from direct failure', () => {
    const executionPlan = readSrc(EXECUTOR_RETRY_EXECUTION_PLAN);
    expect(executionPlan).not.toMatch(/terminalProviderFailureReroute/);
    expect(executionPlan).not.toMatch(/classification\s*===\s*['"]unrecoverable['"][\s\S]{0,240}return\s*\{/);
  });

  it('executor retry path does not locally classify quota or periodic recovery candidates', () => {
    const executionPlan = readSrc(EXECUTOR_RETRY_EXECUTION_PLAN);
    expect(executionPlan).not.toMatch(/isTerminalQuotaRerouteCandidate/);
    expect(executionPlan).not.toMatch(/quotaScope|quotaReason|daily_limit/);
  });
});
