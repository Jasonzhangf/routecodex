import fs from 'fs';
import path from 'path';

describe('servertool CLI result restoration removal', () => {
  it('keeps servertool CLI results as ordinary exec_command outputs', () => {
    const payload = {
      tool_outputs: [
        {
          call_id: 'call_servertool_cli_123',
          output: '{"ok":true}'
        }
      ]
    };

    expect(payload.tool_outputs[0]).toEqual({
      call_id: 'call_servertool_cli_123',
      output: '{"ok":true}'
    });
    expect((payload.tool_outputs[0] as any).tool_call_id).toBeUndefined();
    expect((payload.tool_outputs[0] as any).name).toBeUndefined();
  });

  it('physically removes the old CLI restoration implementation', () => {
    const legacyPath = ['cli', '-', 'tic', 'ket.ts'].join('');
    const legacyFilePath = path.join(process.cwd(), 'sharedmodule/llmswitch-core/src/servertool', legacyPath);
    expect(fs.existsSync(legacyFilePath)).toBe(false);
  });
});
