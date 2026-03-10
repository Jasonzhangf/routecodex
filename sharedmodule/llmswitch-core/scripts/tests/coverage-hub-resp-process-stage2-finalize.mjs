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
    'resp_process',
    'resp_process_stage2_finalize',
    'index.js'
  )
).href;

async function importFresh(tag) {
  return import(`${moduleUrl}?case=${tag}_${Date.now()}_${Math.random().toString(16).slice(2)}`);
}

async function main() {
  const mod = await importFresh('hub-resp-process-stage2-finalize');
  const { runRespProcessStage2Finalize } = mod;
  assert.equal(typeof runRespProcessStage2Finalize, 'function');

  const result = await runRespProcessStage2Finalize({
    payload: {
      id: 'chatcmpl_1',
      model: 'gpt-native',
      choices: [
        {
          finish_reason: 'stop',
          message: {
            content: 'done',
            reasoning_content: 'internal chain',
            tool_calls: [
              {
                id: 'call_1',
                function: {
                  name: 'exec_command',
                  arguments: { cmd: 'pwd' }
                }
              }
            ]
          }
        }
      ],
      usage: { completion_tokens: 12 }
    },
    entryEndpoint: '/v1/chat/completions',
    requestId: 'resp_process_stage2_finalize_cov',
    wantsStream: false,
    reasoningMode: 'append_to_content'
  });

  assert.equal(result.finalizedPayload.choices[0].finish_reason, 'tool_calls');
  assert.equal(typeof result.finalizedPayload.choices[0].message.tool_calls[0].function.arguments, 'string');
  assert.equal(result.finalizedPayload.choices[0].message.reasoning_content, undefined);
  assert.equal(
    String(result.finalizedPayload.choices[0].message.content).includes('internal chain'),
    true
  );
  assert.equal(result.processedRequest.model, 'gpt-native');
  assert.equal(Array.isArray(result.processedRequest.messages), true);
  assert.equal(result.processedRequest.messages.length > 0, true);

  console.log('✅ coverage-hub-resp-process-stage2-finalize passed');
}

main().catch((error) => {
  console.error('❌ coverage-hub-resp-process-stage2-finalize failed:', error);
  process.exit(1);
});
