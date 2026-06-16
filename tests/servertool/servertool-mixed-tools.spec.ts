import * as fs from 'node:fs';
import * as path from 'node:path';

import type { AdapterContext } from '../../sharedmodule/llmswitch-core/src/conversion/hub/types/chat-envelope.js';
import { runServerToolOrchestration } from '../../sharedmodule/llmswitch-core/src/servertool/engine.js';

const SESSION_DIR = path.join(process.cwd(), 'tmp', 'jest-mixed-tools-sessions');

function resetSessionDir(): void {
  fs.rmSync(SESSION_DIR, { recursive: true, force: true });
  fs.mkdirSync(SESSION_DIR, { recursive: true });
}

function pendingDir(): string {
  return path.join(SESSION_DIR, 'servertool-pending');
}

describe('servertool: mixed migrated servertool + client tool_calls', () => {
  const originalSessionDir = process.env.ROUTECODEX_SESSION_DIR;

  beforeAll(() => {
    process.env.ROUTECODEX_SESSION_DIR = SESSION_DIR;
  });

  beforeEach(() => {
    resetSessionDir();
  });

  afterAll(() => {
    if (originalSessionDir === undefined) {
      delete process.env.ROUTECODEX_SESSION_DIR;
    } else {
      process.env.ROUTECODEX_SESSION_DIR = originalSessionDir;
    }
  });

  test('projects migrated servertool_fixture to client-visible exec_command and preserves client tool_call', async () => {
    const adapterContext: AdapterContext = {
      requestId: 'req-mixed-cli-1',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      sessionId: 's-mixed-cli'
    } as any;

    const chat = {
      id: 'chatcmpl-mixed-cli-1',
      object: 'chat.completion',
      model: 'gpt-test',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_servertool_fixture_1',
                type: 'function',
                function: {
                  name: 'servertool_fixture',
                  arguments: JSON.stringify({ value: 1 })
                }
              },
              {
                id: 'call_exec_command_1',
                type: 'function',
                function: {
                  name: 'exec_command',
                  arguments: JSON.stringify({ cmd: 'echo hi' })
                }
              }
            ]
          },
          finish_reason: 'tool_calls'
        }
      ]
    } as any;

    const orchestration = await runServerToolOrchestration({
      chat,
      adapterContext,
      requestId: 'req-mixed-cli-1',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat'
    });

    expect(orchestration.executed).toBe(true);
    expect(orchestration.flowId).toBe('servertool_cli_projection');

    const message = (orchestration.chat as any).choices?.[0]?.message;
    const outToolCalls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
    expect(outToolCalls).toHaveLength(2);
    expect(outToolCalls[0]?.function?.name).toBe('exec_command');
    const projectedCommand = JSON.parse(outToolCalls[0].function.arguments).cmd;
    expect(projectedCommand).toContain("routecodex hook run servertool_fixture --input-json '{\"value\":1}'");
    expect(projectedCommand).toContain("--session-id 's-mixed-cli'");
    expect(projectedCommand).toContain("--request-id 'req-mixed-cli-1'");
    expect(outToolCalls[1]).toMatchObject({
      id: 'call_exec_command_1',
      type: 'function',
      function: {
        name: 'exec_command',
        arguments: JSON.stringify({ cmd: 'echo hi' })
      }
    });
    expect(message?.reasoning_content).toContain('servertool_fixture');
    expect((orchestration.chat as any).__servertool_cli_projection).toBeUndefined();
    expect(fs.existsSync(pendingDir())).toBe(false);
  });

  test('does not restore internal servertool identity from migrated CLI projection', async () => {
    const adapterContext: AdapterContext = {
      requestId: 'req-mixed-cli-restore',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      sessionId: 's-mixed-cli-restore'
    } as any;

    const chat = {
      id: 'chatcmpl-mixed-cli-restore',
      object: 'chat.completion',
      model: 'gpt-test',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_servertool_fixture_restore',
                type: 'function',
                function: {
                  name: 'servertool_fixture',
                  arguments: JSON.stringify({ value: 'ordinary' })
                }
              }
            ]
          },
          finish_reason: 'tool_calls'
        }
      ]
    } as any;

    const orchestration = await runServerToolOrchestration({
      chat,
      adapterContext,
      requestId: 'req-mixed-cli-restore',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat'
    });

    const payloadText = JSON.stringify(orchestration.chat);
    expect(orchestration.executed).toBe(true);
    expect(payloadText).toContain('exec_command');
    expect(payloadText).not.toContain('old_cli_');
    expect(payloadText).not.toContain(['st', 'cli_'].join(''));
    expect(payloadText).not.toContain(['rcc', '_cli_'].join(''));
    expect(fs.existsSync(pendingDir())).toBe(false);
  });

  test('keeps removed clock tool on client side instead of reintroducing servertool pending injection', async () => {
    const adapterContext: AdapterContext = {
      requestId: 'req-mixed-clock-removed',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      sessionId: 's-mixed-clock-removed'
    } as any;

    const chat = {
      id: 'chatcmpl-mixed-clock-removed',
      object: 'chat.completion',
      model: 'gpt-test',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_clock_removed_1',
                type: 'function',
                function: {
                  name: 'clock',
                  arguments: JSON.stringify({ action: 'schedule' })
                }
              },
              {
                id: 'call_exec_command_removed_1',
                type: 'function',
                function: {
                  name: 'exec_command',
                  arguments: JSON.stringify({ cmd: 'echo still-client' })
                }
              }
            ]
          },
          finish_reason: 'tool_calls'
        }
      ]
    } as any;

    const orchestration = await runServerToolOrchestration({
      chat,
      adapterContext,
      requestId: 'req-mixed-clock-removed',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat'
    });

    expect(orchestration.executed).toBe(false);
    const names = ((orchestration.chat as any).choices?.[0]?.message?.tool_calls ?? []).map(
      (toolCall: any) => toolCall?.function?.name
    );
    expect(names).toEqual(['clock', 'exec_command']);
    expect(fs.existsSync(pendingDir())).toBe(false);
  });
});
