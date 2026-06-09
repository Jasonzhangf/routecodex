import { Command } from 'commander';
import path from 'node:path';
import { createServertoolCommand } from '../../src/cli/commands/servertool.js';

describe('servertool CLI command', () => {
  const originalServertoolBin = process.env.ROUTECODEX_SERVERTOOL_BIN;

  beforeEach(() => {
    process.env.ROUTECODEX_SERVERTOOL_BIN = path.join(
      process.cwd(),
      'sharedmodule/llmswitch-core/rust-core/target/debug/routecodex-servertool'
    );
  });

  afterEach(() => {
    if (originalServertoolBin === undefined) {
      delete process.env.ROUTECODEX_SERVERTOOL_BIN;
    } else {
      process.env.ROUTECODEX_SERVERTOOL_BIN = originalServertoolBin;
    }
  });

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

  it('passes explicit repeat flags through to the standalone Rust binary', async () => {
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
      '--repeat-count',
      '2',
      '--max-repeats',
      '5',
      '--input-json',
      '{"flowId":"stop_message_flow","continuationPrompt":"继续执行原任务","repeatCount":1,"maxRepeats":3}'
    ]);

    expect(errors).toEqual([]);
    const payload = JSON.parse(output[0] ?? '{}');
    expect(payload).toMatchObject({
      toolName: 'stop_message_auto',
      flowId: 'stop_message_flow',
      repeatCount: 2,
      maxRepeats: 5,
      input: {
        repeatCount: 1,
        maxRepeats: 3
      }
    });
  });

  it.each(['web_search', 'vision_auto', 'memory_cache_auto'])(
    'fails fast for non client-exec servertool %s',
    async (toolName) => {
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
        program.parseAsync(['node', 'routecodex', 'servertool', 'run', toolName, '--input-json', '{"query":"x"}'])
      ).rejects.toThrow('exit 1');

      expect(output).toEqual([]);
      expect(errors[0]).toContain(`SERVERTOOL_UNSUPPORTED_TOOL: ${toolName}`);
      expect(exits).toEqual([1]);
    }
  );

  it('runs servertool_fixture through the standalone Rust binary', async () => {
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
      'servertool_fixture',
      '--input-json',
      '{"value":1}'
    ]);

    expect(errors).toEqual([]);
    expect(JSON.parse(output[0] ?? '{}')).toMatchObject({
      ok: true,
      kind: 'servertool_fixture',
      tool: 'servertool_fixture',
      toolName: 'servertool_fixture',
      flowId: 'servertool_cli_projection',
      input: { value: 1 }
    });
  });

  it('fails fast for fake_exec tool name', async () => {
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
      program.parseAsync(['node', 'routecodex', 'servertool', 'run', 'fake_exec', '--input-json', '{"value":1}'])
    ).rejects.toThrow('exit 1');

    expect(output).toEqual([]);
    expect(errors[0]).toContain('SERVERTOOL_DENIED_TOOL: fake_exec');
    expect(exits).toEqual([1]);
  });

  it.each([
    ['--ticket abc', '--ticket'],
    ['stcli_123', 'stcli_'],
    ['rcc_cli_123', 'rcc_cli_'],
    ['old_cli_123', 'old_cli_'],
    ['old_cli_result_123', 'old_cli_']
  ])('fails fast when CLI input contains denied marker %s', async (rawValue, expectedMarker) => {
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
      program.parseAsync([
        'node',
        'routecodex',
        'servertool',
        'run',
        'servertool_fixture',
        '--input-json',
        JSON.stringify({ value: rawValue })
      ])
    ).rejects.toThrow('exit 1');

    expect(output).toEqual([]);
    expect(errors[0]).toContain(`SERVERTOOL_DENIED_CLI_MARKER: ${expectedMarker}`);
    expect(exits).toEqual([1]);
  });

  it('passes explicit flow to Rust and fails fast for denied flow marker', async () => {
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
      program.parseAsync([
        'node',
        'routecodex',
        'servertool',
        'run',
        'servertool_fixture',
        '--flow',
        'old_cli_123',
        '--input-json',
        '{"value":1}'
      ])
    ).rejects.toThrow('exit 1');

    expect(output).toEqual([]);
    expect(errors[0]).toContain('SERVERTOOL_DENIED_CLI_MARKER: old_cli_');
    expect(exits).toEqual([1]);
  });

  it('fails fast when CLI input contains internal RouteCodex carriers', async () => {
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
      program.parseAsync([
        'node',
        'routecodex',
        'servertool',
        'run',
        'servertool_fixture',
        '--input-json',
        '{"metadata":{"requestId":"req_internal"}}'
      ])
    ).rejects.toThrow('exit 1');

    expect(output).toEqual([]);
    expect(errors[0]).toContain('SERVERTOOL_DENIED_INTERNAL_CARRIER: metadata');
    expect(exits).toEqual([1]);
  });

  it('fails fast for non-object input JSON without client stdout', async () => {
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
      program.parseAsync([
        'node',
        'routecodex',
        'servertool',
        'run',
        'servertool_fixture',
        '--input-json',
        '"not-an-object"'
      ])
    ).rejects.toThrow('exit 1');

    expect(output).toEqual([]);
    expect(errors[0]).toContain('SERVERTOOL_CLI_INVALID_FIELD: inputJson');
    expect(exits).toEqual([1]);
  });
});
