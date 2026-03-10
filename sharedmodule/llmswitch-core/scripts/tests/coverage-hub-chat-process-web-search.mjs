#!/usr/bin/env node
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const moduleUrl = pathToFileURL(
  path.join(repoRoot, 'dist', 'conversion', 'hub', 'process', 'chat-process-web-search.js')
).href;

async function importFresh(tag) {
  return import(`${moduleUrl}?case=${tag}_${Date.now()}_${Math.random().toString(16).slice(2)}`);
}

function requestWithText(text, semantics) {
  return {
    messages: [{ role: 'user', content: text }],
    ...(semantics ? { semantics } : {})
  };
}

function webSearchConfig(engines, injectPolicy = 'selective') {
  return { engines, injectPolicy };
}

async function main() {
  const prevNativePath = process.env.ROUTECODEX_LLMS_ROUTER_NATIVE_PATH;
  delete process.env.ROUTECODEX_LLMS_ROUTER_NATIVE_PATH;

  const mod = await importFresh('hub-chat-process-web-search');
  const { buildWebSearchOperations } = mod;
  assert.equal(typeof buildWebSearchOperations, 'function');

  const baseEngines = [
    { id: 'bing-main', description: 'Bing', providerKey: 'bing.default.search' },
    { id: 'google-main', description: 'Google', providerKey: 'gemini-cli.key.search' },
    { id: 'skip-me', providerKey: 'x', serverToolsDisabled: true }
  ];

  {
    const out = buildWebSearchOperations(
      requestWithText('web search latest news'),
      { __rt: { serverToolFollowup: true, webSearch: webSearchConfig(baseEngines, 'always') } }
    );
    assert.deepEqual(out, []);
  }

  {
    const out = buildWebSearchOperations(requestWithText('web search latest news'), { __rt: {} });
    assert.deepEqual(out, []);
  }

  {
    const out = buildWebSearchOperations(requestWithText('web search latest news'));
    assert.deepEqual(out, []);
  }

  {
    const out = buildWebSearchOperations(
      requestWithText('web search latest news', { providerExtras: { webSearch: false } }),
      { __rt: { webSearch: webSearchConfig(baseEngines, 'always') } }
    );
    assert.deepEqual(out, []);
  }

  {
    const out = buildWebSearchOperations(
      requestWithText('hello world'),
      { __rt: { webSearch: webSearchConfig(baseEngines, 'selective') } }
    );
    assert.deepEqual(out, []);
  }

  {
    const out = buildWebSearchOperations(
      { messages: [] },
      { __rt: { webSearch: webSearchConfig(baseEngines, 'selective') } }
    );
    assert.deepEqual(out, []);
  }

  {
    const out = buildWebSearchOperations(
      requestWithText('web search latest ai news'),
      { __rt: { webSearch: webSearchConfig(baseEngines, 'selective') } }
    );
    assert.equal(out.length, 2);
    assert.equal(out[0].op, 'set_request_metadata_fields');
    assert.equal(out[0].fields.webSearchEnabled, true);
    assert.equal(out[1].op, 'append_tool_if_missing');
    assert.equal(out[1].toolName, 'web_search');
    assert.deepEqual(out[1].tool.function.parameters.properties.engine.enum, ['bing-main', 'google-main']);
  }

  {
    const out = buildWebSearchOperations(
      requestWithText('web search latest ai news'),
      { __rt: { webSearch: webSearchConfig(baseEngines, 'always') } },
      { shouldInject: false, selectedEngineIndexes: [0] }
    );
    assert.deepEqual(out, []);
  }

  {
    const out = buildWebSearchOperations(
      requestWithText('web search latest ai news'),
      { __rt: { webSearch: webSearchConfig(baseEngines, 'always') } },
      { shouldInject: true, selectedEngineIndexes: [999, -1] }
    );
    assert.deepEqual(out, []);
  }

  {
    const out = buildWebSearchOperations(
      requestWithText('web search latest ai news'),
      { __rt: { webSearch: webSearchConfig(baseEngines, 'always') } },
      { shouldInject: true, selectedEngineIndexes: [0, Number.NaN, Infinity, 'x'] }
    );
    assert.equal(out.length, 2);
    assert.deepEqual(out[1].tool.function.parameters.properties.engine.enum, ['bing-main']);
  }

  {
    const out = buildWebSearchOperations(
      requestWithText('web search latest ai news'),
      { __rt: { webSearch: webSearchConfig([{ id: 'normal-no-provider' }], 'unexpected') } }
    );
    assert.equal(out.length, 2);
    assert.deepEqual(out[1].tool.function.parameters.properties.engine.enum, ['normal-no-provider']);
  }

  {
    const out = buildWebSearchOperations(
      requestWithText('请帮我谷歌搜索今天的 AI 新闻'),
      { __rt: { webSearch: webSearchConfig(baseEngines, 'always') } }
    );
    assert.equal(out.length, 2);
    assert.deepEqual(out[1].tool.function.parameters.properties.engine.enum, ['google-main']);
  }

  {
    const out = buildWebSearchOperations(
      requestWithText('请帮我谷歌搜索今天的 AI 新闻'),
      { __rt: { webSearch: webSearchConfig([{ id: 'bing-only', providerKey: 'bing.default.search' }], 'always') } }
    );
    assert.equal(out.length, 2);
    assert.deepEqual(out[1].tool.function.parameters.properties.engine.enum, ['bing-only']);
  }

  {
    const out = buildWebSearchOperations(
      requestWithText('请帮我谷歌搜索今天的 AI 新闻'),
      {
        __rt: {
          webSearch: webSearchConfig([
            { id: 'google-special', providerKey: 'custom.search.provider' },
            { id: 'bing-only', providerKey: 'bing.default.search' }
          ], 'always')
        }
      }
    );
    assert.equal(out.length, 2);
    assert.deepEqual(out[1].tool.function.parameters.properties.engine.enum, ['google-special']);
  }

  {
    const out = buildWebSearchOperations(
      requestWithText('web search latest news'),
      {
        __rt: {
          webSearch: webSearchConfig([
            { id: '   ', providerKey: 'bad' },
            { providerKey: 'also-bad' }
          ], 'always')
        }
      }
    );
    assert.deepEqual(out, []);
  }

  {
    const out = buildWebSearchOperations(
      requestWithText('web search latest news'),
      {
        __rt: {
          webSearch: webSearchConfig([
            { id: 'deepseek:web_search', providerKey: 'deepseek-web.key.deepseek-chat', executionMode: 'direct', directActivation: 'route', default: true },
            { id: 'bing-main', providerKey: 'bing.default.search' }
          ], 'always')
        }
      }
    );
    assert.deepEqual(out, []);
  }

  {
    const out = buildWebSearchOperations(
      requestWithText('web search latest news'),
      {
        __rt: {
          webSearch: webSearchConfig([
            { id: 'bing-main', providerKey: 'bing.default.search' },
            { id: 'ds-second', providerKey: 'deepseek-web.key.deepseek-chat', executionMode: 'direct', directActivation: 'route', default: false }
          ], 'always')
        }
      }
    );
    assert.equal(out.length, 2);
  }

  {
    const out = buildWebSearchOperations(
      requestWithText('web search latest news', { providerExtras: { webSearch: { force: true } } }),
      {
        __rt: {
          webSearch: webSearchConfig([
            { id: 'deepseek:web_search', providerKey: 'deepseek-web.key.deepseek-reasoner', executionMode: 'direct', directActivation: 'route', default: true },
            { id: 'bing-main', providerKey: 'bing.default.search', executionMode: 'servertool' }
          ], 'selective')
        }
      }
    );
    assert.equal(out.length, 2);
  }

  {
    const out = buildWebSearchOperations(
      requestWithText('web search latest news'),
      {
        __rt: {
          webSearch: webSearchConfig([
            { id: 'bad', providerKey: 'deepseek-web.key.other-model', default: true }
          ], 'always')
        }
      }
    );
    assert.equal(out.length, 2);
  }

  if (prevNativePath === undefined) {
    delete process.env.ROUTECODEX_LLMS_ROUTER_NATIVE_PATH;
  } else {
    process.env.ROUTECODEX_LLMS_ROUTER_NATIVE_PATH = prevNativePath;
  }

  console.log('✅ coverage-hub-chat-process-web-search passed');
}

main().catch((error) => {
  console.error('❌ coverage-hub-chat-process-web-search failed:', error);
  process.exit(1);
});
