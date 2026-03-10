#!/usr/bin/env node
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..', '..');

async function loadBridge() {
  const responsesBridge = await import(
    pathToFileURL(path.join(repoRoot, 'dist', 'conversion', 'responses', 'responses-openai-bridge.js')).href
  );
  const requestAdapter = await import(
    pathToFileURL(path.join(repoRoot, 'dist', 'conversion', 'shared', 'responses-request-adapter.js')).href
  );
  return {
    buildResponsesRequestFromChat: responsesBridge.buildResponsesRequestFromChat,
    captureResponsesContext: requestAdapter.captureResponsesContext,
    buildChatRequestFromResponses: requestAdapter.buildChatRequestFromResponses
  };
}

function collectToolCallNames(messages) {
  const names = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    const toolCalls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
    for (const call of toolCalls) {
      const name = call?.function?.name;
      if (typeof name === 'string' && name.trim()) {
        names.push(name.trim());
      }
    }
  }
  return names;
}

function collectResponsesFunctionNames(input) {
  const names = [];
  for (const item of Array.isArray(input) ? input : []) {
    const name = item?.name;
    if (typeof name === 'string' && name.trim()) {
      names.push(name.trim());
    }
  }
  return names;
}

function hasCallId(input, callId) {
  return (Array.isArray(input) ? input : []).some((item) => item?.call_id === callId);
}

async function main() {
  const { captureResponsesContext, buildChatRequestFromResponses, buildResponsesRequestFromChat } = await loadBridge();

  const overlong = 'clock___action___schedule___items_____dueat___2026-03-06t14_52_18_000z___task___verifyservicestarted___tool___exec_command___arguments___________thecommandencountereda_processrunningwithsessionid_message_indicatingitisstillrunning_letmewaitandcheckagain___tool_calls_section_begin____tool_call_begin__functions_clock';
  assert.ok(overlong.length > 128, 'fixture must exceed OpenAI Responses function-name max length');

  const payload = {
    model: 'gpt-5.4',
    input: [
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'continue' }]
      },
      {
        type: 'function_call',
        id: 'fc_bad_1',
        call_id: 'call_bad_1',
        name: overlong,
        arguments: JSON.stringify({ action: 'schedule', items: [] })
      },
      {
        type: 'function_call_output',
        id: 'out_bad_1',
        call_id: 'call_bad_1',
        output: `unsupported call: ${overlong}`
      },
      {
        type: 'function_call',
        id: 'fc_ok_1',
        call_id: 'call_ok_1',
        name: 'exec_command',
        arguments: JSON.stringify({ cmd: 'pwd' })
      },
      {
        type: 'function_call_output',
        id: 'out_ok_1',
        call_id: 'call_ok_1',
        output: 'ok'
      }
    ]
  };

  const ctx = captureResponsesContext(payload, { route: { requestId: 'responses_overlong_function_name' } });
  const ctxNames = collectResponsesFunctionNames(ctx?.input);
  assert.ok(!ctxNames.includes(overlong), 'captured Responses context must not preserve overlong function names');
  assert.ok(ctxNames.includes('exec_command'), 'captured Responses context should keep valid function names');
  assert.ok(ctxNames.every((name) => name.length <= 128), 'captured Responses context must not contain overlong names');
  assert.equal(hasCallId(ctx?.input, 'call_bad_1'), false, 'captured Responses context must drop orphan outputs for removed calls');

  const { request: chatRequest } = buildChatRequestFromResponses(payload, ctx);
  const chatNames = collectToolCallNames(chatRequest?.messages);
  assert.ok(!chatNames.includes(overlong), 'overlong tool name must not survive Responses->Chat bridge');
  assert.ok(chatNames.includes('exec_command'), 'valid tool name should remain after bridge');
  assert.ok(chatNames.every((name) => name.length <= 128), 'chat tool_calls must not contain overlong names');

  const { request: responsesRequest } = buildResponsesRequestFromChat(chatRequest, ctx);
  const responseNames = collectResponsesFunctionNames(responsesRequest?.input);
  assert.ok(!responseNames.includes(overlong), 'overlong tool name must not survive roundtrip back to Responses');
  assert.ok(responseNames.includes('exec_command'), 'valid tool name should remain in roundtrip Responses payload');
  assert.ok(responseNames.every((name) => name.length <= 128), 'roundtrip Responses input must not contain overlong names');
  assert.equal(hasCallId(responsesRequest?.input, 'call_bad_1'), false, 'roundtrip Responses payload must not keep orphan outputs for removed calls');

  console.log('✅ responses overlong function name regression passed');
}

main().catch((err) => {
  console.error('❌ responses overlong function name regression failed:', err);
  process.exit(1);
});
