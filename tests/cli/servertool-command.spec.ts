import { Command } from 'commander';
import { createServertoolCommand } from '../../src/cli/commands/servertool.js';

describe('servertool CLI command', () => {
  it('runs stopless through the standalone Rust binary', async () => {
    const output: string[] = [];
    const errors: string[] = [];
    const program = new Command();
    program.exitOverride();
    createServertoolCommand(program, {
      log: (line) => output.push(line),
      error: (line) => errors.push(line),
      exit: (code) => {
        throw new Error(`unexpected exit ${code}: ${errors.join('\n')}`);
      }
    });

    await program.parseAsync([
      'node',
      'routecodex',
      'servertool',
      'run',
      'stop_message_auto',
      '--input-json',
      '{"flowId":"stop_message_flow","stdoutPreview":"continue","continuationPrompt":"继续执行原任务","repeatCount":2,"maxRepeats":3}'
    ]);

    expect(errors).toEqual([]);
    expect(JSON.parse(output[0] ?? '{}')).toMatchObject({
      toolName: 'stop_message_auto',
      flowId: 'stop_message_flow',
      continuationPrompt: '继续执行原任务',
      repeatCount: 2,
      maxRepeats: 3,
      schemaGuidance: {
        stopreasonValues: {
          continueNeeded: 2
        }
      }
    });
  });

  it('fails fast for unsupported dispatcher executor', async () => {
    const output: string[] = [];
    const errors: string[] = [];
    const exits: number[] = [];
    const program = new Command();
    program.exitOverride();
    createServertoolCommand(program, {
      log: (line) => output.push(line),
      error: (line) => errors.push(line),
      exit: (code) => {
        exits.push(code);
        throw new Error(`exit ${code}`);
      }
    });

    await expect(
      program.parseAsync(['node', 'routecodex', 'servertool', 'run', 'web_search', '--input-json', '{"query":"x"}'])
    ).rejects.toThrow('exit 1');

    expect(output).toEqual([]);
    expect(errors[0]).toContain('SERVERTOOL_UNSUPPORTED_TOOL: web_search');
    expect(exits).toEqual([1]);
  });
});
