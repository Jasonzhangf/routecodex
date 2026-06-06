import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  buildServertoolCliTicket,
  consumeServertoolCliTicket,
  tryRestoreServertoolCliToolOutputs,
  writeServertoolCliTicket
} from '../../sharedmodule/llmswitch-core/src/servertool/cli-ticket.js';
import { executeServertoolCliTicket } from '../../sharedmodule/llmswitch-core/src/servertool/cli-executor.js';

describe('servertool CLI execution ticket flow', () => {
  let tempHome: string;

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'rcc-stcli-exec-'));
    process.env.RCC_HOME = tempHome;
  });

  afterEach(() => {
    delete process.env.RCC_HOME;
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it('executes fixture ticket and keeps ticket available for submit restoration', async () => {
    const ticket = buildServertoolCliTicket({
      entryEndpoint: '/v1/responses',
      requestId: 'req_1',
      modelTool: { name: 'servertool_fixture', callId: 'call_model_1' },
      executor: {
        kind: 'fixture',
        toolName: 'servertool_fixture',
        arguments: { value: 1 }
      },
      presentation: {
        reasoningText: 'fixture reasoning',
        stdoutPreview: 'fixture stdout'
      }
    });
    writeServertoolCliTicket(ticket);

    await expect(executeServertoolCliTicket(ticket.ticketId)).resolves.toMatchObject({
      ok: true,
      kind: 'fixture',
      tool: 'servertool_fixture'
    });

    const restored = tryRestoreServertoolCliToolOutputs({
      tool_outputs: [{ call_id: ticket.clientTool.callId, output: '{"ok":true}' }]
    });
    expect(restored.restored).toBe(true);
    expect((restored.payload as any).tool_outputs[0]).toMatchObject({
      call_id: 'call_model_1',
      tool_call_id: 'call_model_1',
      name: 'servertool_fixture'
    });
  });

  it('consumes tickets once and rejects reuse', () => {
    const ticket = buildServertoolCliTicket({
      entryEndpoint: '/v1/responses',
      requestId: 'req_2',
      modelTool: { name: 'stop_message_flow', callId: 'call_stop_1', synthetic: true },
      executor: {
        kind: 'stop_message_auto',
        toolName: 'stop_message_flow',
        arguments: {}
      },
      presentation: {
        reasoningText: 'stop reasoning',
        stdoutPreview: 'continue'
      }
    });
    writeServertoolCliTicket(ticket);

    expect(consumeServertoolCliTicket({ ticketId: ticket.ticketId, clientCallId: ticket.clientTool.callId })).toMatchObject({
      ticketId: ticket.ticketId
    });
    expect(() => consumeServertoolCliTicket({ ticketId: ticket.ticketId, clientCallId: ticket.clientTool.callId })).toThrow(
      /ticket read failed/
    );
  });

  it('fails fast for unsupported executor', async () => {
    const ticket = buildServertoolCliTicket({
      entryEndpoint: '/v1/responses',
      requestId: 'req_3',
      modelTool: { name: 'web_search', callId: 'call_model_3' },
      executor: {
        kind: 'web_search',
        toolName: 'web_search',
        arguments: { query: 'x' }
      },
      presentation: {
        reasoningText: 'web search reasoning',
        stdoutPreview: 'web search'
      }
    });
    writeServertoolCliTicket(ticket);

    await expect(executeServertoolCliTicket(ticket.ticketId)).rejects.toThrow(/unsupported executor/);
  });
});
