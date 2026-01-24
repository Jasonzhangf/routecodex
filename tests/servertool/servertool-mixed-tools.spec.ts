import * as fs from 'node:fs';
import * as path from 'node:path';

import type { AdapterContext } from '../../sharedmodule/llmswitch-core/src/conversion/hub/types/chat-envelope.js';
import type { StandardizedRequest } from '../../sharedmodule/llmswitch-core/src/conversion/hub/types/standardized.js';
import { runServerToolOrchestration } from '../../sharedmodule/llmswitch-core/src/servertool/engine.js';
import { runReqProcessStage1ToolGovernance } from '../../sharedmodule/llmswitch-core/src/conversion/hub/pipeline/stages/req_process/req_process_stage1_tool_governance/index.js';

const SESSION_DIR = path.join(process.cwd(), 'tmp', 'jest-mixed-tools-sessions');

function resetSessionDir(): void {
  fs.rmSync(SESSION_DIR, { recursive: true, force: true });
  fs.mkdirSync(SESSION_DIR, { recursive: true });
}

function readJson(p: string): any {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function buildRequest(messages: StandardizedRequest['messages']): StandardizedRequest {
  return {
    model: 'gpt-test',
    messages,
    tools: [],
    parameters: {},
    metadata: { originalEndpoint: '/v1/chat/completions' }
  };
}

describe('servertool: mixed tool_calls (servertool + client tools)', () => {
  beforeAll(() => {
    process.env.ROUTECODEX_SESSION_DIR = SESSION_DIR;
  });

  beforeEach(() => {
    resetSessionDir();
  });

  test('executes servertool now, returns client tool_calls, and injects servertool results next request after client tool results', async () => {
    const sessionId = 's-mixed';
    const clockCallId = 'call_clock_1';
    const clientCallId = 'call_exec_command_1';

    const adapterContext: AdapterContext = {
      requestId: 'req-mixed-1',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      sessionId,
      __rt: { clock: { enabled: true, tickMs: 0 } },
      capturedChatRequest: {
        model: 'gpt-test',
        messages: [{ role: 'user', content: 'hi' }]
      }
    } as any;

    const dueAt = new Date(Date.now() + 60_000).toISOString();

    const chat = {
      id: 'chatcmpl-mixed-1',
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
                id: clockCallId,
                type: 'function',
                function: {
                  name: 'clock',
                  arguments: JSON.stringify({ action: 'schedule', items: [{ dueAt, task: 't1' }] })
                }
              },
              {
                id: clientCallId,
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
      requestId: 'req-mixed-1',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat'
    });

    expect(orchestration.executed).toBe(true);
    const outToolCalls = (orchestration.chat as any).choices?.[0]?.message?.tool_calls ?? [];
    const outNames = outToolCalls.map((tc: any) => tc?.function?.name);
    expect(outNames).toEqual(['exec_command']);

    // Pending injection persisted for next request.
    const pendingPath = path.join(SESSION_DIR, 'servertool-pending', `${sessionId}.json`);
    expect(fs.existsSync(pendingPath)).toBe(true);
    const pending = readJson(pendingPath);
    expect(pending.sessionId).toBe(sessionId);
    expect(pending.afterToolCallIds).toContain(clientCallId);
    const injectedAssistant = pending.messages?.[0];
    expect(injectedAssistant?.role).toBe('assistant');
    expect(injectedAssistant?.tool_calls?.[0]?.function?.name).toBe('clock');
    const injectedTool = pending.messages?.find((m: any) => m?.role === 'tool');
    expect(injectedTool?.tool_call_id).toBe(clockCallId);

    // Next request from client includes tool result for apply_patch.
    const req = buildRequest([
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: clientCallId,
            type: 'function',
            function: { name: 'exec_command', arguments: JSON.stringify({ cmd: 'echo hi' }) }
          }
        ]
      } as any,
      {
        role: 'tool',
        tool_call_id: clientCallId,
        name: 'exec_command',
        content: '{"ok":true}'
      } as any
    ]);

    const processed = await runReqProcessStage1ToolGovernance({
      request: req,
      rawPayload: {},
      metadata: { originalEndpoint: '/v1/chat/completions', sessionId },
      entryEndpoint: '/v1/chat/completions',
      requestId: 'req-mixed-2'
    });

    const messages = (processed.processedRequest as any).messages ?? [];
    const clientToolIdx = messages.findIndex((m: any) => m?.role === 'tool' && m?.tool_call_id === clientCallId);
    expect(clientToolIdx).toBeGreaterThanOrEqual(0);
    // Injected assistant/tool messages appear AFTER client tool results.
    expect(messages[clientToolIdx + 1]?.role).toBe('assistant');
    expect(messages[clientToolIdx + 1]?.tool_calls?.[0]?.function?.name).toBe('clock');
    expect(messages[clientToolIdx + 2]?.role).toBe('tool');
    expect(messages[clientToolIdx + 2]?.tool_call_id).toBe(clockCallId);

    // Pending file consumed.
    expect(fs.existsSync(pendingPath)).toBe(false);
  });
});
