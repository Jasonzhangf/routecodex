import { initStatsCenter, getStatsCenter, type StatsSnapshot } from '../telemetry/stats-center.js';

function clone<T>(value: T): T {
  return value === undefined ? value : JSON.parse(JSON.stringify(value)) as T;
}

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

export async function runStatsCenterSpec(): Promise<void> {
  process.env.ROUTECODEX_STATS = '1';

  const center = initStatsCenter({ autoPrintOnExit: false, persistPath: null });
  center.reset();

  // Router hit
  center.recordVirtualRouterHit({
    requestId: 'req_1',
    timestamp: Date.now(),
    entryEndpoint: '/v1/chat/completions',
    routeName: 'thinking',
    pool: 'thinking',
    providerKey: 'glm.key1.glm-4.7',
    runtimeKey: 'glm.key1',
    providerType: 'openai',
    modelId: 'glm-4.7',
    reason: 'thinking:user-input',
    selectionPenalty: 2,
    stopMessageActive: true
  });

  // Provider usage: success
  center.recordProviderUsage({
    requestId: 'req_1',
    timestamp: Date.now(),
    providerKey: 'glm.key1.glm-4.7',
    runtimeKey: 'glm.key1',
    providerType: 'openai',
    modelId: 'glm-4.7',
    routeName: 'thinking',
    entryEndpoint: '/v1/chat/completions',
    success: true,
    latencyMs: 100,
    promptTokens: 10,
    completionTokens: 20,
    totalTokens: 30
  });

  // Provider usage: error
  center.recordProviderUsage({
    requestId: 'req_2',
    timestamp: Date.now(),
    providerKey: 'glm.key1.glm-4.7',
    runtimeKey: 'glm.key1',
    providerType: 'openai',
    modelId: 'glm-4.7',
    routeName: 'thinking',
    entryEndpoint: '/v1/chat/completions',
    success: false,
    latencyMs: 50,
    promptTokens: 5,
    completionTokens: 5,
    totalTokens: 10
  });

  const snap: StatsSnapshot = clone(getStatsCenter().getSnapshot());

  // Router assertions
  assert(snap.router.global.requestCount === 1, 'router.requestCount should be 1');
  assert(snap.router.global.poolHitCount.thinking === 1, 'router.poolHitCount.thinking should be 1');
  assert(snap.router.global.providerHitCount['glm.key1.glm-4.7'] === 1, 'router.providerHitCount should be 1');
  assert(snap.router.global.reasonHitCount['thinking:user-input'] === 1, 'router.reasonHitCount should be 1');
  assert(snap.router.global.penaltyHitCount['2'] === 1, 'router.penaltyHitCount[2] should be 1');
  assert(snap.router.global.stopMessageActiveCount === 1, 'router.stopMessageActiveCount should be 1');

  // Provider assertions
  const global = snap.providers.global;
  assert(global.requestCount === 2, 'provider.requestCount should be 2');
  assert(global.successCount === 1, 'provider.successCount should be 1');
  assert(global.errorCount === 1, 'provider.errorCount should be 1');
  assert(global.latencySumMs === 150, 'latencySumMs should be 150');
  assert(global.usage.promptTokens === 15, 'promptTokens should be 15');
  assert(global.usage.completionTokens === 25, 'completionTokens should be 25');
  assert(global.usage.totalTokens === 40, 'totalTokens should be 40');

  // ensure byProviderKey bucket exists
  const byProvider = snap.providers.byProviderKey['glm.key1.glm-4.7'];
  assert(byProvider && byProvider.requestCount === 2, 'byProviderKey bucket should aggregate requests');
}

if (require.main === module) {
  runStatsCenterSpec()
    .then(() => {
      // eslint-disable-next-line no-console
      console.log('[stats-center.spec] ok');
    })
    .catch((error) => {
      // eslint-disable-next-line no-console
      console.error('[stats-center.spec] failed', error);
      process.exitCode = 1;
    });
}
