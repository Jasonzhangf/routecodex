import { Command } from 'commander';
import fs from 'node:fs';
import path from 'node:path';
import { createServertoolCommand } from '../../src/cli/commands/servertool.js';

describe('servertool CLI command', () => {
  const originalServertoolBin = process.env.ROUTECODEX_SERVERTOOL_BIN;
  const originalSessionDir = process.env.ROUTECODEX_SESSION_DIR;
  const originalCodexThreadId = process.env.CODEX_THREAD_ID;
  const forbiddenStdoutMarkers = [
    '"metadata"',
    '"__rt"',
    '"snapshot"',
    '"debug"',
    '"debugCarrier"',
    '"ticket"',
    '"restorationHandle"',
    '"restorationStore"',
    'reenterPipeline',
    'providerInvoker',
    '--ticket',
    'stcli_',
    'rcc_cli_',
    'old_cli_',
    'old_cli_result_'
  ];

  function expectNoPrivateServertoolCarrier(raw: string): void {
    for (const marker of forbiddenStdoutMarkers) {
      expect(raw).not.toContain(marker);
    }
  }

  beforeEach(() => {
    process.env.ROUTECODEX_SERVERTOOL_BIN = path.join(
      process.cwd(),
      'sharedmodule/llmswitch-core/rust-core/target/debug/routecodex-servertool'
    );
    const isolatedDir = path.join(
      process.cwd(),
      '.tmp',
      'jest-cli-servertool',
      `${Date.now()}-${Math.random().toString(16).slice(2)}`
    );
    fs.mkdirSync(isolatedDir, { recursive: true });
    process.env.ROUTECODEX_SESSION_DIR = isolatedDir;
    process.env.CODEX_THREAD_ID = `jest-servertool-cli-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  });

  function uniqueStoplessIdentity(): { sessionId: string; requestId: string } {
    const unique = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    return {
      sessionId: `session-stopless-cli-${unique}`,
      requestId: `req-stopless-cli-${unique}`
    };
  }

  afterEach(() => {
    if (originalServertoolBin === undefined) {
      delete process.env.ROUTECODEX_SERVERTOOL_BIN;
    } else {
      process.env.ROUTECODEX_SERVERTOOL_BIN = originalServertoolBin;
    }
    if (originalSessionDir === undefined) {
      delete process.env.ROUTECODEX_SESSION_DIR;
    } else {
      process.env.ROUTECODEX_SESSION_DIR = originalSessionDir;
    }
    if (originalCodexThreadId === undefined) {
      delete process.env.CODEX_THREAD_ID;
    } else {
      process.env.CODEX_THREAD_ID = originalCodexThreadId;
    }
  });

  it('runs V3 reasoningStop hook as no-input no-op without state stdout', async () => {
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

    await program.parseAsync(['node', 'routecodex', 'hook', 'run', 'reasoningStop']);

    expect(errors).toEqual([]);
    expect(output).toEqual([]);
  });

  it('rejects V3 reasoningStop hook input-json envelopes', async () => {
    const output: string[] = [];
    const errors: string[] = [];
    const program = new Command();
    program.exitOverride();
    createServertoolCommand(program, {
      log: (line) => output.push(line),
      error: (line) => errors.push(line),
      exit: (code) => {
        throw new Error(`expected exit ${code}`);
      }
    });

    await expect(program.parseAsync([
      'node',
      'routecodex',
      'hook',
      'run',
      'reasoningStop',
      '--input-json',
      '{}'
    ])).rejects.toThrow('expected exit 1');

    expect(output).toEqual([]);
    expect(errors.join('\n')).toContain('reasoningStop is a no-input no-op hook');
  });

  it('runs stopless through the standalone Rust binary', async () => {
    const { sessionId, requestId } = uniqueStoplessIdentity();
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
      '--session-id',
      sessionId,
      '--request-id',
      requestId,
      '--input-json',
      '{"flowId":"stop_message_flow","repeatCount":2,"maxRepeats":3}'
    ]);

    expect(errors).toEqual([]);
    expectNoPrivateServertoolCarrier(output[0] ?? '');
    const payload = JSON.parse(output[0] ?? '{}');
    expect(payload).toMatchObject({
      toolName: 'stop_message_auto',
      flowId: 'stop_message_flow',
      repeatCount: 2,
      maxRepeats: 3
    });
    expect(payload.sessionId).toBe(sessionId);
    expect(payload.requestId).toBe(requestId);
    expect(typeof payload.continuationPrompt).toBe('string');
    expect(payload.continuationPrompt.length).toBeGreaterThan(0);
    expect(payload.modelGuidance).toBeUndefined();
    expect(payload.schemaGuidance).toBeUndefined();
    for (const forbidden of [
      'schema',
      'hook',
      'stopless',
      'servertool',
      '第一轮',
      '第二轮',
      '第三轮',
      '必须调用',
      '证据不足',
      '用户目标',
      '已排除因素',
      '排查顺序'
    ]) {
      expect(String(payload.continuationPrompt ?? '')).not.toContain(forbidden);
    }
  });

  it('runs stopless CLI with explicit session identity flags', async () => {
    const { sessionId, requestId } = uniqueStoplessIdentity();
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
      '--session-id',
      sessionId,
      '--request-id',
      requestId,
      '--input-json',
      '{"flowId":"stop_message_flow","repeatCount":1,"maxRepeats":3}'
    ]);

    expect(errors).toEqual([]);
    const payload = JSON.parse(output[0] ?? '{}');
    expect(payload.repeatCount).toBe(1);
    expect(payload.sessionId).toBe(sessionId);
    expect(payload.requestId).toBe(requestId);
  });

  it('passes explicit repeat flags through to the standalone Rust binary', async () => {
    const { sessionId, requestId } = uniqueStoplessIdentity();
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
      '--session-id',
      sessionId,
      '--request-id',
      requestId,
      '--repeat-count',
      '2',
      '--max-repeats',
      '5',
      '--input-json',
      '{"flowId":"stop_message_flow","repeatCount":1,"maxRepeats":3}'
    ]);

    expect(errors).toEqual([]);
    const payload = JSON.parse(output[0] ?? '{}');
    expectNoPrivateServertoolCarrier(output[0] ?? '');
    expect(payload).toMatchObject({
      toolName: 'stop_message_auto',
      flowId: 'stop_message_flow',
      repeatCount: 2,
      maxRepeats: 5,
      input: {
        repeatCount: 2,
        maxRepeats: 5
      }
    });
    expect(payload.sessionId).toBe(sessionId);
    expect(payload.requestId).toBe(requestId);
    expect(typeof payload.continuationPrompt).toBe('string');
    expect(payload.continuationPrompt.length).toBeGreaterThan(0);
    expect(payload.modelGuidance).toBeUndefined();
    expect(payload.schemaGuidance).toBeUndefined();
    for (const forbidden of [
      'schema',
      'hook',
      'stopless',
      'servertool',
      '第一轮',
      '第二轮',
      '第三轮',
      '必须调用',
      '证据不足',
      '用户目标',
      '已排除因素',
      '排查顺序'
    ]) {
      expect(String(payload.continuationPrompt ?? '')).not.toContain(forbidden);
    }
  });

  it('exposes second-round missing-schema guidance in visible CLI payload', async () => {
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
      JSON.stringify({
        flowId: 'stop_message_flow',
        repeatCount: 2,
        maxRepeats: 3,
        schemaFeedback: {
          reasonCode: 'stop_schema_missing',
          missingFields: ['stopreason', 'reason', 'next_step']
        }
      })
    ]);

    expect(errors).toEqual([]);
    const payload = JSON.parse(output[0] ?? '{}');
    expect(payload.modelGuidance).toBeUndefined();
    expect(payload.schemaGuidance).toBeUndefined();
  });

  it('expands terminal missing fields into per-field repair guidance', async () => {
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
      JSON.stringify({
        flowId: 'stop_message_flow',
        repeatCount: 1,
        maxRepeats: 3,
        schemaFeedback: {
          reasonCode: 'stop_schema_terminal_missing_fields',
          missingFields: [
            'has_evidence',
            'evidence',
            'issue_cause',
            'excluded_factors',
            'diagnostic_order',
            'done_steps'
          ]
        }
      })
    ]);

    expect(errors).toEqual([]);
    const payload = JSON.parse(output[0] ?? '{}');
    expect(payload.schemaFeedback.reasonCode).toBe('stop_schema_terminal_missing_fields');
    expect(payload.schemaFeedback.missingFields).toEqual(expect.arrayContaining([
      'has_evidence',
      'evidence',
      'issue_cause',
      'excluded_factors',
      'diagnostic_order',
      'done_steps'
    ]));
    expect(payload.modelGuidance).toBeUndefined();
  });

  it.each([
    ['web_search', 'web_search', 'web_search_flow', { query: 'x' }],
    ['vision_auto', 'multimodal', 'vision_flow', { image: 'img_vision' }]
  ])(
    'supports client-exec servertool %s',
    async (toolName, expectedRouteHint, expectedFlowId, input) => {
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
        'node', 'routecodex', 'servertool', 'run', toolName,
        '--flow', expectedFlowId,
        '--input-json', JSON.stringify(input)
      ]);

      expect(errors).toEqual([]);
      const payload = JSON.parse(output[0] ?? '{}');
      expect(payload.toolName).toBe(toolName);
      expect(payload.flowId).toBe(expectedFlowId);
      expect(payload.routeHint).toBe(expectedRouteHint);
      expect(payload.input).toEqual(input);
    }
  );

  it.each(['memory_cache_auto'])(
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
    expectNoPrivateServertoolCarrier(output[0] ?? '');
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

  it.each([
    ['restorationHandle', { restorationHandle: 'legacy_handle' }],
    ['restorationStore', { restorationStore: { id: 'legacy_store' } }]
  ])('fails fast when CLI input contains restoration carrier %s', async (carrier, payload) => {
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
        JSON.stringify(payload)
      ])
    ).rejects.toThrow('exit 1');

    expect(output).toEqual([]);
    expect(errors[0]).toContain(`SERVERTOOL_DENIED_INTERNAL_CARRIER: ${carrier}`);
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

  it('fails fast for malformed input JSON without client stdout', async () => {
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
        '{"bad":"json"'
      ])
    ).rejects.toThrow('exit 1');

    expect(output).toEqual([]);
    expect(errors[0]).toContain('SERVERTOOL_CLI_INVALID_JSON:');
    expect(exits).toEqual([1]);
  });

  it('omitting sessionId no longer fails for stopless CLI run', async () => {
    const output: string[] = [];
    const errors: string[] = [];
    let exitCode = 0;
    const program = new Command();
    program.exitOverride();
    createServertoolCommand(program, {
      log: (line) => output.push(line),
      error: (line) => errors.push(line),
      exit: (code) => { exitCode = code; }
    });

    await program.parseAsync([
      'node',
      'routecodex',
      'servertool',
      'run',
      'stop_message_auto',
      '--input-json',
      '{"flowId":"stop_message_flow","repeatCount":1,"maxRepeats":3}'
    ]);

    expect(exitCode).toBe(0);
    expect(errors).toEqual([]);
    const payload = JSON.parse(output[0] ?? '{}');
    expect(payload.repeatCount).toBe(1);
    expect(payload.sessionId).toBeUndefined();
    expect(payload.requestId).toBeUndefined();
  });
});
