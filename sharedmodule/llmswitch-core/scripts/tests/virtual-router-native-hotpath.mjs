#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..', '..');

function requireNativeExport(binding, name) {
  const fn = binding?.[name];
  if (typeof fn !== 'function') {
    throw new Error(`${name} is not available`);
  }
  return fn;
}

function callJson(binding, name, ...args) {
  const fn = requireNativeExport(binding, name);
  const raw = fn(...args);
  if (typeof raw !== 'string' || !raw) {
    throw new Error(`${name} returned empty payload`);
  }
  return JSON.parse(raw);
}

async function main() {
  const { loadNativeRouterHotpathBinding } = await import(
    path.join(repoRoot, 'dist', 'native', 'router-hotpath', 'native-router-hotpath-loader.js')
  );
  const binding = loadNativeRouterHotpathBinding();

  const pending = callJson(
    binding,
    'analyzePendingToolSyncJson',
    JSON.stringify([{ role: 'assistant' }, { role: 'tool', tool_call_id: 'tc-1' }, { role: 'tool', toolCallId: 'tc-2' }]),
    JSON.stringify(['tc-1', 'tc-2'])
  );
  if (!pending.ready || pending.insertAt !== 2) {
    throw new Error(`pending sync analyze failed: ready=${String(pending.ready)} insertAt=${String(pending.insertAt)}`);
  }

  const continueInjection = callJson(
    binding,
    'analyzeContinueExecutionInjectionJson',
    JSON.stringify([{ role: 'user', content: '[routecodex:continue_execution_injection]\n继续执行' }]),
    '[routecodex:continue_execution_injection]',
    '继续执行'
  );
  if (!continueInjection.hasDirective) {
    throw new Error('continue execution injection analyze failed');
  }

  const media = callJson(
    binding,
    'analyzeChatProcessMediaJson',
    JSON.stringify([
      { role: 'user', content: [{ type: 'image_url', image_url: 'https://old.png' }] },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: [{ type: 'text', text: 'latest' }] }
    ])
  );
  if (!Array.isArray(media.stripIndices) || media.stripIndices[0] !== 0) {
    throw new Error(`chat process media strip analyze failed: ${JSON.stringify(media)}`);
  }
  if (media.containsCurrentTurnImage !== false) {
    throw new Error('chat process media current-turn image detect failed');
  }

  const webSearch = callJson(
    binding,
    'analyzeChatWebSearchIntentJson',
    JSON.stringify([
      { role: 'assistant', content: 'policy text about web search' },
      { role: 'user', content: '请帮我上网搜索今天的新闻' }
    ])
  );
  if (!webSearch.hasIntent || webSearch.googlePreferred !== false) {
    throw new Error(`chat web-search intent analyze failed: ${JSON.stringify(webSearch)}`);
  }

  console.log('[virtual-router-native-hotpath] ok source=native');
}

main().catch((error) => {
  console.error('[virtual-router-native-hotpath] failed', error);
  process.exit(1);
});
