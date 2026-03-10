#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');

function resolveDistModule(...segments) {
  const modern = path.join(projectRoot, 'dist', ...segments);
  if (fs.existsSync(modern)) {
    return modern;
  }
  return path.join(projectRoot, ...segments);
}

async function main() {
  const mod = await import(
    pathToFileURL(
      resolveDistModule(
        'router',
        'virtual-router',
        'engine-selection',
        'native-chat-process-governance-semantics.js'
      )
    ).href
  );

  const { applyRespProcessToolGovernanceWithNative } = mod;
  assert.equal(
    typeof applyRespProcessToolGovernanceWithNative,
    'function',
    'applyRespProcessToolGovernanceWithNative should be exported'
  );

  const input = {
    payload: {
      id: 'chatcmpl_test',
      choices: [
        {
          finish_reason: 'stop',
          message: {
            role: 'assistant',
            tool_calls: [],
            content:
              '<function_calls>{"tool_calls":[{"id":"call_abc","type":"function","function":{"name":"shell_command","arguments":{"command":"pwd","cwd":"/tmp"}}}]}</function_calls>'
          }
        }
      ]
    },
    clientProtocol: 'anthropic-messages',
    entryEndpoint: '/v1/messages',
    requestId: 'req_native_resp_tool_harvest_1'
  };

  const output = applyRespProcessToolGovernanceWithNative(input);
  assert.equal(output.summary.toolCallsNormalized, 1, 'tool call should be harvested');

  const call = output.governedPayload?.choices?.[0]?.message?.tool_calls?.[0];
  assert.ok(call, 'harvested tool call should exist');
  assert.equal(call.function?.name, 'shell_command', 'shell_command should be preserved');
  assert.equal(output.governedPayload?.choices?.[0]?.finish_reason, 'tool_calls');

  const args = JSON.parse(call.function?.arguments || '{}');
  assert.equal(args.command, 'pwd');
  assert.equal(args.cwd, '/tmp');

  console.log('✅ native anthropic response tool harvest regression passed');
}

main().catch((error) => {
  console.error('❌ native anthropic response tool harvest regression failed:', error);
  process.exit(1);
});
