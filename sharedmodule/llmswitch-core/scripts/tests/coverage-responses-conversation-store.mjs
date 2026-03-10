#!/usr/bin/env node

import assert from 'node:assert/strict';

function expectProtocolReason(error, reason) {
  assert.equal(error?.name, 'ProviderProtocolError');
  assert.equal(error?.details?.reason, reason);
}

async function main() {
  const {
    captureResponsesRequestContext,
    recordResponsesResponse,
    resumeResponsesConversation,
    clearResponsesConversationByRequestId
  } = await import('../../dist/conversion/shared/responses-conversation-store.js');

  const requestId = `req_cov_${Date.now()}`;
  const responseId = `resp_cov_${Date.now()}`;

  captureResponsesRequestContext({
    requestId,
    payload: {
      model: 'gpt-base',
      stream: true,
      metadata: { origin: 'capture', keep: 'base' },
      tools: [{ type: 'function', function: { name: 'fallback_tool' } }]
    },
    context: {
      input: [{ type: 'message', role: 'user', content: [{ type: 'text', text: 'hello' }] }],
      toolsRaw: [{ type: 'function', function: { name: 'exec_command' } }]
    }
  });

  recordResponsesResponse({
    requestId,
    response: {
      id: responseId,
      output: [
        {
          type: 'function_call',
          id: 'fc_item_1',
          call_id: 'call_1',
          name: 'exec_command',
          arguments: '{"cmd":"pwd"}'
        }
      ]
    }
  });

  const resumed = resumeResponsesConversation(
    responseId,
    {
      metadata: { resumed: true },
      tool_outputs: [
        {
          call_id: 'call_1',
          output: {
            cmd: 'pwd',
            nested: { lines: ['a\\n', 'b"q'] }
          }
        }
      ]
    },
    { requestId: 'req_resume_cov' }
  );

  assert.equal(resumed.payload.model, 'gpt-base');
  assert.equal(resumed.payload.stream, true);
  assert.deepEqual(resumed.payload.metadata, { origin: 'capture', keep: 'base', resumed: true });
  assert.deepEqual(resumed.payload.tools, [{ type: 'function', function: { name: 'exec_command' } }]);
  assert.equal(resumed.payload.previous_response_id, responseId);
  assert.ok(Array.isArray(resumed.payload.input));

  const outputItem = resumed.payload.input.at(-1);
  assert.equal(outputItem.type, 'function_call_output');
  assert.equal(outputItem.call_id, 'call_1');
  assert.equal(outputItem.id, 'fc_item_1');
  assert.equal(
    outputItem.output,
    JSON.stringify({ cmd: 'pwd', nested: { lines: ['a\\n', 'b"q'] } })
  );

  assert.equal(resumed.meta.restoredFromResponseId, responseId);
  assert.equal(resumed.meta.previousRequestId, requestId);
  assert.equal(resumed.meta.toolOutputs, 1);
  assert.equal(resumed.meta.requestId, 'req_resume_cov');

  {
    const fs = await import('node:fs/promises');
    const responsesBridge = await import('../../dist/conversion/responses/responses-openai-bridge.js');
    const fixture = JSON.parse(
      await fs.readFile('./tests/fixtures/codex-samples/openai-responses/sample_provider-request.json', 'utf8')
    ).data.body;
    const ctx = responsesBridge.captureResponsesContext(fixture, { route: { requestId: 'conv-store-media-order' } });
    const { request: chatRequest } = responsesBridge.buildChatRequestFromResponses(fixture, ctx);
    const { request: roundtrip } = responsesBridge.buildResponsesRequestFromChat(chatRequest, ctx);
    assert.deepEqual(
      roundtrip.input[0].content,
      fixture.input[0].content,
      'mixed input_image/input_text content order must roundtrip intact'
    );
  }

  {
    const fs = await import('node:fs/promises');
    const responsesBridge = await import('../../dist/conversion/responses/responses-openai-bridge.js');
    const chatFixture = JSON.parse(
      await fs.readFile('./tests/fixtures/codex-samples/openai-chat/sample_provider-request.json', 'utf8')
    ).data.body;
    const { request: responsesReq, originalSystemMessages } = responsesBridge.buildResponsesRequestFromChat(chatFixture);
    const ctx = responsesBridge.captureResponsesContext(responsesReq, { route: { requestId: 'conv-store-exec-result' } });
    if (Array.isArray(originalSystemMessages) && originalSystemMessages.length) {
      ctx.originalSystemMessages = originalSystemMessages;
    }
    const { request: chatRoundtrip } = responsesBridge.buildChatRequestFromResponses(responsesReq, ctx);
    const toolMessage = chatRoundtrip.messages.find((entry) => entry && entry.role === 'tool');
    assert.ok(toolMessage, 'expected tool message after responses -> chat roundtrip');
    assert.equal(toolMessage.tool_call_id, 'call_demo_exec');
    assert.equal(toolMessage.content, 'total 8\n-rw-r--r--  focus.md\n-rw-r--r--  README.md');
  }

  {
    const responsesBridge = await import('../../dist/conversion/responses/responses-openai-bridge.js');
    const chatFixture = {
      model: 'glm-4.7',
      stream: false,
      messages: [
        { role: 'system', content: 'You are Codex, a local coding agent.' },
        { role: 'user', content: '列出 workspace 根目录文件' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_demo_exec',
              type: 'function',
              function: {
                name: 'exec_command',
                arguments: JSON.stringify({ cmd: 'ls -la', workdir: '/Users/example/project' })
              }
            }
          ]
        },
        {
          role: 'tool',
          tool_call_id: 'call_demo_exec',
          content: JSON.stringify({
            status: 'completed',
            stdout: 'total 8\n-rw-r--r--  focus.md\n-rw-r--r--  README.md',
            exit_code: 0,
            result: {
              cwd: '/Users/example/project',
              lines: ['focus.md', 'README.md']
            }
          })
        }
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'exec_command',
            description: 'Runs a shell command inside the workspace.',
            parameters: {
              type: 'object',
              properties: { cmd: { type: 'string' }, workdir: { type: 'string' } },
              required: ['cmd']
            }
          }
        }
      ]
    };

    const { request: responsesReq, originalSystemMessages } = responsesBridge.buildResponsesRequestFromChat(chatFixture);
    const originalOutput = responsesReq.input.find((entry) => entry?.type === 'function_call_output');
    assert.ok(originalOutput, 'expected original function_call_output in responses request');
    const parsedOriginalOutput = JSON.parse(originalOutput.output);
    assert.equal(parsedOriginalOutput.status, 'completed');
    assert.deepEqual(parsedOriginalOutput.result, {
      cwd: '/Users/example/project',
      lines: ['focus.md', 'README.md']
    });

    const ctx = responsesBridge.captureResponsesContext(responsesReq, { route: { requestId: 'conv-store-exec-structured' } });
    if (Array.isArray(originalSystemMessages) && originalSystemMessages.length) {
      ctx.originalSystemMessages = originalSystemMessages;
    }
    const { request: chatRoundtrip } = responsesBridge.buildChatRequestFromResponses(responsesReq, ctx);
    const structuredToolMessage = chatRoundtrip.messages.find((entry) => entry && entry.role === 'tool');
    assert.ok(structuredToolMessage, 'expected structured tool message after roundtrip');
    assert.equal(structuredToolMessage.tool_call_id, 'call_demo_exec');
    assert.deepEqual(JSON.parse(structuredToolMessage.content), parsedOriginalOutput);

    const { request: responsesRoundtrip } = responsesBridge.buildResponsesRequestFromChat(chatRoundtrip, ctx);
    const roundtripOutput = responsesRoundtrip.input.find((entry) => entry?.type === 'function_call_output');
    assert.ok(roundtripOutput, 'expected function_call_output after chat -> responses rebuild');
    assert.equal(roundtripOutput.call_id, 'call_demo_exec');
    assert.deepEqual(JSON.parse(roundtripOutput.output), parsedOriginalOutput);
    assert.equal(JSON.parse(roundtripOutput.output).result.cwd, '/Users/example/project');
    assert.deepEqual(JSON.parse(roundtripOutput.output).result.lines, ['focus.md', 'README.md']);
  }

  assert.throws(
    () => resumeResponsesConversation('', { tool_outputs: [{ call_id: 'call_1', output: 'x' }] }),
    (error) => {
      expectProtocolReason(error, 'missing_or_empty_response_id');
      return true;
    }
  );

  assert.throws(
    () => resumeResponsesConversation('resp_missing_cov', { tool_outputs: [{ call_id: 'call_1', output: 'x' }] }),
    (error) => {
      expectProtocolReason(error, 'expired_or_unknown_response_id');
      return true;
    }
  );

  const requestIdMissingOutputs = `req_cov_missing_outputs_${Date.now()}`;
  const responseIdMissingOutputs = `resp_cov_missing_outputs_${Date.now()}`;
  captureResponsesRequestContext({
    requestId: requestIdMissingOutputs,
    payload: { model: 'gpt-base' },
    context: { input: [] }
  });
  recordResponsesResponse({
    requestId: requestIdMissingOutputs,
    response: { id: responseIdMissingOutputs, output: [] }
  });
  assert.throws(
    () => resumeResponsesConversation(responseIdMissingOutputs, {}),
    (error) => {
      expectProtocolReason(error, 'missing_tool_outputs');
      return true;
    }
  );

  clearResponsesConversationByRequestId(requestId);
  clearResponsesConversationByRequestId(requestIdMissingOutputs);

  console.log('✅ coverage-responses-conversation-store passed');
}

main().catch((error) => {
  console.error('❌ coverage-responses-conversation-store failed:', error);
  process.exit(1);
});
