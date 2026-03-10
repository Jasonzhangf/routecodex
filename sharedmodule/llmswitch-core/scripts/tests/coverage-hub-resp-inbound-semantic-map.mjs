#!/usr/bin/env node
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const moduleUrl = pathToFileURL(
  path.join(
    repoRoot,
    'dist',
    'conversion',
    'hub',
    'pipeline',
    'stages',
    'resp_inbound',
    'resp_inbound_stage3_semantic_map',
    'index.js'
  )
).href;

async function importFresh(tag) {
  return import(`${moduleUrl}?case=${tag}_${Date.now()}_${Math.random().toString(16).slice(2)}`);
}

async function main() {
  const mod = await importFresh('hub-resp-inbound-semantic-map');
  const { runRespInboundStage3SemanticMap } = mod;
  assert.equal(typeof runRespInboundStage3SemanticMap, 'function');

  {
    const mapped = await runRespInboundStage3SemanticMap({
      adapterContext: {
        requestId: 'resp_inbound_semantic_map_cov_1',
        providerProtocol: 'openai-chat'
      },
      formatEnvelope: {
        messages: [{ role: 'assistant', content: 'ok' }],
        metadata: {}
      },
      mapper: {
        toChatCompletion: async () => ({
          id: 'chatcmpl_1',
          object: 'chat.completion',
          choices: []
        })
      },
      requestSemantics: { hint: 'x' },
      stageRecorder: {
        record() {
          return undefined;
        }
      }
    });
    assert.equal(mapped.id, 'chatcmpl_1');
  }

  {
    const mapped = await runRespInboundStage3SemanticMap({
      adapterContext: {
        requestId: 'resp_inbound_semantic_map_cov_2',
        providerProtocol: 'openai-chat'
      },
      formatEnvelope: { messages: [], metadata: {} },
      mapper: {
        toChatCompletion: async () => ({
          id: 'chatcmpl_2',
          object: 'chat.completion',
          choices: 'invalid',
          usage: 'invalid'
        })
      }
    });
    assert.equal(mapped.choices, undefined);
    assert.equal(mapped.usage, undefined);
  }

  console.log('✅ coverage-hub-resp-inbound-semantic-map passed');
}

main().catch((error) => {
  console.error('❌ coverage-hub-resp-inbound-semantic-map failed:', error);
  process.exit(1);
});
