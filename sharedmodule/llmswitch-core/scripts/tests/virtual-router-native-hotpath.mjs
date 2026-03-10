#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..', '..');

async function main() {
  const mod = await import(path.join(repoRoot, 'dist', 'router', 'virtual-router', 'engine-selection', 'native-router-hotpath.js'));
  const {
    buildQuotaBuckets,
    getNativeRouterHotpathSource,
    analyzePendingToolSync,
    analyzeContinueExecutionInjection,
    analyzeChatProcessMedia,
    analyzeChatWebSearchIntent
  } = mod;
  if (typeof buildQuotaBuckets !== 'function') {
    throw new Error('buildQuotaBuckets is not available');
  }
  if (typeof analyzePendingToolSync !== 'function') {
    throw new Error('analyzePendingToolSync is not available');
  }
  if (typeof analyzeContinueExecutionInjection !== 'function') {
    throw new Error('analyzeContinueExecutionInjection is not available');
  }
  if (typeof analyzeChatProcessMedia !== 'function') {
    throw new Error('analyzeChatProcessMedia is not available');
  }
  if (typeof analyzeChatWebSearchIntent !== 'function') {
    throw new Error('analyzeChatWebSearchIntent is not available');
  }

  const nowMs = Date.now();
  const input = [
    { key: 'p1', order: 0, hasQuota: false, inPool: true },
    { key: 'p2', order: 1, hasQuota: true, inPool: true, priorityTier: 1, selectionPenalty: 2 },
    { key: 'p3', order: 2, hasQuota: true, inPool: true, priorityTier: 1, selectionPenalty: 0 },
    { key: 'p4', order: 3, hasQuota: true, inPool: false, priorityTier: 0, selectionPenalty: 0 },
    { key: 'p5', order: 4, hasQuota: true, inPool: true, cooldownUntil: nowMs + 60_000, priorityTier: 0 }
  ];

  const result = buildQuotaBuckets(input, nowMs);
  const p1 = result.buckets.get(1) || [];
  const p100 = result.buckets.get(100) || [];

  if (!result.priorities.includes(1)) {
    throw new Error('priority tier 1 was not emitted');
  }
  if (!p1.some((entry) => entry.key === 'p2')) {
    throw new Error('p2 is missing in priority bucket 1');
  }
  if (!p1.some((entry) => entry.key === 'p3')) {
    throw new Error('p3 is missing in priority bucket 1');
  }
  if (!p100.some((entry) => entry.key === 'p1')) {
    throw new Error('no-quota fallback bucket is missing p1');
  }
  if (Array.from(result.buckets.values()).flat().some((entry) => entry.key === 'p4' || entry.key === 'p5')) {
    throw new Error('filtered entries (out-of-pool/cooldown) leaked into buckets');
  }

  const pending = analyzePendingToolSync(
    [{ role: 'assistant' }, { role: 'tool', tool_call_id: 'tc-1' }, { role: 'tool', toolCallId: 'tc-2' }],
    ['tc-1', 'tc-2']
  );
  if (!pending.ready || pending.insertAt !== 2) {
    throw new Error(`pending sync analyze failed: ready=${String(pending.ready)} insertAt=${String(pending.insertAt)}`);
  }

  const continueInjection = analyzeContinueExecutionInjection(
    [{ role: 'user', content: '[routecodex:continue_execution_injection]\n继续执行' }],
    '[routecodex:continue_execution_injection]',
    '继续执行'
  );
  if (!continueInjection.hasDirective) {
    throw new Error('continue execution injection analyze failed');
  }

  const media = analyzeChatProcessMedia([
    { role: 'user', content: [{ type: 'image_url', image_url: 'https://old.png' }] },
    { role: 'assistant', content: 'ok' },
    { role: 'user', content: [{ type: 'text', text: 'latest' }] }
  ]);
  if (!Array.isArray(media.stripIndices) || media.stripIndices[0] !== 0) {
    throw new Error(`chat process media strip analyze failed: ${JSON.stringify(media)}`);
  }
  if (media.containsCurrentTurnImage !== false) {
    throw new Error('chat process media current-turn image detect failed');
  }

  const webSearch = analyzeChatWebSearchIntent([
    { role: 'assistant', content: 'policy text about web search' },
    { role: 'user', content: '请帮我上网搜索今天的新闻' }
  ]);
  if (!webSearch.hasIntent || webSearch.googlePreferred !== false) {
    throw new Error(`chat web-search intent analyze failed: ${JSON.stringify(webSearch)}`);
  }

  console.log(`[virtual-router-native-hotpath] ok source=${getNativeRouterHotpathSource()}`);
}

main().catch((error) => {
  console.error('[virtual-router-native-hotpath] failed', error);
  process.exit(1);
});
