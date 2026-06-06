import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  buildServertoolCliProjectionForAutoFlow,
  buildServertoolCliProjectionForToolCall
} from '../../sharedmodule/llmswitch-core/src/servertool/cli-projection.js';

describe('servertool CLI projection', () => {
  let tempHome: string;

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'rcc-stcli-projection-'));
    process.env.RCC_HOME = tempHome;
  });

  afterEach(() => {
    delete process.env.RCC_HOME;
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it('projects stopless auto flow to exec_command with reasoning and ticket', () => {
    const projection = buildServertoolCliProjectionForAutoFlow({
      options: {
        chatResponse: {},
        adapterContext: { sessionId: 'sess-1' } as any,
        entryEndpoint: '/v1/responses',
        requestId: 'req_stop_1',
        providerProtocol: 'openai-responses'
      },
      flowId: 'stop_message_flow',
      reasoningText: 'full stop summary',
      stdoutPreview: 'continue'
    });

    const message = (projection.chatResponse as any).choices[0].message;
    expect(message.reasoning_content).toBe('full stop summary');
    expect(message.tool_calls[0].function.name).toBe('exec_command');
    expect(JSON.parse(message.tool_calls[0].function.arguments).cmd).toBe(
      `routecodex servertool run --ticket ${projection.ticket.ticketId}`
    );
    expect(fs.existsSync(path.join(tempHome, 'servertool', 'tickets', `${projection.ticket.ticketId}.json`))).toBe(true);
  });

  it('projects basic servertool tool call without executing handler', () => {
    const projection = buildServertoolCliProjectionForToolCall({
      options: {
        chatResponse: {},
        adapterContext: {} as any,
        entryEndpoint: '/v1/responses',
        requestId: 'req_tool_1',
        providerProtocol: 'openai-responses'
      },
      toolCall: {
        id: 'call_model_1',
        name: 'servertool_fixture',
        arguments: '{"value":1}'
      }
    });

    expect(projection.ticket.modelTool).toMatchObject({ name: 'servertool_fixture', callId: 'call_model_1' });
    expect(projection.ticket.executor.kind).toBe('fixture');
    expect((projection.chatResponse as any).__servertool_cli_projection.clientCallId).toBe(projection.ticket.clientTool.callId);
  });
});
