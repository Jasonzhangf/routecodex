import { Command } from 'commander';
import { createServertoolCommand } from '../../src/cli/commands/servertool.js';

describe('servertool CLI command', () => {
  it('runs fixture executor through readable CLI input', async () => {
    const output: string[] = [];
    const errors: string[] = [];
    const program = new Command();
    program.exitOverride();
    createServertoolCommand(program, {
      log: (line) => output.push(line),
      error: (line) => errors.push(line),
      exit: (code) => {
        throw new Error(`unexpected exit ${code}`);
      }
    });

    await program.parseAsync([
      'node',
      'routecodex',
      'servertool',
      'run',
      'servertool_fixture',
      '--input-json',
      '{"marker":"cli-command-ok"}'
    ]);

    expect(errors).toEqual([]);
    expect(JSON.parse(output[0] ?? '{}')).toMatchObject({
      ok: true,
      kind: 'fixture',
      tool: 'servertool_fixture',
      result: { marker: 'cli-command-ok' }
    });
  });

  it('runs stopless executor through the same CLI namespace', async () => {
    const output: string[] = [];
    const errors: string[] = [];
    const program = new Command();
    program.exitOverride();
    createServertoolCommand(program, {
      log: (line) => output.push(line),
      error: (line) => errors.push(line),
      exit: (code) => {
        throw new Error(`unexpected exit ${code}`);
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
      ok: true,
      kind: 'stop_message_auto',
      tool: 'stop_message_auto',
      summary: 'continue',
      continuationPrompt: '继续执行原任务',
      repeatCount: 2,
      maxRepeats: 3,
      injectedPromptPreview: '继续执行原任务'
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
    expect(errors[0]).toContain('[servertool.cli] unsupported tool: web_search');
    expect(exits).toEqual([1]);
  });
});
