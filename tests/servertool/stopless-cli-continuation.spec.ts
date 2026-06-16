import { describe, expect, jest, test } from '@jest/globals';
import { Command } from 'commander';
import fs from 'node:fs';
import path from 'node:path';

import { runServerToolOrchestration } from '../../sharedmodule/llmswitch-core/src/servertool/engine.js';
import { resolveStateKey } from '../../sharedmodule/llmswitch-core/src/servertool/handlers/stop-message-auto/runtime-utils.js';
import type { AdapterContext } from '../../sharedmodule/llmswitch-core/src/conversion/hub/types/chat-envelope.js';
import type { JsonObject } from '../../sharedmodule/llmswitch-core/src/conversion/hub/types/json.js';
import { createServertoolCommand } from '../../src/cli/commands/servertool.js';

function buildStopChatResponse(content: string = 'need continue'): JsonObject {
  return {
    id: 'chatcmpl-stopless-cli',
    object: 'chat.completion',
    model: 'gpt-test',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content },
        finish_reason: 'stop'
      }
    ]
  } as JsonObject;
}

function buildAdapterContext(overrides: Partial<AdapterContext> = {}): AdapterContext {
  const unique = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return {
    requestId: overrides.requestId ?? `req-stopless-cli-${unique}`,
    entryEndpoint: overrides.entryEndpoint ?? '/v1/chat/completions',
    providerProtocol: overrides.providerProtocol ?? 'openai-chat',
    sessionId: overrides.sessionId ?? `session-stopless-cli-${unique}`,
    capturedChatRequest: overrides.capturedChatRequest ?? {
      model: 'gpt-test',
      messages: [{ role: 'user', content: 'diagnose this' }]
    }
  } as any;
}

function extractExecCommand(resultChat: any): string {
  const toolCall = resultChat?.choices?.[0]?.message?.tool_calls?.[0];
  expect(toolCall?.function?.name).toBe('exec_command');
  return JSON.parse(toolCall.function.arguments).cmd;
}

async function runStoplessCliStdout(command: string) {
  const inputJson = command.match(/--input-json '([^']+)'(?=\s--session-id|\s--request-id|$)/)?.[1];
  const sessionId = command.match(/--session-id '([^']+)'/)?.[1];
  const requestId = command.match(/--request-id '([^']+)'/)?.[1];
  const output: string[] = [];
  const errors: string[] = [];
  const program = new Command();
  program.exitOverride();
  process.env.ROUTECODEX_SERVERTOOL_BIN = path.join(
    process.cwd(),
    'sharedmodule/llmswitch-core/rust-core/target/debug/routecodex-servertool'
  );
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
    'hook',
    'run',
    'stop_message_auto',
    '--input-json',
    inputJson ?? '{}',
    '--session-id',
    sessionId ?? 'session-test',
    '--request-id',
    requestId ?? 'req-test'
  ]);
  return JSON.parse(output[0] ?? '{}') as Record<string, any>;
}

function extractRepeatCount(command: string): number | undefined {
  const inputJson = command.match(/--input-json '([^']+)'(?=\s--session-id|\s--request-id|$)/)?.[1];
  if (!inputJson) {
    return undefined;
  }
  return JSON.parse(inputJson).repeatCount as number | undefined;
}

function isolateSessionDir(label: string): void {
  const dir = path.join(process.cwd(), '.tmp', 'jest-stopless-cli', `${label}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  process.env.ROUTECODEX_SESSION_DIR = dir;
}

describe('stopless CLI continuation', () => {
  test('direct runtime routeName disables stopless CLI projection', async () => {
    isolateSessionDir('direct-disabled');
    const adapterContext = buildAdapterContext({
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses',
      sessionId: ''
    });
    (adapterContext as any).__rt = {
      routeName: 'router-direct:thinking'
    };

    const result = await runServerToolOrchestration({
      chat: buildStopChatResponse('direct stop must passthrough'),
      adapterContext,
      requestId: adapterContext.requestId,
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses',
      reenterPipeline: async () => {
        throw new Error('direct stopless disable must not reenter');
      }
    });

    expect(result.executed).toBe(false);
    expect(result.chat).toEqual(buildStopChatResponse('direct stop must passthrough'));
  });

  test('resolveStateKey still uses only sessionId (no tmux/conversation/inject fallback)', () => {
    expect(resolveStateKey({
      providerProtocol: 'openai-responses',
      requestId: 'req-stopless-session-only',
      sessionId: 'session-a',
      conversationId: 'conversation-ignored',
      clientTmuxSessionId: 'tmux-ignored',
      stopMessageClientInjectScope: 'conversation:legacy'
    })).toBe('session:session-a');
  });

  test('stopless CLI stdout carries schema guidance', async () => {
    isolateSessionDir('schema-guidance');
    const unique = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const adapterContext = buildAdapterContext({
      sessionId: `session-stopless-cli-${unique}`,
      requestId: `req-stopless-cli-${unique}`
    });
    const result = await runServerToolOrchestration({
      chat: buildStopChatResponse('need more evidence'),
      adapterContext,
      requestId: adapterContext.requestId,
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses',
      reenterPipeline: async () => {
        throw new Error('stopless CLI projection must not reenter');
      }
    });
    const command = extractExecCommand(result.chat);
    const first = await runStoplessCliStdout(command);

    expect(first.repeatCount).toBe(1);
    expect(first.schemaGuidance).toBeDefined();
    expect(first.schemaGuidance.requiredFields).toContain('stopreason');
    expect(first.schemaGuidance.requiredFields).toContain('next_step');
  });

  test('stopless no-schema CLI/tool contract advances 1 -> 2 -> 3 on the same session', async () => {
    isolateSessionDir('no-schema-progress');
    const sessionId = `session-stopless-cli-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const requestIds = [
      `req-stopless-cli-${Date.now()}-1`,
      `req-stopless-cli-${Date.now()}-2`,
      `req-stopless-cli-${Date.now()}-3`
    ];
    const commands: string[] = [];
    const outputs: Array<Record<string, any>> = [];

    for (const requestId of requestIds) {
      const result = await runServerToolOrchestration({
        chat: buildStopChatResponse('need more evidence'),
        adapterContext: buildAdapterContext({ sessionId, requestId }),
        requestId,
        entryEndpoint: '/v1/responses',
        providerProtocol: 'openai-responses',
        reenterPipeline: async () => {
          throw new Error('stopless CLI projection must not reenter');
        }
      });
      const command = extractExecCommand(result.chat);
      commands.push(command);
      outputs.push(await runStoplessCliStdout(command));
    }

    expect(commands.map(extractRepeatCount)).toEqual([1, 2, 3]);
    expect(outputs.map((entry) => entry.repeatCount)).toEqual([1, 2, 3]);
    for (const output of outputs) {
      expect(output.schemaGuidance).toBeDefined();
      expect(output.schemaGuidance.requiredFields).toContain('stopreason');
      expect(output.schemaGuidance.requiredFields).toContain('next_step');
    }
  });

  test('stopless projects CLI and never reenters pipeline', async () => {
    isolateSessionDir('no-reenter');
    const reenterPipeline = jest.fn(async () => ({
      body: {
        id: 'chatcmpl-should-not-run',
        object: 'chat.completion',
        choices: [{ index: 0, message: { role: 'assistant', content: 'unexpected' }, finish_reason: 'stop' }]
      } as JsonObject
    }));
    const adapterContext = buildAdapterContext();

    const result = await runServerToolOrchestration({
      chat: buildStopChatResponse('need more evidence'),
      adapterContext,
      requestId: adapterContext.requestId,
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      reenterPipeline
    });

    expect(result.executed).toBe(true);
    expect(result.flowId).toBe('stop_message_flow');
    expect(reenterPipeline).not.toHaveBeenCalled();
    const command = extractExecCommand(result.chat);
    expect(command).toMatch(/^routecodex hook run reasoning_stop --input-json '/);
    expect(command).not.toContain('stop_message_auto');
  });

  test('stopless CLI command is status-only and does not leak continuation prompt text', async () => {
    isolateSessionDir('status-only');
    const adapterContext = buildAdapterContext();

    const result = await runServerToolOrchestration({
      chat: buildStopChatResponse('阶段完成，但还需继续执行'),
      adapterContext,
      requestId: adapterContext.requestId,
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses',
      reenterPipeline: async () => {
        throw new Error('stopless CLI projection must not reenter');
      }
    });

    const command = extractExecCommand(result.chat);
    const inputMatch = command.match(/--input-json '([^']+)'(?=\s--session-id|\s--request-id|$)/);
    const input = inputMatch ? JSON.parse(inputMatch[1]) : {};
    expect(input).toMatchObject({
      flowId: 'stop_message_flow'
    });
    expect(typeof input.repeatCount).toBe('number');
    expect(typeof input.maxRepeats).toBe('number');
    expect(input.continuationPrompt).toBeUndefined();
    expect(input.schemaGuidance).toBeUndefined();
    expect(command).not.toContain('continuationPrompt');
    expect(command).not.toContain('schemaGuidance');
    expect(command).not.toContain('第一轮核对');
    expect(command).not.toContain('stop schema');
    expect(command).not.toContain('stop_message_auto');
  });

  test('terminal stopless result stays terminal and does not project CLI', async () => {
    isolateSessionDir('terminal');
    const adapterContext = buildAdapterContext({
      __raw_request_body: {
        model: 'gpt-test',
        input: [{ role: 'user', content: [{ type: 'input_text', text: '继续执行' }] }]
      } as any
    });

    const result = await runServerToolOrchestration({
      chat: {
        id: 'chatcmpl-stopless-cli-terminal',
        object: 'chat.completion',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: [
                '已完成在线验证。',
                '{"stopreason":0,"reason":"done","has_evidence":1,"evidence":"live probe","issue_cause":"none","excluded_factors":"none","diagnostic_order":"single round","done_steps":"verified","next_step":"","next_suggested_path":"","needs_user_input":false,"learned":"ok"}'
              ].join('\n')
            },
            finish_reason: 'stop'
          }
        ]
      } as any,
      adapterContext,
      requestId: adapterContext.requestId,
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses',
      reenterPipeline: async () => {
        throw new Error('terminal stopless result must not reenter');
      }
    });

    const visible = JSON.stringify(result.chat);
    expect(visible).not.toContain('routecodex hook run stop_message_auto');
    expect(visible).not.toContain('exec_command');
  });
});
