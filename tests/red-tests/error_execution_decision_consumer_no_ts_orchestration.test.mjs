import fs from 'node:fs';

const retryPlanPath = 'src/server/runtime/http-server/executor/request-executor-retry-execution-plan.ts';
const failurePlanPath = 'src/server/runtime/http-server/executor/request-executor-provider-failure-plan.ts';
const failurePolicyNativePath = 'src/providers/core/runtime/provider-failure-policy-native.ts';
const retryPlan = fs.readFileSync(retryPlanPath, 'utf8');
const failurePlan = fs.readFileSync(failurePlanPath, 'utf8');

const forbiddenRetryPlanMarkers = [
  'resolveProviderFailureClassification(',
  'resolveProviderFailureActionPlan(',
  'resolveProviderRetryExclusionPlan(',
  'resolveProviderRetryExecutionPlanExhaustionGate(',
  'const mayRetryVerifiedLastProvider =',
  'const shouldProbeUnprovenLastProviderByExclusion =',
];

const forbiddenFailurePlanMarkers = [
  'resolveProviderFailureClassification(',
  'const suppressForceExclude =',
];

const failures = [];
for (const marker of forbiddenRetryPlanMarkers) {
  if (retryPlan.includes(marker)) failures.push(`${retryPlanPath} retains TS semantic marker: ${marker}`);
}
for (const marker of forbiddenFailurePlanMarkers) {
  if (failurePlan.includes(marker)) failures.push(`${failurePlanPath} retains TS semantic marker: ${marker}`);
}

if (fs.existsSync(failurePolicyNativePath)) {
  failures.push(`${failurePolicyNativePath} retired nullable native bridge must stay physically deleted`);
}

if (failures.length > 0) {
  console.error('[error-execution-decision-no-ts-orchestration] RED');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('[error-execution-decision-no-ts-orchestration] GREEN');
