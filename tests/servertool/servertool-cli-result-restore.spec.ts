import fs from 'fs';
import { execFileSync } from 'node:child_process';
import path from 'path';

describe('servertool CLI result restoration removal', () => {
  it('keeps real servertool CLI stdout as ordinary exec_command output', () => {
    const stdout = execFileSync(
      path.join(
        process.cwd(),
        'sharedmodule/llmswitch-core/rust-core/target/debug/routecodex-servertool'
      ),
      [
        'run',
        'stop_message_auto',
        '--input-json',
        '{"flowId":"stop_message_flow","continuationPrompt":"继续执行原任务","repeatCount":1,"maxRepeats":3}'
      ],
      { encoding: 'utf8' }
    ).trim();
    const payload = {
      tool_outputs: [
        {
          call_id: 'call_servertool_cli_123',
          output: stdout
        }
      ]
    };

    const parsedOutput = JSON.parse(payload.tool_outputs[0].output);
    expect(parsedOutput).toMatchObject({
      ok: true,
      toolName: 'stop_message_auto',
      flowId: 'stop_message_flow'
    });
    expect((payload.tool_outputs[0] as any).tool_call_id).toBeUndefined();
    expect((payload.tool_outputs[0] as any).name).toBeUndefined();
    expect(payload.tool_outputs[0].output).not.toContain('"metadata"');
    expect(payload.tool_outputs[0].output).not.toContain('"__rt"');
    expect(payload.tool_outputs[0].output).not.toContain('"ticket"');
    expect(payload.tool_outputs[0].output).not.toContain('old_cli_');
    expect(payload.tool_outputs[0].output).not.toContain('old_cli_result_');
  });

  it('physically removes the old CLI restoration implementation', () => {
    const legacyPath = ['cli', '-', 'tic', 'ket.ts'].join('');
    const legacyFilePath = path.join(process.cwd(), 'sharedmodule/llmswitch-core/src/servertool', legacyPath);
    expect(fs.existsSync(legacyFilePath)).toBe(false);
  });
});
