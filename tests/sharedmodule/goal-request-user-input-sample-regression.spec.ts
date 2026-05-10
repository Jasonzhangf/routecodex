import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from '@jest/globals';
import { __requestExecutorTestables } from '../../src/server/runtime/http-server/request-executor.js';

const FIXTURE_DIR = path.join(
  process.cwd(),
  'tests',
  'fixtures',
  'goal-request-user-input-real-samples'
);

function readJson(fileName: string): Record<string, any> {
  return JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, fileName), 'utf8')) as Record<string, any>;
}

describe('goal request_user_input real sample regression', () => {
  test('captured codex sample shows flattened request_user_input schema before fix', () => {
    const requestDoc = readJson('provider-request.goal.flattened-before-fix.json');

    const tools = requestDoc?.body?.tools;
    expect(Array.isArray(tools)).toBe(true);

    const requestUserInput = tools.find((tool: any) => tool?.name === 'request_user_input');
    expect(requestUserInput).toBeDefined();
    expect(requestUserInput.input_schema?.properties?.questions?.items).toEqual({ type: 'object' });
    expect(requestUserInput.input_schema?.properties?.questions?.items?.properties).toBeUndefined();
  });

  test('captured codex sample after fix preserves nested request_user_input shape', () => {
    const requestDoc = readJson('provider-request.goal.nested-after-fix.json');

    const tools = requestDoc?.body?.tools;
    expect(Array.isArray(tools)).toBe(true);

    const requestUserInput = tools.find((tool: any) => tool?.function?.name === 'request_user_input');
    expect(requestUserInput).toBeDefined();

    const schema = requestUserInput?.function?.parameters;
    expect(schema?.required).toEqual(['questions']);
    expect(schema?.properties?.questions?.type).toBe('array');
    expect(schema?.properties?.questions?.items?.type).toBe('object');
    expect(schema?.properties?.questions?.items?.required).toEqual(['id', 'header', 'question', 'options']);
    expect(Object.keys(schema?.properties?.questions?.items?.properties ?? {}).sort()).toEqual([
      'header',
      'id',
      'options',
      'question'
    ]);
    expect(
      Object.keys(
        schema?.properties?.questions?.items?.properties?.options?.items?.properties ?? {}
      ).sort()
    ).toEqual(['description', 'label']);
  });

  test('captured errorsample preserves reasoning-only missing-tool-call shape', () => {
    const sample = readJson('errorsample.responses-missing-required-tool-call.json');
    expect(sample.marker).toBe('responses_missing_required_tool_call');

    const convertedBody = sample?.observation?.convertedResponse?.body;
    const signal = __requestExecutorTestables.detectRetryableEmptyAssistantResponse(
      convertedBody,
      {
        tools: {
          clientToolsRaw: [
            {
              type: 'function',
              function: { name: 'exec_command' }
            }
          ]
        }
      }
    );

    expect(signal).toEqual({
      marker: 'responses_missing_required_tool_call',
      reason: 'responses status=completed with declared request tools but no function_call output'
    });
  });

  test('captured deepseek-web malformed tool wrapper sample fails as missing required tool call', () => {
    const sample = JSON.parse(
      fs.readFileSync(
        '/Volumes/extension/.rcc/codex-samples/openai-responses/deepseek-web.3.deepseek-v4-flash-search/req_1778378853967_3f0a1f6c/provider-response_1.json',
        'utf8'
      )
    ) as Record<string, any>;

    const signal = __requestExecutorTestables.detectRetryableEmptyAssistantResponse(
      {
        __sse_responses: true,
        __routecodex_finish_reason: 'stop',
        __routecodex_stream_contract_probe_body: {
          status: 'completed',
          output_text: sample?.body?.raw ?? sample?.raw ?? '',
          output: [
            {
              type: 'message',
              role: 'assistant',
              content: [
                {
                  type: 'output_text',
                  text: sample?.body?.raw ?? sample?.raw ?? ''
                }
              ]
            }
          ]
        }
      },
      {
        tools: {
          clientToolsRaw: [
            {
              type: 'function',
              function: { name: 'exec_command' }
            }
          ]
        }
      }
    );

    expect(signal).toEqual({
      marker: 'responses_missing_required_tool_call',
      reason: 'responses status=completed with declared request tools but no function_call output'
    });
  });

  test('captured chat empty assistant errorsample still classifies as chat_empty_assistant', () => {
    const sample = readJson('errorsample.chat-empty-assistant.json');
    expect(sample.marker).toBe('chat_empty_assistant');

    const convertedBody = sample?.observation?.convertedResponse?.body;
    const signal = __requestExecutorTestables.detectRetryableEmptyAssistantResponse(convertedBody);

    expect(signal).toEqual({
      marker: 'chat_empty_assistant',
      reason: 'finish_reason=stop but assistant text/tool_calls are empty'
    });
  });
});
