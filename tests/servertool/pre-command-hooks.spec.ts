import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runServerSideToolEngine } from '../../sharedmodule/llmswitch-core/src/servertool/server-side-tools.js';
import { resetPreCommandHooksCacheForTests } from '../../sharedmodule/llmswitch-core/src/servertool/pre-command-hooks.js';
import type { AdapterContext } from '../../sharedmodule/llmswitch-core/src/conversion/hub/types/chat-envelope.js';
import type { JsonObject } from '../../sharedmodule/llmswitch-core/src/conversion/hub/types/json.js';
import type { ServerToolAutoHookTraceEvent } from '../../sharedmodule/llmswitch-core/src/servertool/types.js';

const HOOK_DIR = path.join(process.cwd(), 'tmp', 'jest-pre-command-hooks');

function hasJqBinary(): boolean {
  const probe = spawnSync('jq', ['--version'], { encoding: 'utf8' });
  return !probe.error && probe.status === 0;
}

function buildToolCallResponse(cmd: string): JsonObject {
  return {
    id: 'chatcmpl-pre-command-hook',
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
              id: 'call_exec_1',
              type: 'function',
              function: {
                name: 'exec_command',
                arguments: JSON.stringify({ cmd, workdir: '/tmp' })
              }
            }
          ]
        },
        finish_reason: 'tool_calls'
      }
    ]
  };
}

function extractExecCommandArgs(chatResponse: JsonObject): Record<string, unknown> {
  const choices = Array.isArray((chatResponse as any).choices) ? ((chatResponse as any).choices as any[]) : [];
  const firstChoice = choices[0] && typeof choices[0] === 'object' ? choices[0] : null;
  const message = firstChoice && typeof firstChoice.message === 'object' ? firstChoice.message : null;
  const toolCalls = message && Array.isArray(message.tool_calls) ? message.tool_calls : [];
  const firstTool = toolCalls[0] && typeof toolCalls[0] === 'object' ? toolCalls[0] : null;
  const fn = firstTool && typeof firstTool.function === 'object' ? firstTool.function : null;
  const args = fn && typeof fn.arguments === 'string' ? fn.arguments : '{}';
  return JSON.parse(args) as Record<string, unknown>;
}

describe('servertool pre-command hooks', () => {
  const originalHooksFile = process.env.ROUTECODEX_PRE_COMMAND_HOOKS_FILE;

  beforeEach(() => {
    fs.mkdirSync(HOOK_DIR, { recursive: true });
    resetPreCommandHooksCacheForTests();
  });

  afterEach(() => {
    resetPreCommandHooksCacheForTests();
    if (originalHooksFile === undefined) {
      delete process.env.ROUTECODEX_PRE_COMMAND_HOOKS_FILE;
    } else {
      process.env.ROUTECODEX_PRE_COMMAND_HOOKS_FILE = originalHooksFile;
    }
  });

  test('applies jq transform in pre-command phase when jq is available', async () => {
    const hookFile = path.join(HOOK_DIR, `pre-command-${Date.now()}-transform.json`);
    fs.writeFileSync(
      hookFile,
      JSON.stringify(
        {
          enabled: true,
          hooks: [
            {
              id: 'prepend-safe-prefix',
              tool: 'exec_command',
              priority: 10,
              cmdRegex: '^npm\\s+',
              jq: '.cmd = ("set -euo pipefail; " + .cmd)'
            }
          ]
        },
        null,
        2
      )
    );
    process.env.ROUTECODEX_PRE_COMMAND_HOOKS_FILE = hookFile;
    resetPreCommandHooksCacheForTests();

    const traces: ServerToolAutoHookTraceEvent[] = [];
    const adapterContext: AdapterContext = {
      requestId: 'req-pre-command-transform',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses'
    } as any;

    const result = await runServerSideToolEngine({
      chatResponse: buildToolCallResponse('npm test'),
      adapterContext,
      entryEndpoint: '/v1/responses',
      requestId: 'req-pre-command-transform',
      providerProtocol: 'openai-responses',
      onAutoHookTrace: (event) => traces.push(event)
    });

    expect(result.mode).toBe('passthrough');
    const args = extractExecCommandArgs(result.finalChatResponse);

    if (hasJqBinary()) {
      expect(args.cmd).toBe('set -euo pipefail; npm test');
      expect(
        traces.some(
          (event) =>
            event.phase === 'pre_command' &&
            event.hookId === 'prepend-safe-prefix' &&
            event.result === 'match'
        )
      ).toBe(true);
    } else {
      expect(args.cmd).toBe('npm test');
      expect(
        traces.some(
          (event) =>
            event.phase === 'pre_command' &&
            event.hookId === 'prepend-safe-prefix' &&
            event.result === 'error' &&
            event.reason.includes('jq_not_found')
        )
      ).toBe(true);
    }
  });

  test('executes pre-command hooks by priority order', async () => {
    const hookFile = path.join(HOOK_DIR, `pre-command-${Date.now()}-priority.json`);
    fs.writeFileSync(
      hookFile,
      JSON.stringify(
        {
          enabled: true,
          hooks: [
            {
              id: 'second-hook',
              tool: 'exec_command',
              priority: 20,
              jq: '.cmd = (.cmd + " && echo second")'
            },
            {
              id: 'first-hook',
              tool: 'exec_command',
              priority: 10,
              jq: '.cmd = (.cmd + " && echo first")'
            }
          ]
        },
        null,
        2
      )
    );
    process.env.ROUTECODEX_PRE_COMMAND_HOOKS_FILE = hookFile;
    resetPreCommandHooksCacheForTests();

    const traces: ServerToolAutoHookTraceEvent[] = [];
    const adapterContext: AdapterContext = {
      requestId: 'req-pre-command-priority',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses'
    } as any;

    const result = await runServerSideToolEngine({
      chatResponse: buildToolCallResponse('echo base'),
      adapterContext,
      entryEndpoint: '/v1/responses',
      requestId: 'req-pre-command-priority',
      providerProtocol: 'openai-responses',
      onAutoHookTrace: (event) => traces.push(event)
    });

    const args = extractExecCommandArgs(result.finalChatResponse);

    if (hasJqBinary()) {
      expect(args.cmd).toBe('echo base && echo first && echo second');
      const preMatches = traces.filter((event) => event.phase === 'pre_command' && event.result === 'match');
      expect(preMatches[0]?.hookId).toBe('first-hook');
      expect(preMatches[1]?.hookId).toBe('second-hook');
    } else {
      expect(args.cmd).toBe('echo base');
    }
  });

  test('keeps original command when jq expression is invalid', async () => {
    const hookFile = path.join(HOOK_DIR, `pre-command-${Date.now()}-invalid.json`);
    fs.writeFileSync(
      hookFile,
      JSON.stringify(
        {
          enabled: true,
          hooks: [
            {
              id: 'invalid-jq',
              tool: 'exec_command',
              priority: 10,
              jq: '.cmd = '
            }
          ]
        },
        null,
        2
      )
    );
    process.env.ROUTECODEX_PRE_COMMAND_HOOKS_FILE = hookFile;
    resetPreCommandHooksCacheForTests();

    const traces: ServerToolAutoHookTraceEvent[] = [];
    const adapterContext: AdapterContext = {
      requestId: 'req-pre-command-invalid',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses'
    } as any;

    const result = await runServerSideToolEngine({
      chatResponse: buildToolCallResponse('echo still-original'),
      adapterContext,
      entryEndpoint: '/v1/responses',
      requestId: 'req-pre-command-invalid',
      providerProtocol: 'openai-responses',
      onAutoHookTrace: (event) => traces.push(event)
    });

    const args = extractExecCommandArgs(result.finalChatResponse);
    expect(args.cmd).toBe('echo still-original');
    expect(
      traces.some(
        (event) =>
          event.phase === 'pre_command' &&
          event.hookId === 'invalid-jq' &&
          event.result === 'error'
      )
    ).toBe(true);
  });
});
