import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { runReqProcessStage1ToolGovernance } from '../../sharedmodule/llmswitch-core/src/conversion/hub/pipeline/stages/req_process/req_process_stage1_tool_governance/index.js';
import type { StandardizedRequest } from '../../sharedmodule/llmswitch-core/src/conversion/hub/types/standardized.js';
import { runHubChatProcess } from '../../sharedmodule/llmswitch-core/src/conversion/hub/process/chat-process.js';
import { runServerSideToolEngine } from '../../sharedmodule/llmswitch-core/src/servertool/server-side-tools.js';
import { runServerToolOrchestration } from '../../sharedmodule/llmswitch-core/src/servertool/engine.js';
import type { AdapterContext } from '../../sharedmodule/llmswitch-core/src/conversion/hub/types/chat-envelope.js';
import type { JsonObject } from '../../sharedmodule/llmswitch-core/src/conversion/hub/types/json.js';

import {
  normalizeClockConfig,
  scheduleClockTasks,
  loadClockSessionState,
  commitClockReservation,
  reserveDueTasksForRequest
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
    // Keep tests deterministic and offline.
    process.env.ROUTECODEX_CLOCK_NTP = '0';
  });

  beforeEach(() => {
    resetSessionDir();
  });

  test('injects clock tool schema even when sessionId is absent', async () => {
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
    expect(toolNames).toContain('clock');
    expect((processed.metadata as any)?.clockEnabled).toBe(true);
    // Execution still requires session; do not force serverToolRequired when sessionId is missing.
    expect((processed.metadata as any)?.serverToolRequired).toBeUndefined();
  });

  test('injects clock tool schema by default when sessionId exists', async () => {
    const request = buildRequest([{ role: 'user', content: 'hi' }]);
    const result = await runReqProcessStage1ToolGovernance({
      request,
      rawPayload: {},
      metadata: {
        originalEndpoint: '/v1/chat/completions',
        sessionId: 's-clock-default-1'
      },
      entryEndpoint: '/v1/chat/completions',
      requestId: 'req-clock-default-inject'
    });

    const processed = result.processedRequest as any;
    const toolNames = (Array.isArray(processed.tools) ? processed.tools : []).map((t: any) => t?.function?.name);
    expect(toolNames).toContain('clock');
    expect(processed.metadata?.clockEnabled).toBe(true);
    expect(processed.metadata?.serverToolRequired).toBe(true);
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
    const lastUserWithDirective = (processed2.messages as any[]).findLast((m) =>
      m?.role === 'user' && typeof m?.content === 'string' && m.content.includes('please clear')
    );
    expect(typeof lastUserWithDirective?.content === 'string' ? lastUserWithDirective.content : '').not.toContain('clock:clear');
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
    expect(stateBefore.tasks[0].setBy).toBe('agent');
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
    const messages = Array.isArray(processedRequest.messages) ? processedRequest.messages : [];
    // Due reminder is injected as a user message (time tag is appended after).
    const dueMsg = messages.findLast((m: any) => m?.role === 'user' && typeof m?.content === 'string' && m.content.includes('[Clock Reminder]'));
    expect(dueMsg).toBeDefined();
    expect(typeof dueMsg?.content === 'string' ? dueMsg.content : '').toContain('[scheduled task:"do the thing"');
    expect(typeof dueMsg?.content === 'string' ? dueMsg.content : '').toContain('setBy=agent');
    expect(typeof dueMsg?.content === 'string' ? dueMsg.content : '').toContain('setAt=');
    const last = messages[messages.length - 1];
    expect(last?.role).toBe('user');
    expect(typeof last?.content === 'string' ? last.content : '').toContain('[Time/Date]:');

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

  test('daemon-scoped clock session isolates tasks when sessionId is shared', async () => {
    const sharedSessionId = 's-clock-shared-session';
    const dueAtIso = new Date(Date.now() + 60_000).toISOString();

    const runClockTool = async (requestId: string, daemonId: string, action: 'schedule' | 'list', task?: string) => {
      const toolCallArgs =
        action === 'schedule'
          ? {
              action: 'schedule',
              items: [{ dueAt: dueAtIso, task: task || 'task' }]
            }
          : { action: 'list' };
      return await runServerSideToolEngine({
        chatResponse: {
          id: `chatcmpl-${requestId}`,
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
                    id: `call_${requestId}`,
                    type: 'function',
                    function: {
                      name: 'clock',
                      arguments: JSON.stringify(toolCallArgs)
                    }
                  }
                ]
              },
              finish_reason: 'tool_calls'
            }
          ]
        } as any,
        adapterContext: {
          requestId,
          entryEndpoint: '/v1/chat/completions',
          providerProtocol: 'openai-chat',
          sessionId: sharedSessionId,
          clockDaemonId: daemonId,
          __rt: { clock: { enabled: true, tickMs: 0 } },
          capturedChatRequest: {
            model: 'gpt-test',
            messages: [{ role: 'user', content: 'hi' }]
          }
        } as any,
        entryEndpoint: '/v1/chat/completions',
        requestId,
        providerProtocol: 'openai-chat'
      });
    };

    await runClockTool('req-clock-scope-da', 'clockd_A', 'schedule', 'task-da');
    await runClockTool('req-clock-scope-db', 'clockd_B', 'schedule', 'task-db');

    expect(fs.existsSync(path.join(SESSION_DIR, 'clock', 'clockd.clockd_A.json'))).toBe(true);
    expect(fs.existsSync(path.join(SESSION_DIR, 'clock', 'clockd.clockd_B.json'))).toBe(true);

    const stateA = readClockStateFile('clockd.clockd_A');
    const stateB = readClockStateFile('clockd.clockd_B');
    expect(stateA.tasks.map((item: any) => item.task)).toContain('task-da');
    expect(stateA.tasks.map((item: any) => item.task)).not.toContain('task-db');
    expect(stateB.tasks.map((item: any) => item.task)).toContain('task-db');
    expect(stateB.tasks.map((item: any) => item.task)).not.toContain('task-da');

    const listA = await runClockTool('req-clock-scope-da-list', 'clockd_A', 'list');
    const listB = await runClockTool('req-clock-scope-db-list', 'clockd_B', 'list');
    const listPayloadA = JSON.parse(
      String(((listA.finalChatResponse as any)?.tool_outputs?.[0] as any)?.content || '{}')
    ) as { items?: Array<{ task?: string }> };
    const listPayloadB = JSON.parse(
      String(((listB.finalChatResponse as any)?.tool_outputs?.[0] as any)?.content || '{}')
    ) as { items?: Array<{ task?: string }> };
    expect((listPayloadA.items || []).map((item) => item.task)).toContain('task-da');
    expect((listPayloadA.items || []).map((item) => item.task)).not.toContain('task-db');
    expect((listPayloadB.items || []).map((item) => item.task)).toContain('task-db');
    expect((listPayloadB.items || []).map((item) => item.task)).not.toContain('task-da');
  });


  test('overdue one-shot tasks are auto-removed after overdue window', async () => {
    const sessionId = 's-clock-overdue-auto-remove';
    const clockConfig = normalizeClockConfig({ enabled: true, tickMs: 0, dueWindowMs: 0, retentionMs: 20 * 60_000 });
    if (!clockConfig) {
      throw new Error('clockConfig should not be null');
    }

    await scheduleClockTasks(
      sessionId,
      [{ dueAtMs: Date.now() - 90_000, task: 'stale-overdue-task' }],
      clockConfig
    );
    const staleState = await loadClockSessionState(sessionId, clockConfig);
    expect(staleState.tasks).toHaveLength(0);

    await scheduleClockTasks(
      sessionId,
      [{ dueAtMs: Date.now() - 20_000, task: 'recent-due-task' }],
      clockConfig
    );
    const recentState = await loadClockSessionState(sessionId, clockConfig);
    expect(recentState.tasks.some((task) => task.task === 'recent-due-task')).toBe(true);
  });

  test('clock_hold_flow followup keeps original providerKey pinned', async () => {
    const sessionId = 's-clock-hold-provider-pin';
    const clockConfig = normalizeClockConfig({ enabled: true, tickMs: 0, dueWindowMs: 60_000, holdNonStreaming: true });
    if (!clockConfig) {
      throw new Error('clockConfig should not be null');
    }

    await scheduleClockTasks(
      sessionId,
      [{ dueAtMs: Date.now() - 1000, task: 'provider pin check' }],
      clockConfig
    );

    const providerKey = 'iflow.test.kimi-k2.5';
    const chatResponse: JsonObject = {
      id: 'chatcmpl-clock-hold-1',
      object: 'chat.completion',
      model: 'kimi-k2.5',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'ok' },
          finish_reason: 'stop'
        }
      ]
    };

    const adapterContext: AdapterContext = {
      requestId: 'req-clock-hold-pin-1',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      providerKey,
      sessionId,
      stream: true,
      __rt: { clock: { enabled: true, tickMs: 0, dueWindowMs: 60_000, holdNonStreaming: true } },
      capturedChatRequest: {
        model: 'kimi-k2.5',
        messages: [{ role: 'user', content: 'hi' }]
      }
    } as any;

    let capturedFollowupMeta: Record<string, unknown> | null = null;
    const orchestration = await runServerToolOrchestration({
      chat: chatResponse,
      adapterContext,
      requestId: 'req-clock-hold-pin-1',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      reenterPipeline: async (opts: any) => {
        capturedFollowupMeta =
          opts?.metadata && typeof opts.metadata === 'object'
            ? (opts.metadata as Record<string, unknown>)
            : null;
        return {
          body: {
            id: 'chatcmpl-clock-hold-followup-1',
            object: 'chat.completion',
            model: 'kimi-k2.5',
            choices: [{ index: 0, message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }]
          } as JsonObject
        };
      }
    });

    expect(orchestration.executed).toBe(true);
    expect(orchestration.flowId).toBe('clock_hold_flow');
    expect(capturedFollowupMeta).toBeTruthy();
    expect((capturedFollowupMeta as any)?.__shadowCompareForcedProviderKey).toBe(providerKey);
  });

  test('injects time tag as user message when last role is user', async () => {
    const request = buildRequest([{ role: 'user', content: 'hi' }]);
    const result = await runReqProcessStage1ToolGovernance({
      request,
      rawPayload: {},
      metadata: { originalEndpoint: '/v1/chat/completions', __rt: { clock: { enabled: true, tickMs: 0 } } },
      entryEndpoint: '/v1/chat/completions',
      requestId: 'req-clock-time-tag-user'
    });

    const processed = result.processedRequest as any;
    const last = processed.messages?.[processed.messages.length - 1];
    expect(last?.role).toBe('user');
    expect(typeof last?.content === 'string' ? last.content : '').toContain('[Time/Date]:');
  });

  test('injects time tag as user message when last role is tool', async () => {
    const request = buildRequest([
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_any_1',
            type: 'function',
            function: { name: 'shell', arguments: JSON.stringify({ command: 'echo ok' }) }
          }
        ]
      },
      {
        role: 'tool',
        tool_call_id: 'call_any_1',
        content: 'ok'
      }
    ] as any);

    const result = await runReqProcessStage1ToolGovernance({
      request,
      rawPayload: {},
      metadata: { originalEndpoint: '/v1/chat/completions', __rt: { clock: { enabled: true, tickMs: 0 } } },
      entryEndpoint: '/v1/chat/completions',
      requestId: 'req-clock-time-tag-tool'
    });

    const processed = result.processedRequest as any;
    const last = processed.messages?.[processed.messages.length - 1];
    expect(last?.role).toBe('user');
    expect(typeof last?.content === 'string' ? last.content : '').toContain('[Time/Date]:');
  });

  test('injects standard tool list when due reminders are injected', async () => {
    const sessionId = 's-clock-tools-complete';
    const clockConfig = normalizeClockConfig({ enabled: true, tickMs: 0 });
    if (!clockConfig) throw new Error('clockConfig should not be null');
    await scheduleClockTasks(sessionId, [{ dueAtMs: Date.now() - 1, task: 'due' }], clockConfig);

    const request = buildRequest([{ role: 'user', content: 'next' }]);
    const result = await runReqProcessStage1ToolGovernance({
      request,
      rawPayload: {},
      metadata: { originalEndpoint: '/v1/chat/completions', __rt: { clock: { enabled: true, tickMs: 0 } }, sessionId },
      entryEndpoint: '/v1/chat/completions',
      requestId: 'req-clock-tools-complete'
    });

    const processed = result.processedRequest as any;
    const toolNames = (Array.isArray(processed.tools) ? processed.tools : []).map((t: any) => t?.function?.name);
    for (const name of [
      'clock',
      'shell',
      'exec_command',
      'apply_patch',
      'update_plan',
      'view_image',
      'list_mcp_resources',
      'list_mcp_resource_templates',
      'read_mcp_resource'
    ]) {
      expect(toolNames).toContain(name);
    }
  });

  test('clock config defaults holdNonStreaming=true when omitted', () => {
    const resolved = normalizeClockConfig({ enabled: true });
    expect(resolved).toBeTruthy();
    expect(resolved?.holdNonStreaming).toBe(true);
  });

  test('clock_auto triggers followup in current request when already in due window', async () => {
    const sessionId = 's-clock-hold-in-window';
    const clockConfig = normalizeClockConfig({ enabled: true, tickMs: 0, dueWindowMs: 60_000 });
    if (!clockConfig) throw new Error('clockConfig should not be null');
    await scheduleClockTasks(sessionId, [{ dueAtMs: Date.now() + 30_000, task: 'due-now-window' }], clockConfig);

    const result = await runServerSideToolEngine({
      chatResponse: {
        choices: [
          {
            message: { role: 'assistant', content: 'done' },
            finish_reason: 'stop'
          }
        ]
      } as any,
      adapterContext: {
        requestId: 'req-clock-hold-window',
        entryEndpoint: '/v1/chat/completions',
        providerProtocol: 'openai-chat',
        sessionId,
        stream: true,
        capturedChatRequest: { model: 'gpt-test', messages: [{ role: 'user', content: 'hi' }] },
        __rt: { clock: { enabled: true, tickMs: 0, dueWindowMs: 60_000 } }
      } as any,
      entryEndpoint: '/v1/chat/completions',
      requestId: 'req-clock-hold-window',
      providerProtocol: 'openai-chat'
    });

    expect(result.execution?.flowId).toBe('clock_hold_flow');
    expect(result.execution?.followup).toBeTruthy();
  });

  test('clock_auto can hold non-streaming by default when in due window', async () => {
    const sessionId = 's-clock-hold-in-window-json';
    const clockConfig = normalizeClockConfig({ enabled: true, tickMs: 0, dueWindowMs: 60_000 });
    if (!clockConfig) throw new Error('clockConfig should not be null');
    await scheduleClockTasks(sessionId, [{ dueAtMs: Date.now() + 30_000, task: 'due-now-window-json' }], clockConfig);

    const result = await runServerSideToolEngine({
      chatResponse: {
        choices: [
          {
            message: { role: 'assistant', content: 'done' },
            finish_reason: 'stop'
          }
        ]
      } as any,
      adapterContext: {
        requestId: 'req-clock-hold-window-json',
        entryEndpoint: '/v1/chat/completions',
        providerProtocol: 'openai-chat',
        sessionId,
        stream: false,
        capturedChatRequest: { model: 'gpt-test', messages: [{ role: 'user', content: 'hi' }] },
        __rt: { clock: { enabled: true, tickMs: 0, dueWindowMs: 60_000 } }
      } as any,
      entryEndpoint: '/v1/chat/completions',
      requestId: 'req-clock-hold-window-json',
      providerProtocol: 'openai-chat'
    });

    expect(result.execution?.flowId).toBe('clock_hold_flow');
    expect(result.execution?.followup).toBeTruthy();
  });

  test('clock_auto holds until due window for stop response when stop_message_auto does not trigger', async () => {
    const sessionId = 's-clock-hold-wait-window';
    const clockConfig = normalizeClockConfig({ enabled: true, tickMs: 0, dueWindowMs: 0, holdMaxMs: 2_000 });
    if (!clockConfig) throw new Error('clockConfig should not be null');
    await scheduleClockTasks(sessionId, [{ dueAtMs: Date.now() + 500, task: 'wait-until-window' }], clockConfig);

    const startedAt = Date.now();
    const result = await runServerSideToolEngine({
      chatResponse: {
        choices: [
          {
            message: { role: 'assistant', content: 'done' },
            finish_reason: 'stop'
          }
        ]
      } as any,
      adapterContext: {
        requestId: 'req-clock-hold-wait-window',
        entryEndpoint: '/v1/chat/completions',
        providerProtocol: 'openai-chat',
        sessionId,
        stream: false,
        capturedChatRequest: { model: 'gpt-test', messages: [{ role: 'user', content: 'hi' }] },
        __rt: { clock: { enabled: true, tickMs: 0, dueWindowMs: 0, holdMaxMs: 2_000 } }
      } as any,
      entryEndpoint: '/v1/chat/completions',
      requestId: 'req-clock-hold-wait-window',
      providerProtocol: 'openai-chat'
    });
    const elapsedMs = Date.now() - startedAt;

    expect(result.execution?.flowId).toBe('clock_hold_flow');
    expect(result.execution?.followup).toBeTruthy();
    expect(elapsedMs).toBeGreaterThanOrEqual(180);
  });

  test('clock reminders can inject on servertool followup when explicitly enabled', async () => {
    const sessionId = 's-clock-followup-reminder';
    const clockConfig = normalizeClockConfig({ enabled: true, tickMs: 0, dueWindowMs: 60_000 });
    if (!clockConfig) throw new Error('clockConfig should not be null');
    await scheduleClockTasks(sessionId, [{ dueAtMs: Date.now() - 200, task: 'followup-inject' }], clockConfig);

    const baseRequest = {
      model: 'gpt-test',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [],
      parameters: { stream: false },
      metadata: { originalEndpoint: '/v1/chat/completions' }
    } as any;

    const result = await runHubChatProcess({
      request: baseRequest,
      requestId: 'req_clock_followup_inject',
      entryEndpoint: '/v1/chat/completions',
      rawPayload: {},
      metadata: {
        providerProtocol: 'openai-chat',
        sessionId,
        clock: { enabled: true, tickMs: 0, dueWindowMs: 60_000 },
        requestId: 'req_clock_followup_inject',
        __rt: {
          serverToolFollowup: true,
          clockFollowupInjectReminders: true
        }
      }
    });

    const processed = result.processedRequest as any;
    const messages = Array.isArray(processed.messages) ? processed.messages : [];
    const merged = messages
      .map((item: any) => (typeof item?.content === 'string' ? item.content : ''))
      .join('\n');
    expect(merged).toContain('[Clock Reminder]: scheduled tasks are due.');
    expect(merged).toContain('[scheduled task:');
    const toolNames = (Array.isArray(processed.tools) ? processed.tools : []).map((tool: any) => tool?.function?.name);
    expect(toolNames).toContain('clock');
  });

  test('unit: schedule/update/list/cancel/clear via clock handler outputs', async () => {
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
    expect(schedulePayload.scheduled?.[0]?.setBy).toBe('agent');
    expect(typeof schedulePayload.scheduled?.[0]?.setAt).toBe('string');
    const scheduledTaskId = schedulePayload.scheduled?.[0]?.taskId;
    expect(typeof scheduledTaskId).toBe('string');

    const dueAtUpdated = new Date(Date.now() + 120_000).toISOString();
    const update = await runServerSideToolEngine({
      chatResponse: {
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call_clock_update',
                  type: 'function',
                  function: {
                    name: 'clock',
                    arguments: JSON.stringify({ action: 'update', taskId: scheduledTaskId, items: [{ dueAt: dueAtUpdated, task: 't1-updated' }] })
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
      requestId: 'req-clock-handler-update',
      providerProtocol: 'openai-chat'
    });
    const updatePayload = JSON.parse((update.finalChatResponse as any).tool_outputs.slice(-1)[0].content);
    expect(updatePayload.ok).toBe(true);
    expect(updatePayload.action).toBe('update');
    expect(updatePayload.updated?.taskId).toBe(scheduledTaskId);
    expect(updatePayload.updated?.task).toBe('t1-updated');
    expect(updatePayload.updated?.dueAt).toBe(dueAtUpdated);

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
    expect(listPayload.items[0]?.task).toBe('t1-updated');
    expect(listPayload.items[0]?.taskId).toBe(scheduledTaskId);
    expect(listPayload.items[0]?.setBy).toBe('agent');
    expect(typeof listPayload.items[0]?.setAt).toBe('string');

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

  test('unit: clock.get returns time snapshot', async () => {
    const adapterContext: AdapterContext = {
      requestId: 'req-clock-get-1',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      __rt: { clock: { enabled: true, tickMs: 0 } }
    } as any;

    const result = await runServerSideToolEngine({
      chatResponse: {
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call_clock_get',
                  type: 'function',
                  function: { name: 'clock', arguments: JSON.stringify({ action: 'get', items: [], taskId: '' }) }
                }
              ]
            },
            finish_reason: 'tool_calls'
          }
        ]
      } as any,
      adapterContext,
      entryEndpoint: '/v1/chat/completions',
      requestId: 'req-clock-get-1',
      providerProtocol: 'openai-chat'
    });

    const payload = JSON.parse((result.finalChatResponse as any).tool_outputs.slice(-1)[0].content);
    expect(payload.ok).toBe(true);
    expect(payload.action).toBe('get');
    expect(typeof payload.utc).toBe('string');
    expect(typeof payload.local).toBe('string');
    expect(typeof payload.timezone).toBe('string');
    expect(typeof payload.nowMs).toBe('number');
    expect(payload.ntp).toBeDefined();
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

  test('parses <**clock:{time,message}**> marker and schedules task with tool-call style messages', async () => {
    const sessionId = 's-clock-marker-schedule';
    const dueAtIso = new Date(Date.now() + 120_000).toISOString();
    const request = buildRequest([
      {
        role: 'user',
        content: `please remind me later\n<**clock:{"time":"${dueAtIso}","message":"marker-task","recurrence":{"kind":"daily","maxRuns":2}}**>`
      }
    ]);

    const result = await runHubChatProcess({
      request,
      requestId: 'req-clock-marker-1',
      entryEndpoint: '/v1/chat/completions',
      rawPayload: {},
      metadata: {
        providerProtocol: 'openai-chat',
        sessionId,
        clock: { enabled: true, tickMs: 0 }
      }
    });

    const processed = result.processedRequest as any;
    expect(Array.isArray(processed.messages)).toBe(true);

    const assistantWithClockTool = (processed.messages as any[]).find(
      (msg) => msg?.role === 'assistant' && Array.isArray(msg?.tool_calls)
        && msg.tool_calls.some((call: any) => call?.function?.name === 'clock')
    );
    expect(assistantWithClockTool).toBeDefined();
    const callId = String(assistantWithClockTool.tool_calls[0].id || '');
    expect(callId).toContain('call_clock_marker_');

    const toolMessage = (processed.messages as any[]).find(
      (msg) => msg?.role === 'tool' && msg?.tool_call_id === callId && msg?.name === 'clock'
    );
    expect(toolMessage).toBeDefined();
    const payload = JSON.parse(String(toolMessage.content || '{}'));
    expect(payload.ok).toBe(true);
    expect(payload.action).toBe('schedule');

    const firstToolCallArgs = JSON.parse(String(assistantWithClockTool.tool_calls[0]?.function?.arguments || '{}'));
    expect(firstToolCallArgs.items?.[0]?.recurrence?.kind).toBe('daily');
    expect(firstToolCallArgs.items?.[0]?.recurrence?.maxRuns).toBe(2);

    const state = await loadClockSessionState(sessionId, normalizeClockConfig({ enabled: true, tickMs: 0 })!);
    expect(Array.isArray(state.tasks)).toBe(true);
    expect(state.tasks.some((task) => task.task === 'marker-task')).toBe(true);
    const markerTask = state.tasks.find((task) => task.task === 'marker-task');
    expect(markerTask?.setBy).toBe('user');
    expect(markerTask?.recurrence?.kind).toBe('daily');
    expect(markerTask?.recurrence?.maxRuns).toBe(2);
  });

  test('clock marker scheduling prefers daemon-scoped clock session when clockDaemonId exists', async () => {
    const sharedSessionId = 's-clock-marker-shared';
    const daemonId = 'clockd_marker_A';
    const dueAtIso = new Date(Date.now() + 120_000).toISOString();
    const request = buildRequest([
      {
        role: 'user',
        content: `please remind me later\n<**clock:{"time":"${dueAtIso}","message":"marker-daemon-task"}**>`
      }
    ]);

    const result = await runHubChatProcess({
      request,
      requestId: 'req-clock-marker-daemon-1',
      entryEndpoint: '/v1/chat/completions',
      rawPayload: {},
      metadata: {
        providerProtocol: 'openai-chat',
        sessionId: sharedSessionId,
        clockDaemonId: daemonId,
        clock: { enabled: true, tickMs: 0 }
      }
    });

    const processed = result.processedRequest as any;
    const toolMessage = (processed.messages as any[]).find(
      (msg) => msg?.role === 'tool' && msg?.name === 'clock'
    );
    expect(toolMessage).toBeDefined();
    const payload = JSON.parse(String(toolMessage.content || '{}'));
    expect(payload.ok).toBe(true);
    expect(payload.action).toBe('schedule');

    const config = normalizeClockConfig({ enabled: true, tickMs: 0 })!;
    const daemonScopedState = await loadClockSessionState(`clockd.${daemonId}`, config);
    const sharedSessionState = await loadClockSessionState(sharedSessionId, config);
    expect(daemonScopedState.tasks.some((task) => task.task === 'marker-daemon-task')).toBe(true);
    expect(sharedSessionState.tasks).toHaveLength(0);
  });


  test('keeps malformed <**clock:{time,message}**> marker unchanged and skips scheduling', async () => {
    const sessionId = 's-clock-marker-invalid';
    const request = buildRequest([
      {
        role: 'user',
        content: 'please remind me later\n<**clock:{"time":"not-a-time","message":"marker-task"}**>'
      }
    ]);

    const result = await runHubChatProcess({
      request,
      requestId: 'req-clock-marker-invalid-1',
      entryEndpoint: '/v1/chat/completions',
      rawPayload: {},
      metadata: {
        providerProtocol: 'openai-chat',
        sessionId,
        clock: { enabled: true, tickMs: 0 }
      }
    });

    const processed = result.processedRequest as any;
    expect(Array.isArray(processed.messages)).toBe(true);

    const latestUser = (processed.messages as any[])
      .slice()
      .reverse()
      .find((msg) => msg?.role === 'user');
    expect(String(latestUser?.content || '')).toContain('<**clock:{"time":"not-a-time","message":"marker-task"}**>');

    const assistantWithClockTool = (processed.messages as any[]).find(
      (msg) => msg?.role === 'assistant' && Array.isArray(msg?.tool_calls)
        && msg.tool_calls.some((call: any) => call?.function?.name === 'clock')
    );
    expect(assistantWithClockTool).toBeUndefined();

    const state = await loadClockSessionState(sessionId, normalizeClockConfig({ enabled: true, tickMs: 0 })!);
    expect(Array.isArray(state.tasks)).toBe(true);
    expect(state.tasks).toHaveLength(0);
  });

  test('clock.schedule supports recurrence with maxRuns', async () => {
    const sessionId = `s-clock-recur-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const adapterContext: AdapterContext = {
      requestId: 'req-clock-recur-1',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      sessionId,
      __rt: { clock: { enabled: true, tickMs: 0 } },
      capturedChatRequest: {
        model: 'gpt-test',
        messages: [{ role: 'user', content: 'schedule recurring task' }]
      }
    } as any;

    const dueAt = new Date(Date.now() + 30_000).toISOString();
    const schedule = await runServerSideToolEngine({
      chatResponse: {
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call_clock_schedule_recur',
                  type: 'function',
                  function: {
                    name: 'clock',
                    arguments: JSON.stringify({
                      action: 'schedule',
                      items: [
                        {
                          dueAt,
                          task: 'recurring-task',
                          recurrence: { kind: 'interval', everyMinutes: 2, maxRuns: 3 }
                        }
                      ]
                    })
                  }
                }
              ]
            },
            finish_reason: 'tool_calls'
          }
        ]
      } as JsonObject,
      adapterContext,
      requestId: 'req-clock-recur-1',
      entryEndpoint: '/v1/chat/completions'
    });

    const outputs = (schedule.finalChatResponse as any)?.tool_outputs || [];
    expect(outputs.length).toBeGreaterThan(0);
    const payload = JSON.parse(String(outputs[outputs.length - 1]?.content || '{}'));
    expect(payload.ok).toBe(true);
    expect(Array.isArray(payload.scheduled)).toBe(true);
    expect(payload.scheduled[0]?.recurrence?.kind).toBe('interval');
    expect(payload.scheduled[0]?.recurrence?.maxRuns).toBe(3);
  });

  test('recurring tasks are persisted and re-scheduled until maxRuns', async () => {
    const sessionId = `s-clock-recurring-commit-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const clockConfig = normalizeClockConfig({ enabled: true, tickMs: 0, dueWindowMs: 0 });
    if (!clockConfig) {
      throw new Error('clockConfig should not be null');
    }

    await scheduleClockTasks(
      sessionId,
      [
        {
          dueAtMs: Date.now() - 100,
          task: 'recurring-commit',
          recurrence: { kind: 'interval', everyMinutes: 1, maxRuns: 2 }
        }
      ],
      clockConfig
    );

    const reserved1 = await reserveDueTasksForRequest({
      reservationId: 'resv-1',
      sessionId,
      config: clockConfig,
      requestId: 'req-resv-1'
    });
    expect(reserved1.reservation).toBeTruthy();
    await commitClockReservation(reserved1.reservation as any, clockConfig);

    const afterFirst = await loadClockSessionState(sessionId, clockConfig);
    expect(afterFirst.tasks).toHaveLength(1);
    expect(afterFirst.tasks[0].deliveryCount).toBe(1);
    expect(afterFirst.tasks[0].deliveredAtMs).toBeUndefined();

    const reserved2 = await reserveDueTasksForRequest({
      reservationId: 'resv-2',
      sessionId,
      config: clockConfig,
      requestId: 'req-resv-2'
    });
    const guard = reserved2.reservation || {
      reservationId: 'resv-2-fallback',
      sessionId,
      taskIds: [afterFirst.tasks[0].taskId],
      reservedAtMs: Date.now()
    };
    await commitClockReservation(guard as any, clockConfig);

    const stateFile = path.join(SESSION_DIR, 'clock', `${sessionId}.json`);
    expect(fs.existsSync(stateFile)).toBe(false);
  });

  test('clock handler auto-generates tool_call_id when missing', async () => {
    const adapterContext: AdapterContext = {
      requestId: 'req-clock-missing-id',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      sessionId: 's-clock-missing-id',
      __rt: { clock: { enabled: true, tickMs: 0 } }
    } as any;

    const result = await runServerSideToolEngine({
      chatResponse: {
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: '',
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
      requestId: 'req-clock-missing-id',
      providerProtocol: 'openai-chat'
    });

    const outputs = (result.finalChatResponse as any).tool_outputs;
    expect(Array.isArray(outputs)).toBe(true);
    const last = outputs[outputs.length - 1];
    expect(typeof last.tool_call_id).toBe('string');
    expect(String(last.tool_call_id)).toContain('call_servertool_fallback_');
  });

  afterAll(() => {
    resetSessionDir();
    // keep ROUTECODEX_SESSION_DIR for other test suites (each jest worker has isolated env).
  });
});
