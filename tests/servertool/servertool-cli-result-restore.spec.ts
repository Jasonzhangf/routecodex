import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  buildServertoolCliTicket,
  tryRestoreServertoolCliToolOutputs,
  writeServertoolCliTicket
} from '../../sharedmodule/llmswitch-core/src/servertool/cli-ticket.js';

describe('servertool CLI submit result restoration', () => {
  let tempHome: string;

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'rcc-stcli-restore-'));
    process.env.RCC_HOME = tempHome;
  });

  afterEach(() => {
    delete process.env.RCC_HOME;
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it('restores exec_command call id to original model tool identity', () => {
    const ticket = buildServertoolCliTicket({
      entryEndpoint: '/v1/responses',
      requestId: 'req_restore',
      sessionId: 'sess-restore',
      modelTool: { name: 'servertool_fixture', callId: 'call_model_restore' },
      executor: {
        kind: 'fixture',
        toolName: 'servertool_fixture',
        arguments: { ok: true }
      },
      presentation: {
        reasoningText: 'restore reasoning',
        stdoutPreview: 'restore stdout'
      }
    });
    writeServertoolCliTicket(ticket);

    const restored = tryRestoreServertoolCliToolOutputs(
      {
        tool_outputs: [
          {
            call_id: ticket.clientTool.callId,
            output: '{"ok":true}'
          }
        ]
      },
      { sessionId: 'sess-restore' }
    );

    expect(restored.restored).toBe(true);
    expect((restored.payload as any).tool_outputs).toEqual([
      {
        call_id: 'call_model_restore',
        tool_call_id: 'call_model_restore',
        name: 'servertool_fixture',
        output: '{"ok":true}'
      }
    ]);
  });

  it('fails fast when ticket scope mismatches', () => {
    const ticket = buildServertoolCliTicket({
      entryEndpoint: '/v1/responses',
      requestId: 'req_restore_mismatch',
      sessionId: 'sess-a',
      modelTool: { name: 'servertool_fixture', callId: 'call_model_mismatch' },
      executor: {
        kind: 'fixture',
        toolName: 'servertool_fixture',
        arguments: {}
      },
      presentation: {
        reasoningText: 'restore reasoning',
        stdoutPreview: 'restore stdout'
      }
    });
    writeServertoolCliTicket(ticket);

    expect(() =>
      tryRestoreServertoolCliToolOutputs(
        {
          tool_outputs: [{ call_id: ticket.clientTool.callId, output: 'ok' }]
        },
        { sessionId: 'sess-b' }
      )
    ).toThrow(/ticket scope mismatch/);
  });
});
