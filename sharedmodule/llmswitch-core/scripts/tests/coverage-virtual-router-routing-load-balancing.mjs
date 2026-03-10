#!/usr/bin/env node
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const moduleUrl = pathToFileURL(
  path.join(repoRoot, 'dist', 'router', 'virtual-router', 'bootstrap', 'routing-config.js')
).href;

async function main() {
  const mod = await import(`${moduleUrl}?case=${Date.now()}_${Math.random().toString(16).slice(2)}`);
  const { normalizeRouting, expandRoutingTable } = mod;

  const normalized = normalizeRouting({
    search: [
      {
        id: 'search-primary',
        priority: 100,
        targets: ['deepseek-web.deepseek-chat', 'ark-coding-plan.kimi-k2.5'],
        loadBalancing: {
          strategy: 'weighted',
          weights: {
            'deepseek-web.deepseek-chat': 5,
            'ark-coding-plan.kimi-k2.5': 2
          }
        }
      }
    ],
    tools: [
      {
        id: 'tools-primary',
        priority: 100,
        targets: ['crs.gpt-5.4', 'tabglm.glm-5'],
        loadBalancing: {
          strategy: 'sticky',
          weights: {
            'crs.gpt-5.4': 4,
            'tabglm.glm-5': 1
          }
        }
      }
    ]
  });

  assert.equal(normalized.search[0]?.loadBalancing?.strategy, 'weighted');
  assert.deepEqual(normalized.search[0]?.loadBalancing?.weights, {
    'deepseek-web.deepseek-chat': 5,
    'ark-coding-plan.kimi-k2.5': 2
  });
  assert.equal(normalized.tools[0]?.loadBalancing?.strategy, 'sticky');

  const aliasIndex = new Map([
    ['deepseek-web', ['key1']],
    ['ark-coding-plan', ['key1']],
    ['crs', ['key1']],
    ['tabglm', ['key1']]
  ]);
  const modelIndex = new Map([
    ['deepseek-web', { declared: true, models: ['deepseek-chat'] }],
    ['ark-coding-plan', { declared: true, models: ['kimi-k2.5'] }],
    ['crs', { declared: true, models: ['gpt-5.4'] }],
    ['tabglm', { declared: true, models: ['glm-5'] }]
  ]);

  const expanded = expandRoutingTable(normalized, aliasIndex, modelIndex);
  assert.equal(expanded.routing.search[0]?.loadBalancing?.strategy, 'weighted');
  assert.deepEqual(expanded.routing.search[0]?.loadBalancing?.weights, {
    'deepseek-web.deepseek-chat': 5,
    'ark-coding-plan.kimi-k2.5': 2
  });
  assert.equal(expanded.routing.tools[0]?.loadBalancing?.strategy, 'sticky');
  assert.deepEqual(expanded.routing.tools[0]?.loadBalancing?.weights, {
    'crs.gpt-5.4': 4,
    'tabglm.glm-5': 1
  });

  console.log('✅ coverage-virtual-router-routing-load-balancing passed');
}

main().catch((error) => {
  console.error('❌ coverage-virtual-router-routing-load-balancing failed:', error);
  process.exit(1);
});
