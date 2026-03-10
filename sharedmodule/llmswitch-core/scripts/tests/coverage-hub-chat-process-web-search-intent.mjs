#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const moduleUrl = pathToFileURL(
  path.join(repoRoot, 'dist', 'conversion', 'hub', 'process', 'chat-process-web-search-intent.js')
).href;

async function importFresh(tag) {
  return import(`${moduleUrl}?case=${tag}_${Date.now()}_${Math.random().toString(16).slice(2)}`);
}

function setEnvVar(name, value) {
  if (value === undefined || value === null || value === '') {
    delete process.env[name];
    return;
  }
  process.env[name] = String(value);
}

async function withTempModule(content, fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'llms-chat-webintent-native-'));
  const file = path.join(dir, 'mock-native.cjs');
  await fs.writeFile(file, content, 'utf8');
  try {
    await fn(file);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function buildRequest(messages, semantics) {
  return {
    model: 'gpt-test',
    messages,
    tools: [],
    ...(semantics ? { semantics } : {})
  };
}

async function main() {
  const prevNativeDisable = process.env.ROUTECODEX_LLMS_ROUTER_NATIVE_DISABLE;
  const prevNativePath = process.env.ROUTECODEX_LLMS_ROUTER_NATIVE_PATH;
  setEnvVar('ROUTECODEX_LLMS_ROUTER_NATIVE_DISABLE', '1');
  delete process.env.ROUTECODEX_LLMS_ROUTER_NATIVE_PATH;

  const mod = await importFresh('hub-chat-process-web-search-intent');
  const detectWebSearchIntent = mod.detectWebSearchIntent;
  const extractWebSearchSemantics = mod.extractWebSearchSemantics;
  assert.equal(typeof detectWebSearchIntent, 'function');
  assert.equal(typeof extractWebSearchSemantics, 'function');

  assert.deepEqual(detectWebSearchIntent(buildRequest([])), {
    hasIntent: false,
    googlePreferred: false
  });
  assert.deepEqual(
    detectWebSearchIntent({ model: 'gpt-test', tools: [] }),
    { hasIntent: false, googlePreferred: false }
  );

  assert.deepEqual(
    detectWebSearchIntent(
      buildRequest([
        { role: 'user', content: 'please web search this topic' },
        { role: 'assistant', content: 'ok' }
      ])
    ),
    { hasIntent: false, googlePreferred: false }
  );

  assert.deepEqual(
    detectWebSearchIntent(buildRequest([{ role: 'user', content: '谷歌搜索今天的新闻' }])),
    { hasIntent: true, googlePreferred: true }
  );
  assert.deepEqual(
    detectWebSearchIntent(buildRequest([{ role: 'user', content: '帮我上网看看今天发生了什么' }])),
    { hasIntent: true, googlePreferred: false }
  );
  assert.deepEqual(
    detectWebSearchIntent(
      buildRequest([
        {
          role: 'user',
          content: [
            { type: 'input_text', text: 'Can you find online reports about X?' },
            { type: 'input_image', image_url: 'https://image.example/x.png' }
          ]
        }
      ])
    ),
    { hasIntent: true, googlePreferred: false }
  );
  assert.deepEqual(
    detectWebSearchIntent(
      buildRequest([{ role: 'user', content: [{ type: 'input_image', image_url: 'https://no-text' }] }])
    ),
    { hasIntent: false, googlePreferred: false }
  );
  assert.deepEqual(
    detectWebSearchIntent(buildRequest([{ role: 'user', content: 'Please google web search latest CVEs' }])),
    { hasIntent: true, googlePreferred: true }
  );
  assert.deepEqual(
    detectWebSearchIntent(buildRequest([{ role: 'user', content: '请帮我搜索网络最新报道' }])),
    { hasIntent: true, googlePreferred: false }
  );

  assert.equal(extractWebSearchSemantics(undefined), undefined);
  assert.equal(extractWebSearchSemantics({ providerExtras: 'bad-shape' }), undefined);
  assert.equal(extractWebSearchSemantics({ providerExtras: {} }), undefined);
  assert.equal(extractWebSearchSemantics({ providerExtras: { webSearch: 'true' } }), undefined);
  assert.deepEqual(extractWebSearchSemantics({ providerExtras: { webSearch: true } }), { force: true });
  assert.deepEqual(extractWebSearchSemantics({ providerExtras: { webSearch: false } }), { disable: true });
  assert.deepEqual(
    extractWebSearchSemantics({ providerExtras: { webSearch: { disable: true } } }),
    { disable: true }
  );
  assert.deepEqual(
    extractWebSearchSemantics({ providerExtras: { webSearch: { force: true, disable: true } } }),
    { force: true, disable: true }
  );
  assert.equal(extractWebSearchSemantics({ providerExtras: { webSearch: { force: 'x' } } }), undefined);

  await withTempModule(
    `exports.analyzeChatWebSearchIntentJson = () => JSON.stringify({
      hasIntent: true,
      googlePreferred: true
    });
    exports.extractWebSearchSemanticsHintJson = () => JSON.stringify({
      force: true
    });`,
    async (modulePath) => {
      setEnvVar('ROUTECODEX_LLMS_ROUTER_NATIVE_DISABLE', undefined);
      setEnvVar('ROUTECODEX_LLMS_ROUTER_NATIVE_PATH', modulePath);
      const modNative = await importFresh('hub-chat-process-web-search-intent-native');
      assert.deepEqual(
        modNative.detectWebSearchIntent(buildRequest([{ role: 'user', content: 'not-a-search' }])),
        { hasIntent: true, googlePreferred: true }
      );
      assert.deepEqual(
        modNative.extractWebSearchSemantics({ providerExtras: { webSearch: false } }),
        { force: true }
      );
    }
  );

  await withTempModule(
    `exports.extractWebSearchSemanticsHintJson = () => JSON.stringify({});`,
    async (modulePath) => {
      setEnvVar('ROUTECODEX_LLMS_ROUTER_NATIVE_DISABLE', undefined);
      setEnvVar('ROUTECODEX_LLMS_ROUTER_NATIVE_PATH', modulePath);
      const modNative = await importFresh('hub-chat-process-web-search-intent-native-empty');
      assert.equal(modNative.extractWebSearchSemantics({ providerExtras: { webSearch: true } }), undefined);
    }
  );

  if (prevNativeDisable === undefined) {
    delete process.env.ROUTECODEX_LLMS_ROUTER_NATIVE_DISABLE;
  } else {
    process.env.ROUTECODEX_LLMS_ROUTER_NATIVE_DISABLE = prevNativeDisable;
  }
  if (prevNativePath === undefined) {
    delete process.env.ROUTECODEX_LLMS_ROUTER_NATIVE_PATH;
  } else {
    process.env.ROUTECODEX_LLMS_ROUTER_NATIVE_PATH = prevNativePath;
  }

  console.log('✅ coverage-hub-chat-process-web-search-intent passed');
}

main().catch((error) => {
  console.error('❌ coverage-hub-chat-process-web-search-intent failed:', error);
  process.exit(1);
});
