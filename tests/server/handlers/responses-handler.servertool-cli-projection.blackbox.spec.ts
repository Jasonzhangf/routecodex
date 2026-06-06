import fs from 'fs';
import os from 'os';
import path from 'path';
import { runServerToolOrchestration } from '../../../sharedmodule/llmswitch-core/src/servertool/engine.js';

describe('servertool CLI projection blackbox', () => {
  let tempHome: string;

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'rcc-stcli-blackbox-'));
    process.env.RCC_HOME = tempHome;
  });

  afterEach(() => {
    delete process.env.RCC_HOME;
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it('returns exec_command projection and does not reenter for intercepted servertool call', async () => {
    let reenterCount = 0;
    const reenterPipeline = async () => {
      reenterCount += 1;
      return { body: {} };
    };
    const result = await runServerToolOrchestration({
      chat: {
        id: 'chatcmpl_stcli_blackbox',
        object: 'chat.completion',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [
                {
                  id: 'call_model_blackbox',
                  type: 'function',
                  function: {
                    name: 'servertool_fixture',
                    arguments: '{"value":1}'
                  }
                }
              ]
            },
            finish_reason: 'tool_calls'
          }
        ]
      },
      adapterContext: { sessionId: 'sess-blackbox' } as any,
      requestId: 'req_stcli_blackbox',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses',
      reenterPipeline
    });

    expect(reenterCount).toBe(0);
    expect(result.executed).toBe(true);
    const toolCall = (result.chat as any).choices[0].message.tool_calls[0];
    expect(toolCall.function.name).toBe('exec_command');
    expect(JSON.parse(toolCall.function.arguments).cmd).toMatch(/^routecodex servertool run --ticket stcli_/);
  });
});
