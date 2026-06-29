import { jest } from '@jest/globals';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { runServerToolOrchestration as runServerToolOrchestrationRaw } from '../../sharedmodule/llmswitch-core/src/servertool/engine.js';
import type { AdapterContext } from '../../sharedmodule/llmswitch-core/src/conversion/hub/types/chat-envelope.js';
import type { JsonObject } from '../../sharedmodule/llmswitch-core/src/conversion/hub/types/json.js';
import { serializeRoutingInstructionState, type RoutingInstructionState } from '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-virtual-router-routing-state.js';
import { MetadataCenter } from '../../src/server/runtime/http-server/metadata-center/metadata-center.js';
type ProgressFileLoggerModule = {
  appendServerToolProgressFileEvent?: (event: {
    requestId: string;
    flowId: string;
    tool: string;
    stage: string;
    result: string;
    message: string;
    step: number;
    entryEndpoint?: string;
    providerProtocol?: string;
  }) => void;
  flushServerToolProgressFileLoggerForTests?: () => Promise<void>;
  resetServerToolProgressFileLoggerForTests?: () => void;
};

const progressFileLoggerRuntimePath = path.join(
  process.cwd(),
  'node_modules',
  '@jsonstudio',
  'llms',
  'dist',
  'servertool',
  'log',
  'progress-file.js'
);
const supportsProgressFileLogger = fs.existsSync(progressFileLoggerRuntimePath);
const testIfProgressFileLogger = supportsProgressFileLogger ? test : test.skip;

let flushServerToolProgressFileLoggerForTests: () => Promise<void> = async () => {};
let resetServerToolProgressFileLoggerForTests: () => void = () => {};

function bindMetadataCenter<T extends Record<string, unknown>>(context: T): T {
  MetadataCenter.attach(context);
  return context;
}

async function runServerToolOrchestration(
  args: Parameters<typeof runServerToolOrchestrationRaw>[0]
): ReturnType<typeof runServerToolOrchestrationRaw> {
  const nextArgs = {
    ...args,
    ...(typeof (args as Record<string, unknown>).clientInjectDispatch === 'function'
      ? {}
      : {
          clientInjectDispatch: async (dispatchArgs: {
            entryEndpoint: string;
            requestId: string;
            body?: JsonObject;
            metadata?: JsonObject;
          }) => {
            if (typeof (args as Record<string, unknown>).reenterPipeline !== 'function') {
              return { ok: false as const, reason: 'client_inject_dispatcher_unavailable' };
            }
            await (args as Record<string, any>).reenterPipeline({
              entryEndpoint: dispatchArgs.entryEndpoint,
              requestId: dispatchArgs.requestId,
              body: (dispatchArgs.body as JsonObject) ?? ({} as JsonObject),
              metadata: dispatchArgs.metadata
            });
            return { ok: true as const };
          }
        })
  } as Parameters<typeof runServerToolOrchestrationRaw>[0];
  return runServerToolOrchestrationRaw(nextArgs);
}

const serverToolEngineRuntimePath = path.join(
  process.cwd(),
  'sharedmodule',
  'llmswitch-core',
  'src',
  'servertool',
  'progress-log-block.ts'
);
const supportsProgressConsoleLogs =
  fs.existsSync(serverToolEngineRuntimePath) &&
  fs.readFileSync(serverToolEngineRuntimePath, 'utf8').includes('[servertool]');
const testIfProgressConsoleLogs = supportsProgressConsoleLogs ? test : test.skip;

beforeAll(async () => {
  if (!supportsProgressFileLogger) {
    return;
  }
  const mod = (await import(
    '../../sharedmodule/llmswitch-core/src/servertool/log/progress-file.js'
  )) as ProgressFileLoggerModule;
  flushServerToolProgressFileLoggerForTests =
    mod.flushServerToolProgressFileLoggerForTests ?? (async () => {});
  resetServerToolProgressFileLoggerForTests =
    mod.resetServerToolProgressFileLoggerForTests ?? (() => {});
});

afterAll(() => {
});

describe('servertool progress logging', () => {
  testIfProgressConsoleLogs('prints concise yellow log with tool/stage/result for stop_message_auto flow', async () => {
    const SESSION_DIR = path.join(process.cwd(), 'tmp', 'jest-progress-sessions');
    const ORIGINAL = process.env.ROUTECODEX_SESSION_DIR;
    process.env.ROUTECODEX_SESSION_DIR = SESSION_DIR;
    const sessionId = 'sess-progress-1';
    fs.mkdirSync(SESSION_DIR, { recursive: true });
    const filepath = path.join(SESSION_DIR, `tmux-${sessionId}.json`);
    const state: RoutingInstructionState = {
      forcedTarget: undefined,
        allowedProviders: new Set(),
      disabledProviders: new Set(),
      disabledKeys: new Map(),
      disabledModels: new Map(),
      stopMessageText: '继续',
      stopMessageMaxRepeats: 1,
      stopMessageUsed: 0,
      stopMessageUpdatedAt: Date.now()
    };
    fs.writeFileSync(filepath, JSON.stringify({ version: 1, state: serializeRoutingInstructionState(state) }), {
      encoding: 'utf8'
    });

    const spy = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const adapterContext: AdapterContext = bindMetadataCenter({
        requestId: 'req-progress-1',
        entryEndpoint: '/v1/chat/completions',
        providerProtocol: 'openai-chat',
        sessionId,
        tmuxSessionId: sessionId,
        clientTmuxSessionId: sessionId,
        capturedChatRequest: {
          model: 'gpt-test',
          messages: [{ role: 'user', content: 'hi' }]
        }
      } as any);

      const responsesPayload: JsonObject = {
        id: 'chatcmpl-progress-1',
        object: 'chat.completion',
        model: 'gpt-test',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: 'ok'
            },
            finish_reason: 'stop'
          }
        ]
      };

      await runServerToolOrchestration({
        chat: responsesPayload,
        adapterContext,
        requestId: 'req-progress-1',
        entryEndpoint: '/v1/chat/completions',
        providerProtocol: 'openai-chat',
        reenterPipeline: async () => {
          return {
            body: {
              id: 'chatcmpl-progress-followup-1',
              object: 'chat.completion',
              model: 'gpt-test',
              choices: [
                {
                  index: 0,
                  message: {
                    role: 'assistant',
                    content: 'done'
                  },
                  finish_reason: 'stop'
                }
              ]
            } as JsonObject
          };
        }
      });

      const lines = spy.mock.calls.map((c) => String(c[0] ?? ''));
      const servertoolLines = lines.filter((l) => l.includes('[servertool]') && l.includes('tool=stop_message_auto'));
      expect(servertoolLines).toHaveLength(1);
      expect(servertoolLines[0]).toContain('stage=summary');
      expect(servertoolLines[0]).toContain('match=activated');
      expect(servertoolLines[0]).toContain('decision=trigger');
    } finally {
      spy.mockRestore();
      if (ORIGINAL === undefined) {
        delete process.env.ROUTECODEX_SESSION_DIR;
      } else {
        process.env.ROUTECODEX_SESSION_DIR = ORIGINAL;
      }
      try {
        fs.unlinkSync(filepath);
      } catch {}
    }
  });

  testIfProgressConsoleLogs('prints one stop summary log when finish_reason=stop is observed', async () => {
    const spy = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const adapterContext: AdapterContext = bindMetadataCenter({
        requestId: 'req-stop-entry-skip-1',
        entryEndpoint: '/v1/responses',
        providerProtocol: 'openai-chat',
        capturedChatRequest: {
          model: 'gpt-test',
          messages: [{ role: 'user', content: 'hi' }]
        }
      } as any);

      const chatPayload: JsonObject = {
        id: 'chatcmpl-stop-entry-skip-1',
        object: 'chat.completion',
        model: 'gpt-test',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: 'ok'
            },
            finish_reason: 'stop'
          }
        ]
      };

      await runServerToolOrchestration({
        chat: chatPayload,
        adapterContext,
        requestId: 'req-stop-entry-skip-1',
        entryEndpoint: '/v1/responses',
        providerProtocol: 'openai-chat',
        reenterPipeline: async () => ({
          body: {
            id: 'chatcmpl-stop-entry-followup-1',
            object: 'chat.completion',
            model: 'gpt-test',
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: 'done' },
                finish_reason: 'stop'
              }
            ]
          } as JsonObject
        })
      });

      const lines = spy.mock.calls.map((c) => String(c[0] ?? ''));
      const servertoolLines = lines.filter((l) => l.includes('[servertool]') && l.includes('tool=stop_message_auto'));
      expect(servertoolLines).toHaveLength(1);
      expect(servertoolLines[0]).toContain('stage=summary');
      expect(servertoolLines[0]).toContain('source=chat');
      expect(servertoolLines[0]).toContain('finish_reason=');
      expect(servertoolLines[0]).toContain('match=activated');
      expect(servertoolLines[0]).toContain('decision=trigger');
    } finally {
      spy.mockRestore();
    }
  });


  testIfProgressConsoleLogs('retired continue_execution flow fails fast and does not print stop_message_auto summary logs', async () => {
    const spy = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const adapterContext: AdapterContext = {
        requestId: 'req-noop-1',
        entryEndpoint: '/v1/responses',
        providerProtocol: 'openai-responses',
        capturedChatRequest: {
          model: 'gpt-test',
          messages: [{ role: 'user', content: '继续执行，不要中断总结' }]
        }
      } as any;

      const toolCallPayload: JsonObject = {
        id: 'chatcmpl-noop-1',
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
                  id: 'call_continue_execution_1',
                  type: 'function',
                  function: {
                    name: 'continue_execution',
                    arguments: '{}'
                  }
                }
              ]
            },
            finish_reason: 'tool_calls'
          }
        ]
      };

      await expect(
        runServerToolOrchestration({
          chat: toolCallPayload,
          adapterContext,
          requestId: 'req-noop-1',
          entryEndpoint: '/v1/responses',
          providerProtocol: 'openai-responses',
          reenterPipeline: async () => ({
            body: {
              id: 'chatcmpl-noop-followup-1',
              object: 'chat.completion',
              model: 'gpt-test',
              choices: [
                {
                  index: 0,
                  message: { role: 'assistant', content: '继续执行中' },
                  finish_reason: 'stop'
                }
              ]
            } as JsonObject
          }),
          clientInjectDispatch: async () => ({ ok: true })
        })
      ).rejects.toMatchObject({
        code: 'SERVERTOOL_REENTER_RETIRED'
      });

      const lines = spy.mock.calls.map((c) => String(c[0] ?? ''));
      const servertoolLines = lines.filter((l) => l.includes('[servertool]') && l.includes('tool=stop_message_auto'));
      expect(servertoolLines).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });

  testIfProgressFileLogger('tracks stopMessage rounds and clears persisted state at max repeats', async () => {
    const logDir = path.join(process.cwd(), 'tmp', 'jest-servertool-stop-lifecycle-log');
    fs.mkdirSync(logDir, { recursive: true });
    const logPath = path.join(logDir, `events-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);

    const sessionDir = path.join(process.cwd(), 'tmp', 'jest-progress-sessions-stop-lifecycle');
    const originalSessionDir = process.env.ROUTECODEX_SESSION_DIR;
    const originalEnable = process.env.ROUTECODEX_SERVERTOOL_FILE_LOG;
    const originalPath = process.env.ROUTECODEX_SERVERTOOL_FILE_LOG_PATH;

    process.env.ROUTECODEX_SESSION_DIR = sessionDir;
    process.env.ROUTECODEX_SERVERTOOL_FILE_LOG = '1';
    process.env.ROUTECODEX_SERVERTOOL_FILE_LOG_PATH = logPath;
    resetServerToolProgressFileLoggerForTests();

    const sessionId = `sess-stop-lifecycle-${Date.now()}`;
    fs.mkdirSync(sessionDir, { recursive: true });
    const sessionFile = path.join(sessionDir, `tmux-${sessionId}.json`);
    const state: RoutingInstructionState = {
      forcedTarget: undefined,
        allowedProviders: new Set(),
      disabledProviders: new Set(),
      disabledKeys: new Map(),
      disabledModels: new Map(),
      stopMessageText: '继续',
      stopMessageMaxRepeats: 2,
      stopMessageUsed: 0,
      stopMessageStageMode: 'on',
      stopMessageUpdatedAt: Date.now()
    };
    fs.writeFileSync(sessionFile, JSON.stringify({ version: 1, state: serializeRoutingInstructionState(state) }), 'utf8');

    const spy = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const adapterContext: AdapterContext = {
        requestId: 'req-stop-lifecycle-1',
        entryEndpoint: '/v1/chat/completions',
        providerProtocol: 'openai-chat',
        sessionId,
        tmuxSessionId: sessionId,
        clientTmuxSessionId: sessionId,
        capturedChatRequest: {
          model: 'gpt-test',
          messages: [{ role: 'user', content: '继续执行' }]
        }
      } as any;

      const payload: JsonObject = {
        id: 'chatcmpl-stop-lifecycle',
        object: 'chat.completion',
        model: 'gpt-test',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: 'ok'
            },
            finish_reason: 'stop'
          }
        ]
      };

      await runServerToolOrchestration({
        chat: payload,
        adapterContext,
        requestId: 'req-stop-lifecycle-1',
        entryEndpoint: '/v1/chat/completions',
        providerProtocol: 'openai-chat',
        reenterPipeline: async () => ({
          body: {
            id: 'chatcmpl-stop-lifecycle-followup-1',
            object: 'chat.completion',
            model: 'gpt-test',
            choices: [
              {
                index: 0,
                message: {
                  role: 'assistant',
                  content: 'done-1'
                },
                finish_reason: 'stop'
              }
            ]
          } as JsonObject
        })
      });

      const persistedAfterFirst = JSON.parse(fs.readFileSync(sessionFile, 'utf8')) as any;
      expect(persistedAfterFirst?.state?.stopMessageUsed).toBe(1);
      expect(persistedAfterFirst?.state?.stopMessageMaxRepeats).toBe(2);
      expect(persistedAfterFirst?.state?.stopMessageText).toBe('继续');

      await runServerToolOrchestration({
        chat: payload,
        adapterContext,
        requestId: 'req-stop-lifecycle-2',
        entryEndpoint: '/v1/chat/completions',
        providerProtocol: 'openai-chat',
        reenterPipeline: async () => ({
          body: {
            id: 'chatcmpl-stop-lifecycle-followup-2',
            object: 'chat.completion',
            model: 'gpt-test',
            choices: [
              {
                index: 0,
                message: {
                  role: 'assistant',
                  content: 'done-2'
                },
                finish_reason: 'stop'
              }
            ]
          } as JsonObject
        })
      });

      expect(fs.existsSync(sessionFile)).toBe(true);
      const persistedAfterSecond = JSON.parse(fs.readFileSync(sessionFile, 'utf8')) as any;
      expect(persistedAfterSecond?.state?.stopMessageText).toBeUndefined();
      expect(persistedAfterSecond?.state?.stopMessageMaxRepeats).toBeUndefined();
      expect(persistedAfterSecond?.state?.stopMessageUsed).toBeUndefined();
      expect(typeof persistedAfterSecond?.state?.stopMessageUpdatedAt).toBe('number');

      await flushServerToolProgressFileLoggerForTests();
      const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean);
      const events = lines.map((line) => JSON.parse(line));

      const compare1 = events.find((event) => event.requestId === 'req-stop-lifecycle-1' && event.stage === 'compare');
      const compare2 = events.find((event) => event.requestId === 'req-stop-lifecycle-2' && event.stage === 'compare');
      expect(compare1?.message).toContain('decision=trigger');
      expect(compare1?.message).toContain('max=2');
      expect(compare1?.message).toContain('used=1');
      expect(compare1?.message).toContain('left=1');
      expect(compare1?.message).toContain('active=true');
      expect(compare2?.message).toContain('decision=trigger');
      expect(compare2?.message).toContain('max=2');
      expect(compare2?.message).toContain('used=2');
      expect(compare2?.message).toContain('left=0');
      expect(compare2?.message).toContain('active=true');

      const consoleLines = spy.mock.calls.map((c) => String(c[0] ?? ''));
      expect(
        consoleLines.some(
          (line) =>
            line.includes('[servertool]') &&
            line.includes('tool=stop_message_auto') &&
            line.includes('stage=compare') &&
            line.includes('requestId=req-stop-lifecycle-1') &&
            line.includes('used=1') &&
            line.includes('left=1')
        )
      ).toBe(true);
      expect(
        consoleLines.some(
          (line) =>
            line.includes('[servertool]') &&
            line.includes('tool=stop_message_auto') &&
            line.includes('stage=compare') &&
            line.includes('requestId=req-stop-lifecycle-2') &&
            line.includes('used=2') &&
            line.includes('left=0')
        )
      ).toBe(true);
    } finally {
      spy.mockRestore();
      resetServerToolProgressFileLoggerForTests();
      if (originalSessionDir === undefined) {
        delete process.env.ROUTECODEX_SESSION_DIR;
      } else {
        process.env.ROUTECODEX_SESSION_DIR = originalSessionDir;
      }
      if (originalEnable === undefined) {
        delete process.env.ROUTECODEX_SERVERTOOL_FILE_LOG;
      } else {
        process.env.ROUTECODEX_SERVERTOOL_FILE_LOG = originalEnable;
      }
      if (originalPath === undefined) {
        delete process.env.ROUTECODEX_SERVERTOOL_FILE_LOG_PATH;
      } else {
        process.env.ROUTECODEX_SERVERTOOL_FILE_LOG_PATH = originalPath;
      }
      try {
        fs.unlinkSync(sessionFile);
      } catch {}
      try {
        fs.unlinkSync(logPath);
      } catch {}
    }
  });

  testIfProgressFileLogger('writes servertool JSONL file logs when enabled', async () => {
    const logDir = path.join(process.cwd(), 'tmp', 'jest-servertool-file-log');
    fs.mkdirSync(logDir, { recursive: true });
    const logPath = path.join(logDir, `events-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);

    const sessionDir = path.join(process.cwd(), 'tmp', 'jest-progress-sessions-filelog-enabled');
    const originalSessionDir = process.env.ROUTECODEX_SESSION_DIR;
    const originalEnable = process.env.ROUTECODEX_SERVERTOOL_FILE_LOG;
    const originalPath = process.env.ROUTECODEX_SERVERTOOL_FILE_LOG_PATH;

    process.env.ROUTECODEX_SESSION_DIR = sessionDir;
    process.env.ROUTECODEX_SERVERTOOL_FILE_LOG = '1';
    process.env.ROUTECODEX_SERVERTOOL_FILE_LOG_PATH = logPath;
    resetServerToolProgressFileLoggerForTests();

    const sessionId = `sess-filelog-enabled-${Date.now()}`;
    fs.mkdirSync(sessionDir, { recursive: true });
    const sessionFile = path.join(sessionDir, `tmux-${sessionId}.json`);
    const state: RoutingInstructionState = {
      forcedTarget: undefined,
        allowedProviders: new Set(),
      disabledProviders: new Set(),
      disabledKeys: new Map(),
      disabledModels: new Map(),
      stopMessageText: '继续',
      stopMessageMaxRepeats: 1,
      stopMessageUsed: 0,
      stopMessageUpdatedAt: Date.now()
    };
    fs.writeFileSync(sessionFile, JSON.stringify({ version: 1, state: serializeRoutingInstructionState(state) }), 'utf8');

    try {
      const adapterContext: AdapterContext = {
        requestId: 'req-filelog-enabled',
        entryEndpoint: '/v1/chat/completions',
        providerProtocol: 'openai-chat',
        sessionId,
        tmuxSessionId: sessionId,
        clientTmuxSessionId: sessionId,
        capturedChatRequest: {
          model: 'gpt-test',
          messages: [{ role: 'user', content: 'hi' }]
        }
      } as any;

      const payload: JsonObject = {
        id: 'chatcmpl-filelog-enabled',
        object: 'chat.completion',
        model: 'gpt-test',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: 'ok'
            },
            finish_reason: 'stop'
          }
        ]
      };

      await runServerToolOrchestration({
        chat: payload,
        adapterContext,
        requestId: 'req-filelog-enabled',
        entryEndpoint: '/v1/chat/completions',
        providerProtocol: 'openai-chat',
        reenterPipeline: async () => ({
          body: {
            id: 'chatcmpl-filelog-enabled-followup',
            object: 'chat.completion',
            model: 'gpt-test',
            choices: [
              {
                index: 0,
                message: {
                  role: 'assistant',
                  content: 'done'
                },
                finish_reason: 'stop'
              }
            ]
          } as JsonObject
        })
      });

      await flushServerToolProgressFileLoggerForTests();
      expect(fs.existsSync(logPath)).toBe(true);

      const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean);
      expect(lines.length).toBeGreaterThanOrEqual(2);
      const events = lines.map((line) => JSON.parse(line));
      expect(events.some((event) => event.requestId === 'req-filelog-enabled' && event.stage === 'match' && event.tool === 'stop_message_auto')).toBe(true);
      expect(events.some((event) => event.requestId === 'req-filelog-enabled' && event.stage === 'compare' && event.tool === 'stop_message_auto')).toBe(true);
      expect(events.some((event) => event.requestId === 'req-filelog-enabled' && event.stage === 'final' && event.tool === 'stop_message_auto')).toBe(true);
    } finally {
      resetServerToolProgressFileLoggerForTests();
      if (originalSessionDir === undefined) {
        delete process.env.ROUTECODEX_SESSION_DIR;
      } else {
        process.env.ROUTECODEX_SESSION_DIR = originalSessionDir;
      }
      if (originalEnable === undefined) {
        delete process.env.ROUTECODEX_SERVERTOOL_FILE_LOG;
      } else {
        process.env.ROUTECODEX_SERVERTOOL_FILE_LOG = originalEnable;
      }
      if (originalPath === undefined) {
        delete process.env.ROUTECODEX_SERVERTOOL_FILE_LOG_PATH;
      } else {
        process.env.ROUTECODEX_SERVERTOOL_FILE_LOG_PATH = originalPath;
      }
      try {
        fs.unlinkSync(sessionFile);
      } catch {}
      try {
        fs.unlinkSync(logPath);
      } catch {}
    }
  });

  testIfProgressFileLogger('does not write servertool JSONL file logs when disabled', async () => {
    const logDir = path.join(process.cwd(), 'tmp', 'jest-servertool-file-log');
    fs.mkdirSync(logDir, { recursive: true });
    const logPath = path.join(logDir, `events-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);

    const sessionDir = path.join(process.cwd(), 'tmp', 'jest-progress-sessions-filelog-disabled');
    const originalSessionDir = process.env.ROUTECODEX_SESSION_DIR;
    const originalEnable = process.env.ROUTECODEX_SERVERTOOL_FILE_LOG;
    const originalPath = process.env.ROUTECODEX_SERVERTOOL_FILE_LOG_PATH;

    process.env.ROUTECODEX_SESSION_DIR = sessionDir;
    process.env.ROUTECODEX_SERVERTOOL_FILE_LOG = '0';
    process.env.ROUTECODEX_SERVERTOOL_FILE_LOG_PATH = logPath;
    resetServerToolProgressFileLoggerForTests();

    const sessionId = `sess-filelog-disabled-${Date.now()}`;
    fs.mkdirSync(sessionDir, { recursive: true });
    const sessionFile = path.join(sessionDir, `tmux-${sessionId}.json`);
    const state: RoutingInstructionState = {
      forcedTarget: undefined,
        allowedProviders: new Set(),
      disabledProviders: new Set(),
      disabledKeys: new Map(),
      disabledModels: new Map(),
      stopMessageText: '继续',
      stopMessageMaxRepeats: 1,
      stopMessageUsed: 0,
      stopMessageUpdatedAt: Date.now()
    };
    fs.writeFileSync(sessionFile, JSON.stringify({ version: 1, state: serializeRoutingInstructionState(state) }), 'utf8');

    try {
      const adapterContext: AdapterContext = {
        requestId: 'req-filelog-disabled',
        entryEndpoint: '/v1/chat/completions',
        providerProtocol: 'openai-chat',
        sessionId,
        tmuxSessionId: sessionId,
        clientTmuxSessionId: sessionId,
        capturedChatRequest: {
          model: 'gpt-test',
          messages: [{ role: 'user', content: 'hi' }]
        }
      } as any;

      const payload: JsonObject = {
        id: 'chatcmpl-filelog-disabled',
        object: 'chat.completion',
        model: 'gpt-test',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: 'ok'
            },
            finish_reason: 'stop'
          }
        ]
      };

      await runServerToolOrchestration({
        chat: payload,
        adapterContext,
        requestId: 'req-filelog-disabled',
        entryEndpoint: '/v1/chat/completions',
        providerProtocol: 'openai-chat',
        reenterPipeline: async () => ({
          body: {
            id: 'chatcmpl-filelog-disabled-followup',
            object: 'chat.completion',
            model: 'gpt-test',
            choices: [
              {
                index: 0,
                message: {
                  role: 'assistant',
                  content: 'done'
                },
                finish_reason: 'stop'
              }
            ]
          } as JsonObject
        })
      });

      await flushServerToolProgressFileLoggerForTests();
      expect(fs.existsSync(logPath)).toBe(false);
    } finally {
      resetServerToolProgressFileLoggerForTests();
      if (originalSessionDir === undefined) {
        delete process.env.ROUTECODEX_SESSION_DIR;
      } else {
        process.env.ROUTECODEX_SESSION_DIR = originalSessionDir;
      }
      if (originalEnable === undefined) {
        delete process.env.ROUTECODEX_SERVERTOOL_FILE_LOG;
      } else {
        process.env.ROUTECODEX_SERVERTOOL_FILE_LOG = originalEnable;
      }
      if (originalPath === undefined) {
        delete process.env.ROUTECODEX_SERVERTOOL_FILE_LOG_PATH;
      } else {
        process.env.ROUTECODEX_SERVERTOOL_FILE_LOG_PATH = originalPath;
      }
      try {
        fs.unlinkSync(sessionFile);
      } catch {}
      try {
        fs.unlinkSync(logPath);
      } catch {}
    }
  });

  test('enabled servertool JSONL file logging exposes write failures', async () => {
    const logRoot = path.join(process.cwd(), 'tmp', 'jest-servertool-file-log-failfast');
    fs.mkdirSync(logRoot, { recursive: true });
    const fileAsParent = path.join(logRoot, `not-a-dir-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.writeFileSync(fileAsParent, 'not a directory', 'utf8');

    const originalEnable = process.env.ROUTECODEX_SERVERTOOL_FILE_LOG;
    const originalPath = process.env.ROUTECODEX_SERVERTOOL_FILE_LOG_PATH;

    const mod = (await import(
      '../../sharedmodule/llmswitch-core/src/servertool/log/progress-file.js'
    )) as ProgressFileLoggerModule;
    const append = mod.appendServerToolProgressFileEvent;
    const flush = mod.flushServerToolProgressFileLoggerForTests;
    const reset = mod.resetServerToolProgressFileLoggerForTests;
    expect(typeof append).toBe('function');
    expect(typeof flush).toBe('function');
    expect(typeof reset).toBe('function');

    process.env.ROUTECODEX_SERVERTOOL_FILE_LOG = '1';
    process.env.ROUTECODEX_SERVERTOOL_FILE_LOG_PATH = path.join(fileAsParent, 'events.jsonl');
    reset?.();

    try {
      append?.({
        requestId: 'req-filelog-failfast',
        flowId: 'stop_message_flow',
        tool: 'stop_message_auto',
        stage: 'match',
        result: 'trigger',
        message: 'trigger',
        step: 1,
        entryEndpoint: '/v1/responses',
        providerProtocol: 'openai-responses'
      });
      await expect(flush?.()).rejects.toThrow();
    } finally {
      reset?.();
      if (originalEnable === undefined) {
        delete process.env.ROUTECODEX_SERVERTOOL_FILE_LOG;
      } else {
        process.env.ROUTECODEX_SERVERTOOL_FILE_LOG = originalEnable;
      }
      if (originalPath === undefined) {
        delete process.env.ROUTECODEX_SERVERTOOL_FILE_LOG_PATH;
      } else {
        process.env.ROUTECODEX_SERVERTOOL_FILE_LOG_PATH = originalPath;
      }
      try {
        fs.unlinkSync(fileAsParent);
      } catch {}
    }
  });

});
