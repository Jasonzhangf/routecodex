#!/usr/bin/env node
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..', '..');

async function main() {
  const { applyGeminiWebSearchCompat } = await import(
    path.resolve(repoRoot, 'dist/conversion/compat/actions/gemini-web-search.js')
  );
  const { applyIflowToolTextFallbackWithNative } = await import(
    path.resolve(repoRoot, 'dist/native/router-hotpath/native-compat-action-semantics.js')
  );
  const { buildNativeReqOutboundCompatAdapterContext } = await import(
    path.resolve(repoRoot, 'dist/conversion/hub/pipeline/compat/native-adapter-context.js')
  );
  const PROFILE = 'chat:iflow';
  const DEFAULT_PROVIDER_PROTOCOL = 'openai-chat';
  const DEFAULT_ENTRY_ENDPOINT = '/v1/chat/completions';
  const buildIflowCompatContext = (adapterContext = {}) => {
    const nativeContext = buildNativeReqOutboundCompatAdapterContext(adapterContext);
    return {
      ...nativeContext,
      compatibilityProfile: PROFILE,
      providerProtocol:
        nativeContext.providerProtocol ??
        adapterContext.providerProtocol ??
        DEFAULT_PROVIDER_PROTOCOL,
      entryEndpoint:
        nativeContext.entryEndpoint ??
        adapterContext.entryEndpoint ??
        DEFAULT_ENTRY_ENDPOINT,
    };
  };
  const applyIflowToolTextFallback = (payload, adapterContext = {}) =>
    applyIflowToolTextFallbackWithNative(payload, buildIflowCompatContext(adapterContext), adapterContext.models ?? []);
  const applyIflowWebSearchRequestTransform = (payload, adapterContext = {}) => {
    const routeId = typeof adapterContext.routeId === 'string' ? adapterContext.routeId.trim().toLowerCase() : '';
    if (!(routeId === 'search' || routeId.startsWith('search/'))) {
      return payload;
    }
    const tools = Array.isArray(payload?.tools) ? payload.tools : [];
    const webSearchTool = tools.find((entry) => entry?.type === 'function' && entry?.function?.name === 'web_search');
    return {
      ...payload,
      tools: [
        webSearchTool ?? {
          type: 'function',
          function: {
            name: 'web_search',
            description: 'Perform a web search.',
            parameters: { type: 'object', additionalProperties: true }
          }
        }
      ],
      web_search: undefined
    };
  };

  // 1) Gemini: when routeId is "search", drop non-search tools.
  {
    const payload = {
      model: 'test',
      tools: [
        {
          functionDeclarations: [
            { name: 'exec_command', description: 'x', parameters: { type: 'object', additionalProperties: true } },
            { name: 'web_search', description: 'x', parameters: { type: 'object', additionalProperties: true } }
          ]
        },
        { googleSearch: { dynamicRetrievalConfig: { mode: 'MODE_DYNAMIC' } } }
      ]
    };
    const out = applyGeminiWebSearchCompat(payload, { routeId: 'search' });
    assert.ok(Array.isArray(out.tools), 'gemini: tools must exist');
    const toolEntries = out.tools;
    const names = [];
    for (const entry of toolEntries) {
      const decls = Array.isArray(entry?.functionDeclarations) ? entry.functionDeclarations : [];
      for (const fn of decls) {
        if (fn?.name) names.push(String(fn.name));
      }
      if (entry?.googleSearch) names.push('googleSearch');
    }
    assert.ok(!names.includes('exec_command'), 'gemini: must drop exec_command');
    assert.ok(names.includes('web_search') || names.includes('googleSearch'), 'gemini: must keep search tool');
  }

  // 2) iFlow: when routeId is "search", overwrite tools with a single web_search function tool.
  {
    const payload = {
      model: 'test',
      messages: [{ role: 'user', content: 'q' }],
      tools: [
        { type: 'function', function: { name: 'exec_command', parameters: { type: 'object' } } },
        { type: 'function', function: { name: 'web_search', parameters: { type: 'object' } } }
      ],
      web_search: { query: 'hello', recency: 'day', count: 3, engine: 'x' }
    };
    const out = applyIflowWebSearchRequestTransform(payload, { routeId: 'search' });
    assert.ok(Array.isArray(out.tools) && out.tools.length === 1, 'iflow: tools must be overwritten to 1 tool');
    assert.equal(out.tools[0]?.function?.name, 'web_search', 'iflow: tool must be web_search');
    assert.ok(out.web_search === undefined, 'iflow: helper field must be removed');
  }

  // 3) iFlow: model-gated fallback must not hijack web_search/search routes.
  {
    const payload = {
      model: 'minimax-m2.5',
      messages: [{ role: 'user', content: 'q' }],
      tools: [
        { type: 'function', function: { name: 'clock', parameters: { type: 'object' } } }
      ]
    };
    const out = applyIflowToolTextFallback(payload, {
      models: ['minimax-m2.5'],
      routeId: 'web_search-primary'
    });
    assert.ok(Array.isArray(out.tools) && out.tools.length === 1, 'iflow: web_search route must preserve tool surface');
    assert.equal(out.tools[0]?.function?.name, 'clock', 'iflow: preserved tool should remain unchanged');
    assert.equal(out.messages[0]?.role, 'user', 'iflow: must not inject fallback system instruction on web_search route');
  }

  console.log('[web-search-route-tools-clean] tests passed');
}

main().catch((e) => {
  console.error('❌ [web-search-route-tools-clean] failed', e);
  process.exit(1);
});
