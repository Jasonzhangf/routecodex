import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { runReqProcessStage1ToolGovernance } from '../../sharedmodule/llmswitch-core/src/conversion/hub/pipeline/stages/req_process/req_process_stage1_tool_governance/index.js';
import type { StandardizedRequest } from '../../sharedmodule/llmswitch-core/src/conversion/hub/types/standardized.js';
import { runServerSideToolEngine } from '../../sharedmodule/llmswitch-core/src/servertool/server-side-tools.js';
import type { AdapterContext } from '../../sharedmodule/llmswitch-core/src/conversion/hub/types/chat-envelope.js';

import {
  normalizeClockConfig,
  scheduleClockTasks,
  loadClockSessionState,
  commitClockReservation
} from '../../sharedmodule/llmswitch-core/src/servertool/clock/task-store.js';

const SESSION_DIR = path.join(process.cwd(), 'tmp', 'jest-clock-sessions');

function resetSessionDir(): void {
  fs.rmSync(SESSION_DIR, { recursive: true, force: true });
  fs.mkdirSync(SESSION_DIR, { recursive: true });
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

function readClockStateFile(sessionId: string): any {
  const file = path.join(SESSION_DIR, 'clock', `${sessionId}.json`);
  const raw = fs.readFileSync(file, 'utf8');
  return JSON.parse(raw);
}

describe('servertool:clock', () => {
  beforeAll(() => {
    process.env.ROUTECODEX_SESSION_DIR = SESSION_DIR;
  });

  beforeEach(() => {
    resetSessionDir();
  });

  test('is disabled by default (no tool injection when virtualrouter.clock is absent)', async () => {
    const request = buildRequest([{ role: 'user', content: 'hi' }]);
    const result = await runReqProcessStage1ToolGovernance({
      request,
      rawPayload: {},
      metadata: { originalEndpoint: '/v1/chat/completions' },
      entryEndpoint: '/v1/chat/completions',
      requestId: 'req-clock-disabled'
    });

    expect(result.processedRequest).toBeDefined();
    const processed = result.processedRequest as StandardizedRequest;
    const toolNames = (Array.isArray(processed.tools) ? processed.tools : []).map((t) => t.function?.name);
    expect(toolNames).not.toContain('clock');
  });

  test('injects clock tool schema when enabled', async () => {
    const request = buildRequest([{ role: 'user', content: 'hi' }]);
    const result = await runReqProcessStage1ToolGovernance({
      request,
      rawPayload: {},
      metadata: {
        originalEndpoint: '/v1/chat/completions',
        __rt: { clock: { enabled: true } },
        sessionId: 's-clock-1'
      },
      entryEndpoint: '/v1/chat/completions',
      requestId: 'req-clock-inject'
    });

    const processed = result.processedRequest as any;
    const toolNames = (Array.isArray(processed.tools) ? processed.tools : []).map((t: any) => t?.function?.name);
    expect(toolNames).toContain('clock');
    expect(processed.metadata?.clockEnabled).toBe(true);
    expect(processed.metadata?.serverToolRequired).toBe(true);
  });

  test('<**clock:clear**> only applies to latest user message and clears session file when present', async () => {
    const clockConfig = normalizeClockConfig({ enabled: true, tickMs: 0 });
    if (!clockConfig) {
      throw new Error('clockConfig should not be null');
    }
    const sessionId = 's-clock-clear';
    await scheduleClockTasks(sessionId, [{ dueAtMs: Date.now() - 1, task: 'old' }], clockConfig);
    const stateFile = path.join(SESSION_DIR, 'clock', `${sessionId}.json`);
    expect(fs.existsSync(stateFile)).toBe(true);

    // Directive in older user message: should NOT clear (latest user message wins).
    const request1 = buildRequest([
      { role: 'user', content: '<**clock:clear**>\nold' },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'new' }
    ]);
    await runReqProcessStage1ToolGovernance({
      request: request1,
      rawPayload: {},
      metadata: { originalEndpoint: '/v1/chat/completions', __rt: { clock: { enabled: true } }, sessionId },
      entryEndpoint: '/v1/chat/completions',
      requestId: 'req-clock-clear-1'
    });
    expect(fs.existsSync(stateFile)).toBe(true);

    // Directive in latest user message: should clear and strip marker.
    const request2 = buildRequest([
      { role: 'user', content: 'hi' },
      { role: 'user', content: 'please clear\n<**clock:clear**>\nthanks' }
    ]);
    const result2 = await runReqProcessStage1ToolGovernance({
      request: request2,
      rawPayload: {},
      metadata: { originalEndpoint: '/v1/chat/completions', __rt: { clock: { enabled: true } }, sessionId },
      entryEndpoint: '/v1/chat/completions',
      requestId: 'req-clock-clear-2'
    });
    const processed2 = result2.processedRequest as any;
    const lastUser = processed2.messages?.[processed2.messages.length - 1];
    expect(typeof lastUser?.content === 'string' ? lastUser.content : '').not.toContain('clock:clear');
    expect(fs.existsSync(stateFile)).toBe(false);
  });

  test('end-to-end: schedule via tool_call → next request injects due reminder → commit marks delivered', async () => {
    const sessionId = 's-clock-e2e';
    const nowIso = new Date(Date.now() - 500).toISOString();

    const adapterContext: AdapterContext = {
      requestId: 'req-clock-toolcall-1',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      sessionId,
      __rt: { clock: { enabled: true, tickMs: 0 } },
      capturedChatRequest: {
        model: 'gpt-test',
        messages: [{ role: 'user', content: 'hi' }]
      }
    } as any;

    const toolCallId = 'call_clock_1';
    const scheduleResponse = await runServerSideToolEngine({
      chatResponse: {
        id: 'chatcmpl-clock-1',
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
                  id: toolCallId,
                  type: 'function',
                  function: {
                    name: 'clock',
                    arguments: JSON.stringify({
                      action: 'schedule',
                      items: [{ dueAt: nowIso, task: 'do the thing' }]
                    })
                  }
                }
              ]
            },
            finish_reason: 'tool_calls'
          }
        ]
      } as any,
      adapterContext,
      entryEndpoint: '/v1/chat/completions',
      requestId: 'req-clock-toolcall-1',
      providerProtocol: 'openai-chat'
    });

    expect(scheduleResponse.mode).toBe('tool_flow');
    expect(scheduleResponse.execution?.flowId).toBe('clock_flow');
    expect(scheduleResponse.execution?.followup).toBeDefined();

    const clockStatePath = path.join(SESSION_DIR, 'clock', `${sessionId}.json`);
    expect(fs.existsSync(clockStatePath)).toBe(true);
    const stateBefore = readClockStateFile(sessionId);
    expect(Array.isArray(stateBefore.tasks)).toBe(true);
    expect(stateBefore.tasks).toHaveLength(1);
    expect(stateBefore.tasks[0].deliveredAtMs).toBeUndefined();

    // Next request: should inject due reminders + attach reservation.
    const request = buildRequest([{ role: 'user', content: 'next' }]);
    const reqId = `req-clock-inject-${Date.now()}`;
    const processed = await runReqProcessStage1ToolGovernance({
      request,
      rawPayload: {},
      metadata: { originalEndpoint: '/v1/chat/completions', __rt: { clock: { enabled: true, tickMs: 0 } }, sessionId },
      entryEndpoint: '/v1/chat/completions',
      requestId: reqId
    });

    const processedRequest = processed.processedRequest as any;
    const last = processedRequest.messages?.[processedRequest.messages.length - 1];
    expect(last?.role).toBe('system');
    expect(typeof last?.content === 'string' ? last.content : '').toContain('[scheduled task:"do the thing"');

    const reservation = processedRequest.metadata?.__clockReservation;
    expect(reservation?.reservationId).toBe(`${reqId}:clock`);
    expect(reservation?.sessionId).toBe(sessionId);
    expect(Array.isArray(reservation?.taskIds) ? reservation.taskIds : []).toHaveLength(1);

    const clockConfig = normalizeClockConfig({ enabled: true, tickMs: 0 });
    if (!clockConfig) {
      throw new Error('clockConfig should not be null');
    }
    await commitClockReservation(reservation, clockConfig);

    const stateAfter = await loadClockSessionState(sessionId, clockConfig);
    expect(stateAfter.tasks).toHaveLength(1);
    expect(typeof stateAfter.tasks[0].deliveredAtMs).toBe('number');
    expect(stateAfter.tasks[0].deliveryCount).toBe(1);
  });

  test('unit: schedule/list/cancel/clear via clock handler outputs', async () => {
    const sessionId = 's-clock-handler';
    const adapterContext: AdapterContext = {
      requestId: 'req-clock-handler-1',
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
    const schedule = await runServerSideToolEngine({
      chatResponse: {
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call_clock_schedule',
                  type: 'function',
                  function: {
                    name: 'clock',
                    arguments: JSON.stringify({ action: 'schedule', items: [{ dueAt, task: 't1' }] })
                  }
                }
              ]
            },
            finish_reason: 'tool_calls'
          }
        ]
      } as any,
      adapterContext,
      entryEndpoint: '/v1/chat/completions',
      requestId: 'req-clock-handler-1',
      providerProtocol: 'openai-chat'
    });

    const scheduleOutputs = (schedule.finalChatResponse as any).tool_outputs;
    expect(Array.isArray(scheduleOutputs)).toBe(true);
    const schedulePayload = JSON.parse(scheduleOutputs[scheduleOutputs.length - 1].content);
    expect(schedulePayload.ok).toBe(true);
    expect(schedulePayload.action).toBe('schedule');
    const scheduledTaskId = schedulePayload.scheduled?.[0]?.taskId;
    expect(typeof scheduledTaskId).toBe('string');

    const list = await runServerSideToolEngine({
      chatResponse: {
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call_clock_list',
                  type: 'function',
                  function: { name: 'clock', arguments: JSON.stringify({ action: 'list' }) }
                }
              ]
            },
            finish_reason: 'tool_calls'
          }
        ]
      } as any,
      adapterContext,
      entryEndpoint: '/v1/chat/completions',
      requestId: 'req-clock-handler-2',
      providerProtocol: 'openai-chat'
    });
    const listPayload = JSON.parse((list.finalChatResponse as any).tool_outputs.slice(-1)[0].content);
    expect(listPayload.ok).toBe(true);
    expect(listPayload.action).toBe('list');
    expect(Array.isArray(listPayload.items)).toBe(true);
    expect(listPayload.items).toHaveLength(1);

    const cancel = await runServerSideToolEngine({
      chatResponse: {
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call_clock_cancel',
                  type: 'function',
                  function: { name: 'clock', arguments: JSON.stringify({ action: 'cancel', taskId: scheduledTaskId }) }
                }
              ]
            },
            finish_reason: 'tool_calls'
          }
        ]
      } as any,
      adapterContext,
      entryEndpoint: '/v1/chat/completions',
      requestId: 'req-clock-handler-3',
      providerProtocol: 'openai-chat'
    });
    const cancelPayload = JSON.parse((cancel.finalChatResponse as any).tool_outputs.slice(-1)[0].content);
    expect(cancelPayload.ok).toBe(true);
    expect(cancelPayload.action).toBe('cancel');
    expect(cancelPayload.removed).toBe(scheduledTaskId);

    const clear = await runServerSideToolEngine({
      chatResponse: {
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call_clock_clear',
                  type: 'function',
                  function: { name: 'clock', arguments: JSON.stringify({ action: 'clear' }) }
                }
              ]
            },
            finish_reason: 'tool_calls'
          }
        ]
      } as any,
      adapterContext,
      entryEndpoint: '/v1/chat/completions',
      requestId: 'req-clock-handler-4',
      providerProtocol: 'openai-chat'
    });
    const clearPayload = JSON.parse((clear.finalChatResponse as any).tool_outputs.slice(-1)[0].content);
    expect(clearPayload.ok).toBe(true);
    expect(clearPayload.action).toBe('clear');
    expect(typeof clearPayload.removedCount).toBe('number');

    // Session file should be gone after clear.
    expect(fs.existsSync(path.join(SESSION_DIR, 'clock', `${sessionId}.json`))).toBe(false);
  });

  test('unit: clock handler returns ok=false when clock is not enabled', async () => {
    const sessionId = `s-clock-disabled-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const adapterContext: AdapterContext = {
      requestId: 'req-clock-disabled-handler',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      sessionId,
      __rt: { clock: { enabled: false } }
    } as any;

    const dueAt = new Date(Date.now() + 60_000).toISOString();
    const result = await runServerSideToolEngine({
      chatResponse: {
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call_clock_disabled',
                  type: 'function',
                  function: {
                    name: 'clock',
                    arguments: JSON.stringify({ action: 'schedule', items: [{ dueAt, task: 't1' }] })
                  }
                }
              ]
            },
            finish_reason: 'tool_calls'
          }
        ]
      } as any,
      adapterContext,
      entryEndpoint: '/v1/chat/completions',
      requestId: 'req-clock-disabled-handler',
      providerProtocol: 'openai-chat'
    });

    const payload = JSON.parse((result.finalChatResponse as any).tool_outputs.slice(-1)[0].content);
    expect(payload.ok).toBe(false);
    expect(String(payload.message || '')).toContain('virtualrouter.clock.enabled=true');
  });

  afterAll(() => {
    resetSessionDir();
    // keep ROUTECODEX_SESSION_DIR for other test suites (each jest worker has isolated env).
  });
});
