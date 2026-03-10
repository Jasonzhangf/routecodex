#!/usr/bin/env node

import assert from 'node:assert/strict';

async function main() {
  const { executeWebSearchBackendPlan } = await import('../../dist/servertool/handlers/web-search.js');

  const plan = {
    kind: 'web_search',
    requestIdSuffix: ':web_search',
    query: 'routecodex ci coverage',
    recency: '7d',
    resultCount: 5,
    engines: [
      {
        id: 'iflow-engine',
        providerKey: 'iflow.key1.glm-4.7',
        searchEngineList: ['GOOGLE']
      },
      {
        id: 'glm-4.7',
        providerKey: 'tab.key1.glm-4.7'
      }
    ]
  };

  const options = {
    chatResponse: {},
    adapterContext: { requestId: 'req_web_search_backend_smoke', providerProtocol: 'openai-chat' },
    entryEndpoint: '/v1/chat/completions',
    requestId: 'req_web_search_backend_smoke',
    providerProtocol: 'openai-chat',
    providerInvoker: async ({ entryEndpoint }) => {
      if (entryEndpoint === '/v1/chat/retrieve') {
        return {
          providerResponse: {
            success: false,
            message: 'no hits',
            data: []
          }
        };
      }
      throw new Error(`unexpected providerInvoker entryEndpoint: ${entryEndpoint}`);
    },
    reenterPipeline: async () => {
      return {
        body: {
          object: 'chat.completion',
          model: 'glm-4.7',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: '简要总结：找到 3 条可用结果。' }
            }
          ],
          web_search: [
            { title: 'Doc A', link: 'https://example.com/a', media: 'example', publish_date: '2026-01-01', content: 'A' },
            { title: 'Doc B', link: 'https://example.com/b', media: 'example', publish_date: '2026-01-02', content: 'B' },
            { title: 'Doc C', link: 'https://example.com/c', media: 'example', publish_date: '2026-01-03', content: 'C' }
          ]
        }
      };
    }
  };

  const result = await executeWebSearchBackendPlan({ plan, options });
  assert.equal(result.kind, 'web_search');
  assert.ok(result.chosenEngine?.providerKey === 'tab.key1.glm-4.7', 'should fall back to the non-iflow engine');
  assert.ok(result.result.ok === true, 'final web_search should be ok');
  assert.ok(result.result.summary && result.result.summary.includes('简要总结'), 'summary should be extracted');
  assert.ok(Array.isArray(result.result.hits), 'hits array should exist');
  assert.ok(result.result.hits.length === 3, 'hits should be parsed from payload.web_search');
  console.log('✅ web_search backend smoke passed');
}

main().catch((e) => {
  console.error('❌ web_search backend smoke failed:', e);
  process.exit(1);
});

