#!/usr/bin/env node
/**
 * Regression: /v1/responses tool loop must be resumable even when providerProtocol != openai-responses.
 *
 * Flow:
 * 1) captureResponsesRequestContext(requestId, ...)
 * 2) convertProviderResponse(... entryEndpoint:'/v1/responses' ...) produces a client outbound Responses payload
 * 3) recordResponsesResponse must index response.id so submit_tool_outputs can resume the conversation
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..', '..');

async function importModule(relativePath) {
  return import(path.resolve(repoRoot, 'dist', relativePath));
}

async function main() {
  const { captureResponsesRequestContext, resumeResponsesConversation } = await importModule(
    'conversion/shared/responses-conversation-store.js'
  );
  const { convertProviderResponse } = await importModule('conversion/hub/response/provider-response.js');

  const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const responseId = `chatcmpl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  captureResponsesRequestContext({
    requestId,
    payload: { model: 'gpt-5.2-codex', stream: true },
    context: {
      input: [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'text', text: 'run a command' }]
        }
      ],
      toolsRaw: [
        {
          type: 'function',
          name: 'exec_command',
          description: 'Run a shell command',
          parameters: { type: 'object', properties: { cmd: { type: 'string' } }, required: ['cmd'] }
        }
      ]
    }
  });

  const providerResponse = {
    id: responseId,
    object: 'chat.completion',
    model: 'unknown',
    choices: [
      {
        index: 0,
        finish_reason: 'stop',
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_test',
              type: 'function',
              function: {
                name: 'exec_command',
                arguments: JSON.stringify({ cmd: 'echo hello' })
              }
            }
          ]
        }
      }
    ]
  };

  const converted = await convertProviderResponse({
    providerProtocol: 'openai-chat',
    providerResponse,
    context: {
      requestId,
      entryEndpoint: '/v1/responses'
    },
    entryEndpoint: '/v1/responses',
    wantsStream: false
  });

  assert.ok(converted && typeof converted === 'object', 'expected conversion result');
  assert.ok(converted.body && typeof converted.body === 'object', 'expected non-stream JSON body');
  assert.equal(converted.body.object, 'response', 'expected Responses payload');
  assert.equal(converted.body.id, responseId, 'expected Responses response.id to match chat completion id');
  assert.equal(converted.body.status, 'requires_action', 'expected requires_action for client tool execution');
  assert.equal(
    converted.body.output?.[0]?.status,
    'in_progress',
    'expected function_call output.status=in_progress when requires_action'
  );
  assert.ok(
    converted.body.required_action?.submit_tool_outputs?.tool_calls?.length,
    'expected required_action.submit_tool_outputs.tool_calls'
  );

  const requiredCallId = converted.body.required_action.submit_tool_outputs.tool_calls[0].id;
  const resume = resumeResponsesConversation(
    responseId,
    {
      response_id: responseId,
      tool_outputs: [
        {
          tool_call_id: requiredCallId,
          output: 'ok'
        }
      ]
    },
    { requestId: `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}` }
  );

  assert.ok(resume && typeof resume === 'object', 'expected resume result');
  assert.ok(resume.payload && typeof resume.payload === 'object', 'expected resumed payload');
  assert.equal(resume.payload.previous_response_id, responseId, 'expected previous_response_id set');
  assert.ok(Array.isArray(resume.payload.input), 'expected resumed input array');
  const outputItem = resume.payload.input.find(
    (it) => it && typeof it === 'object' && it.type === 'function_call_output'
  );
  assert.ok(outputItem, 'expected function_call_output in resumed input');
  assert.equal(outputItem.call_id, requiredCallId, 'expected function_call_output.call_id to preserve tool_call_id');
  assert.ok(
    typeof outputItem.id === 'string' && outputItem.id.startsWith('fc_'),
    `expected function_call_output.id to start with fc_ (got ${String(outputItem.id)})`
  );

  // Regression: resume must not force-enable stream=true when the original request was non-streaming.
  {
    const requestId2 = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const responseId2 = `chatcmpl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    captureResponsesRequestContext({
      requestId: requestId2,
      payload: { model: 'gpt-5.2-codex', stream: false },
      context: {
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'text', text: 'run a command' }]
          }
        ],
        toolsRaw: [
          {
            type: 'function',
            name: 'exec_command',
            description: 'Run a shell command',
            parameters: { type: 'object', properties: { cmd: { type: 'string' } }, required: ['cmd'] }
          }
        ]
      }
    });

    const providerResponse2 = {
      id: responseId2,
      object: 'chat.completion',
      model: 'unknown',
      choices: [
        {
          index: 0,
          finish_reason: 'stop',
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_test_2',
                type: 'function',
                function: {
                  name: 'exec_command',
                  arguments: JSON.stringify({ cmd: 'echo hello' })
                }
              }
            ]
          }
        }
      ]
    };

    const converted2 = await convertProviderResponse({
      providerProtocol: 'openai-chat',
      providerResponse: providerResponse2,
      context: {
        requestId: requestId2,
        entryEndpoint: '/v1/responses'
      },
      entryEndpoint: '/v1/responses',
      wantsStream: false
    });

    const requiredCallId2 = converted2.body.required_action.submit_tool_outputs.tool_calls[0].id;
    const resume2 = resumeResponsesConversation(
      responseId2,
      {
        response_id: responseId2,
        tool_outputs: [
          {
            tool_call_id: requiredCallId2,
            output: 'ok'
          }
        ]
      },
      { requestId: `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}` }
    );

    assert.equal(resume2.payload.stream, false, 'expected resumed payload.stream to remain false');
  }

  console.log('✅ responses submit_tool_outputs resume regression passed');
}

main().catch((err) => {
  console.error('❌ responses submit_tool_outputs resume regression failed:', err);
  process.exit(1);
});
