import * as fs from 'node:fs';
import * as path from 'node:path';
import { runServerSideToolEngine } from '../../sharedmodule/llmswitch-core/src/servertool/server-side-tools.js';
import { runServerToolOrchestration } from '../../sharedmodule/llmswitch-core/src/servertool/engine.js';
import type { AdapterContext } from '../../sharedmodule/llmswitch-core/src/conversion/hub/types/chat-envelope.js';
import type { JsonObject } from '../../sharedmodule/llmswitch-core/src/conversion/hub/types/json.js';
import {
  serializeRoutingInstructionState,
  type RoutingInstructionState
} from '../../sharedmodule/llmswitch-core/src/router/virtual-router/routing-instructions.js';
import { buildResponsesRequestFromChat } from '../../sharedmodule/llmswitch-core/src/conversion/responses/responses-openai-bridge.js';
import { extractBlockedReportFromMessagesForTests } from '../../sharedmodule/llmswitch-core/src/servertool/handlers/stop-message-auto.js';
import { resolveStickyKey } from '../../sharedmodule/llmswitch-core/src/servertool/handlers/stop-message-auto/runtime-utils.js';

const SESSION_DIR = path.join(process.cwd(), 'tmp', 'jest-stopmessage-sessions');
const USER_DIR = path.join(process.cwd(), 'tmp', 'jest-stopmessage-userdir');
const DEFAULT_MOCK_IFLOW_BIN_PATH = path.join(USER_DIR, 'mock-iflow-default.sh');
const DEFAULT_MOCK_CODEX_BIN_PATH = path.join(USER_DIR, 'mock-codex-default.sh');
const EXECUTION_APPEND_TEXT = '请直接继续执行，不要进行状态汇总';
const ORIGINAL_STOPMESSAGE_AI_FOLLOWUP_ENABLED = process.env.ROUTECODEX_STOPMESSAGE_AI_FOLLOWUP_ENABLED;
const ORIGINAL_STOPMESSAGE_AI_FOLLOWUP_BACKEND = process.env.ROUTECODEX_STOPMESSAGE_AI_FOLLOWUP_BACKEND;
const ORIGINAL_STOPMESSAGE_AI_FOLLOWUP_IFLOW_BIN = process.env.ROUTECODEX_STOPMESSAGE_AI_FOLLOWUP_IFLOW_BIN;
const ORIGINAL_STOPMESSAGE_AI_FOLLOWUP_CODEX_BIN = process.env.ROUTECODEX_STOPMESSAGE_AI_FOLLOWUP_CODEX_BIN;
const ORIGINAL_STOPMESSAGE_AUTOMESSAGE_IFLOW = process.env.ROUTECODEX_STOPMESSAGE_AUTOMESSAGE_IFLOW;
const ORIGINAL_STOPMESSAGE_AUTOMESSAGE_IFLOW_BIN = process.env.ROUTECODEX_STOPMESSAGE_AUTOMESSAGE_IFLOW_BIN;
const ORIGINAL_STOPMESSAGE_AUTOMESSAGE_BACKEND = process.env.ROUTECODEX_STOPMESSAGE_AUTOMESSAGE_BACKEND;
const ORIGINAL_STOPMESSAGE_AUTOMESSAGE_CODEX_BIN = process.env.ROUTECODEX_STOPMESSAGE_AUTOMESSAGE_CODEX_BIN;

function writeRoutingStateForSession(sessionId: string, state: RoutingInstructionState): void {
  fs.mkdirSync(SESSION_DIR, { recursive: true });
  const filename = `session-${sessionId}.json`;
  const filepath = path.join(SESSION_DIR, filename);
  const payload = {
    version: 1,
    state: serializeRoutingInstructionState(state)
  };
  fs.writeFileSync(filepath, JSON.stringify(payload), { encoding: 'utf8' });
}

async function readJsonFileUntil<T>(
  filepath: string,
  predicate: (data: T) => boolean,
  attempts = 50,
  delayMs = 10
): Promise<T> {
  let lastError: unknown;
  let lastValue: T | undefined;
  for (let i = 0; i < attempts; i += 1) {
    try {
      const raw = fs.readFileSync(filepath, 'utf8');
      if (!raw || !raw.trim()) {
        throw new Error('empty file');
      }
      const parsed = JSON.parse(raw) as T;
      lastValue = parsed;
      if (predicate(parsed)) {
        return parsed;
      }
    } catch (err) {
      lastError = err;
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  if (lastValue !== undefined) {
    throw new Error(`condition not met for ${filepath}: ${JSON.stringify(lastValue)}`);
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError ?? 'failed to read json'));
}

async function readJsonFileWithRetry<T>(filepath: string, attempts = 50, delayMs = 10): Promise<T> {
  return readJsonFileUntil<T>(filepath, () => true, attempts, delayMs);
}

describe('stop_message_auto servertool', () => {
  beforeAll(() => {
    process.env.ROUTECODEX_SESSION_DIR = SESSION_DIR;
    process.env.ROUTECODEX_USER_DIR = USER_DIR;
    process.env.ROUTECODEX_STOPMESSAGE_STAGE_MODE = 'auto';
    fs.mkdirSync(USER_DIR, { recursive: true });
    fs.writeFileSync(
      DEFAULT_MOCK_IFLOW_BIN_PATH,
      [
        '#!/usr/bin/env bash',
        'if [ "$1" = "-p" ]; then',
        '  candidate="$(printf \'%s\\n\' "$2" | sed -n \'s/^candidateFollowup: //p\' | head -n1)"',
        '  if [ -n "$candidate" ] && [ "$candidate" != "n/a" ]; then',
        '    printf \'%s\\n\' "$candidate"',
        '  else',
        "    echo '继续执行'",
        '  fi',
        '  exit 0',
        'fi',
        'exit 2'
      ].join('\n'),
      { encoding: 'utf8' }
    );
    fs.chmodSync(DEFAULT_MOCK_IFLOW_BIN_PATH, 0o755);
    fs.writeFileSync(
      DEFAULT_MOCK_CODEX_BIN_PATH,
      [
        '#!/usr/bin/env bash',
        'if [ "$1" = "exec" ]; then',
        '  output=""',
        '  idx=1',
        '  while [ $idx -le $# ]; do',
        '    arg="${!idx}"',
        '    if [ "$arg" = "--output-last-message" ]; then',
        '      idx=$((idx + 1))',
        '      output="${!idx}"',
        '    fi',
        '    idx=$((idx + 1))',
        '  done',
        '  if [ -n "$output" ]; then',
        '    printf \'%s\\n\' "$PWD" > "$output"',
        '  fi',
        '  exit 0',
        'fi',
        'exit 2'
      ].join('\n'),
      { encoding: 'utf8' }
    );
    fs.chmodSync(DEFAULT_MOCK_CODEX_BIN_PATH, 0o755);
    process.env.ROUTECODEX_STOPMESSAGE_AI_FOLLOWUP_ENABLED = '1';
    process.env.ROUTECODEX_STOPMESSAGE_AI_FOLLOWUP_BACKEND = 'iflow';
    process.env.ROUTECODEX_STOPMESSAGE_AI_FOLLOWUP_IFLOW_BIN = DEFAULT_MOCK_IFLOW_BIN_PATH;
    process.env.ROUTECODEX_STOPMESSAGE_AUTOMESSAGE_IFLOW = '1';
    process.env.ROUTECODEX_STOPMESSAGE_AUTOMESSAGE_IFLOW_BIN = DEFAULT_MOCK_IFLOW_BIN_PATH;
    process.env.ROUTECODEX_STOPMESSAGE_AUTOMESSAGE_BACKEND = 'iflow';
  });

  afterAll(() => {
    if (ORIGINAL_STOPMESSAGE_AI_FOLLOWUP_ENABLED === undefined) {
      delete process.env.ROUTECODEX_STOPMESSAGE_AI_FOLLOWUP_ENABLED;
    } else {
      process.env.ROUTECODEX_STOPMESSAGE_AI_FOLLOWUP_ENABLED = ORIGINAL_STOPMESSAGE_AI_FOLLOWUP_ENABLED;
    }
    if (ORIGINAL_STOPMESSAGE_AI_FOLLOWUP_BACKEND === undefined) {
      delete process.env.ROUTECODEX_STOPMESSAGE_AI_FOLLOWUP_BACKEND;
    } else {
      process.env.ROUTECODEX_STOPMESSAGE_AI_FOLLOWUP_BACKEND = ORIGINAL_STOPMESSAGE_AI_FOLLOWUP_BACKEND;
    }
    if (ORIGINAL_STOPMESSAGE_AI_FOLLOWUP_IFLOW_BIN === undefined) {
      delete process.env.ROUTECODEX_STOPMESSAGE_AI_FOLLOWUP_IFLOW_BIN;
    } else {
      process.env.ROUTECODEX_STOPMESSAGE_AI_FOLLOWUP_IFLOW_BIN = ORIGINAL_STOPMESSAGE_AI_FOLLOWUP_IFLOW_BIN;
    }
    if (ORIGINAL_STOPMESSAGE_AI_FOLLOWUP_CODEX_BIN === undefined) {
      delete process.env.ROUTECODEX_STOPMESSAGE_AI_FOLLOWUP_CODEX_BIN;
    } else {
      process.env.ROUTECODEX_STOPMESSAGE_AI_FOLLOWUP_CODEX_BIN = ORIGINAL_STOPMESSAGE_AI_FOLLOWUP_CODEX_BIN;
    }
    if (ORIGINAL_STOPMESSAGE_AUTOMESSAGE_IFLOW === undefined) {
      delete process.env.ROUTECODEX_STOPMESSAGE_AUTOMESSAGE_IFLOW;
    } else {
      process.env.ROUTECODEX_STOPMESSAGE_AUTOMESSAGE_IFLOW = ORIGINAL_STOPMESSAGE_AUTOMESSAGE_IFLOW;
    }
    if (ORIGINAL_STOPMESSAGE_AUTOMESSAGE_IFLOW_BIN === undefined) {
      delete process.env.ROUTECODEX_STOPMESSAGE_AUTOMESSAGE_IFLOW_BIN;
    } else {
      process.env.ROUTECODEX_STOPMESSAGE_AUTOMESSAGE_IFLOW_BIN = ORIGINAL_STOPMESSAGE_AUTOMESSAGE_IFLOW_BIN;
    }
    if (ORIGINAL_STOPMESSAGE_AUTOMESSAGE_BACKEND === undefined) {
      delete process.env.ROUTECODEX_STOPMESSAGE_AUTOMESSAGE_BACKEND;
    } else {
      process.env.ROUTECODEX_STOPMESSAGE_AUTOMESSAGE_BACKEND = ORIGINAL_STOPMESSAGE_AUTOMESSAGE_BACKEND;
    }
    if (ORIGINAL_STOPMESSAGE_AUTOMESSAGE_CODEX_BIN === undefined) {
      delete process.env.ROUTECODEX_STOPMESSAGE_AUTOMESSAGE_CODEX_BIN;
    } else {
      process.env.ROUTECODEX_STOPMESSAGE_AUTOMESSAGE_CODEX_BIN = ORIGINAL_STOPMESSAGE_AUTOMESSAGE_CODEX_BIN;
    }
    if (fs.existsSync(DEFAULT_MOCK_IFLOW_BIN_PATH)) {
      fs.unlinkSync(DEFAULT_MOCK_IFLOW_BIN_PATH);
    }
    if (fs.existsSync(DEFAULT_MOCK_CODEX_BIN_PATH)) {
      fs.unlinkSync(DEFAULT_MOCK_CODEX_BIN_PATH);
    }
  });

  test('schedules followup when stopMessage is active and finish_reason=stop', async () => {
    const sessionId = 'stopmessage-spec-session-1';
    const state: RoutingInstructionState = {
      forcedTarget: undefined,
      stickyTarget: undefined,
      allowedProviders: new Set(),
      disabledProviders: new Set(),
      disabledKeys: new Map(),
      disabledModels: new Map(),
      stopMessageText: '立即执行待处理任务',
      stopMessageMaxRepeats: 2,
      stopMessageUsed: 0
    };
    writeRoutingStateForSession(sessionId, state);

    const capturedChatRequest: JsonObject = {
      model: 'gpt-test',
      messages: [
        {
          role: 'user',
          content: 'hi'
        }
      ]
    };

    const chatResponse: JsonObject = {
      id: 'chatcmpl-stop-1',
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

    const adapterContext: AdapterContext = {
      requestId: 'req-stopmessage-1',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      sessionId,
      capturedChatRequest
    } as any;

    const result = await runServerSideToolEngine({
      chatResponse,
      adapterContext,
      entryEndpoint: '/v1/chat/completions',
      requestId: 'req-stopmessage-1',
      providerProtocol: 'openai-chat'
    });

    expect(result.mode).toBe('tool_flow');
    expect(result.execution?.flowId).toBe('stop_message_flow');
    const followup = result.execution?.followup as any;
    expect(followup).toBeDefined();
    expect(followup.entryEndpoint).toBe('/v1/chat/completions');
    expect(Array.isArray(followup.injection?.ops)).toBe(true);
    const ops = followup.injection.ops as any[];
    expect(
      ops.some(
        (op) =>
          op?.op === 'append_user_text' &&
          typeof op?.text === 'string' &&
          op.text.includes('立即执行待处理任务') &&
          op.text.includes(EXECUTION_APPEND_TEXT)
      )
    ).toBe(true);

    const persisted = await readJsonFileUntil<{ state?: { stopMessageUsed?: number; stopMessageLastUsedAt?: number } }>(
      path.join(SESSION_DIR, `session-${sessionId}.json`),
      (data) => data?.state?.stopMessageUsed === 1 && typeof data?.state?.stopMessageLastUsedAt === 'number'
    );
    // llmswitch-core main: stopMessage usage counter increments as soon as we decide to trigger followup.
    expect(persisted?.state?.stopMessageUsed).toBe(1);
    expect(typeof persisted?.state?.stopMessageLastUsedAt).toBe('number');
  });

  test('codex backend uses session workdir as spawn cwd', async () => {
    const previousAiBackend = process.env.ROUTECODEX_STOPMESSAGE_AI_FOLLOWUP_BACKEND;
    const previousAiCodexBin = process.env.ROUTECODEX_STOPMESSAGE_AI_FOLLOWUP_CODEX_BIN;
    const previousBackend = process.env.ROUTECODEX_STOPMESSAGE_AUTOMESSAGE_BACKEND;
    const previousCodexBin = process.env.ROUTECODEX_STOPMESSAGE_AUTOMESSAGE_CODEX_BIN;
    const sessionId = 'stopmessage-spec-session-codex-cwd';
    const workdir = path.join(USER_DIR, 'codex-cwd-workdir');
    const promptCapturePath = path.join(USER_DIR, 'mock-codex-prompt.txt');
    const mockCodexBinPath = path.join(USER_DIR, 'mock-codex-cwd.sh');
    fs.mkdirSync(workdir, { recursive: true });
    process.env.ROUTECODEX_STOPMESSAGE_AI_FOLLOWUP_BACKEND = 'codex';
    process.env.ROUTECODEX_STOPMESSAGE_AI_FOLLOWUP_CODEX_BIN = mockCodexBinPath;
    process.env.ROUTECODEX_STOPMESSAGE_AUTOMESSAGE_BACKEND = 'codex';
    process.env.ROUTECODEX_STOPMESSAGE_AUTOMESSAGE_CODEX_BIN = mockCodexBinPath;
    try {
      fs.writeFileSync(
        mockCodexBinPath,
        [
          '#!/usr/bin/env bash',
          'output=""',
          'idx=1',
          'while [ $idx -le $# ]; do',
          '  arg="${!idx}"',
          '  if [ "$arg" = "--output-last-message" ]; then',
          '    idx=$((idx + 1))',
          '    output="${!idx}"',
          '  fi',
          '  idx=$((idx + 1))',
          'done',
          `printf '%s' "\${!#}" > ${JSON.stringify(promptCapturePath)}`,
          'if [ -n "$output" ]; then',
          "  printf '%s\\n' \"$PWD\" > \"$output\"",
          'fi',
          'exit 0'
        ].join('\n'),
        { encoding: 'utf8' }
      );
      fs.chmodSync(mockCodexBinPath, 0o755);

      writeRoutingStateForSession(sessionId, {
        forcedTarget: undefined,
        stickyTarget: undefined,
        allowedProviders: new Set(),
        disabledProviders: new Set(),
        disabledKeys: new Map(),
        disabledModels: new Map(),
        stopMessageText: '继续推进任务',
        stopMessageMaxRepeats: 2,
        stopMessageUsed: 0,
        stopMessageAiMode: 'on'
      });

      const chatResponse: JsonObject = {
        id: 'chatcmpl-stop-codex-cwd',
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

      const adapterContext: AdapterContext = {
        requestId: 'req-stopmessage-codex-cwd',
        entryEndpoint: '/v1/chat/completions',
        providerProtocol: 'openai-chat',
        sessionId,
        workdir,
        capturedChatRequest: {
          model: 'gpt-test',
          messages: [{ role: 'user', content: 'hi' }]
        }
      } as any;

      const result = await runServerSideToolEngine({
        chatResponse,
        adapterContext,
        entryEndpoint: '/v1/chat/completions',
        requestId: 'req-stopmessage-codex-cwd',
        providerProtocol: 'openai-chat'
      });

      expect(result.mode).toBe('tool_flow');
      expect(result.execution?.flowId).toBe('stop_message_flow');
      const followup = result.execution?.followup as any;
      const ops = Array.isArray(followup?.injection?.ops) ? (followup.injection.ops as any[]) : [];
      const appendUserOp = ops.find((op) => op?.op === 'append_user_text');
      expect(appendUserOp?.text).toContain(workdir);
      expect(appendUserOp?.text).toContain(EXECUTION_APPEND_TEXT);
      const capturedPrompt = fs.readFileSync(promptCapturePath, 'utf8');
      expect(capturedPrompt).toContain('先做代码 review（最多一句），再给指令：必须结合 workingDirectory 下当前实现/测试/构建状态给出建议；不能只做抽象建议。');
      expect(capturedPrompt).toContain('只有在消息内容或历史记录里存在明确证据时，才允许判断“偏离目标”；否则按同轨推进，不要泛化指责偏离。');
      expect(capturedPrompt).toContain('禁止连续安排纯只读/纯汇报命令（如 cargo llvm-cov report、cat/head/tail/rg/git status）');
      expect(capturedPrompt).toContain('禁止把 review 责任交回主模型');
    } finally {
      if (previousAiBackend === undefined) {
        delete process.env.ROUTECODEX_STOPMESSAGE_AI_FOLLOWUP_BACKEND;
      } else {
        process.env.ROUTECODEX_STOPMESSAGE_AI_FOLLOWUP_BACKEND = previousAiBackend;
      }
      if (previousAiCodexBin === undefined) {
        delete process.env.ROUTECODEX_STOPMESSAGE_AI_FOLLOWUP_CODEX_BIN;
      } else {
        process.env.ROUTECODEX_STOPMESSAGE_AI_FOLLOWUP_CODEX_BIN = previousAiCodexBin;
      }
      if (previousBackend === undefined) {
        delete process.env.ROUTECODEX_STOPMESSAGE_AUTOMESSAGE_BACKEND;
      } else {
        process.env.ROUTECODEX_STOPMESSAGE_AUTOMESSAGE_BACKEND = previousBackend;
      }
      if (previousCodexBin === undefined) {
        delete process.env.ROUTECODEX_STOPMESSAGE_AUTOMESSAGE_CODEX_BIN;
      } else {
        process.env.ROUTECODEX_STOPMESSAGE_AUTOMESSAGE_CODEX_BIN = previousCodexBin;
      }
      if (fs.existsSync(promptCapturePath)) {
        fs.unlinkSync(promptCapturePath);
      }
      if (fs.existsSync(mockCodexBinPath)) {
        fs.unlinkSync(mockCodexBinPath);
      }
    }
  });

  test('default backend falls back codex->iflow when codex is unavailable', async () => {
    const sessionId = 'stopmessage-spec-session-ai-followup-fallback';
    writeRoutingStateForSession(sessionId, {
      forcedTarget: undefined,
      stickyTarget: undefined,
      allowedProviders: new Set(),
      disabledProviders: new Set(),
      disabledKeys: new Map(),
      disabledModels: new Map(),
      stopMessageText: '继续推进并执行下一步',
      stopMessageMaxRepeats: 2,
      stopMessageUsed: 0,
      stopMessageAiMode: 'on'
    });

    const previousAiBackend = process.env.ROUTECODEX_STOPMESSAGE_AI_FOLLOWUP_BACKEND;
    const previousAiCodexBin = process.env.ROUTECODEX_STOPMESSAGE_AI_FOLLOWUP_CODEX_BIN;
    const previousAiIflowBin = process.env.ROUTECODEX_STOPMESSAGE_AI_FOLLOWUP_IFLOW_BIN;
    const previousBackend = process.env.ROUTECODEX_STOPMESSAGE_AUTOMESSAGE_BACKEND;
    const previousCodexBin = process.env.ROUTECODEX_STOPMESSAGE_AUTOMESSAGE_CODEX_BIN;
    const previousIflowBin = process.env.ROUTECODEX_STOPMESSAGE_AUTOMESSAGE_IFLOW_BIN;
    const mockIflowBinPath = path.join(USER_DIR, 'mock-iflow-fallback-after-codex.sh');

    try {
      delete process.env.ROUTECODEX_STOPMESSAGE_AI_FOLLOWUP_BACKEND;
      delete process.env.ROUTECODEX_STOPMESSAGE_AUTOMESSAGE_BACKEND;
      process.env.ROUTECODEX_STOPMESSAGE_AI_FOLLOWUP_CODEX_BIN = path.join(USER_DIR, 'missing-codex-bin');
      process.env.ROUTECODEX_STOPMESSAGE_AUTOMESSAGE_CODEX_BIN = path.join(USER_DIR, 'missing-codex-bin');
      process.env.ROUTECODEX_STOPMESSAGE_AI_FOLLOWUP_IFLOW_BIN = mockIflowBinPath;
      process.env.ROUTECODEX_STOPMESSAGE_AUTOMESSAGE_IFLOW_BIN = mockIflowBinPath;
      fs.writeFileSync(
        mockIflowBinPath,
        [
          '#!/usr/bin/env bash',
          "if [ \"$1\" = \"-p\" ]; then",
          "  echo 'fallback-from-iflow'",
          '  exit 0',
          'fi',
          'exit 2'
        ].join('\n'),
        { encoding: 'utf8' }
      );
      fs.chmodSync(mockIflowBinPath, 0o755);

      const result = await runServerSideToolEngine({
        chatResponse: {
          id: 'chatcmpl-stop-ai-fallback',
          object: 'chat.completion',
          model: 'gpt-test',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'ok' },
              finish_reason: 'stop'
            }
          ]
        } as JsonObject,
        adapterContext: {
          requestId: 'req-stopmessage-ai-fallback',
          entryEndpoint: '/v1/chat/completions',
          providerProtocol: 'openai-chat',
          sessionId,
          capturedChatRequest: {
            model: 'gpt-test',
            messages: [{ role: 'user', content: '继续处理当前任务' }]
          }
        } as any,
        entryEndpoint: '/v1/chat/completions',
        requestId: 'req-stopmessage-ai-fallback',
        providerProtocol: 'openai-chat'
      });

      expect(result.mode).toBe('tool_flow');
      const followup = result.execution?.followup as any;
      expect(Array.isArray(followup?.injection?.ops)).toBe(true);
      const appendOp = (followup.injection.ops as any[]).find((op) => op?.op === 'append_user_text');
      expect(appendOp?.text).toContain('fallback-from-iflow');
      expect(appendOp?.text).toContain(EXECUTION_APPEND_TEXT);
    } finally {
      if (previousAiBackend === undefined) delete process.env.ROUTECODEX_STOPMESSAGE_AI_FOLLOWUP_BACKEND;
      else process.env.ROUTECODEX_STOPMESSAGE_AI_FOLLOWUP_BACKEND = previousAiBackend;
      if (previousAiCodexBin === undefined) delete process.env.ROUTECODEX_STOPMESSAGE_AI_FOLLOWUP_CODEX_BIN;
      else process.env.ROUTECODEX_STOPMESSAGE_AI_FOLLOWUP_CODEX_BIN = previousAiCodexBin;
      if (previousAiIflowBin === undefined) delete process.env.ROUTECODEX_STOPMESSAGE_AI_FOLLOWUP_IFLOW_BIN;
      else process.env.ROUTECODEX_STOPMESSAGE_AI_FOLLOWUP_IFLOW_BIN = previousAiIflowBin;
      if (previousBackend === undefined) delete process.env.ROUTECODEX_STOPMESSAGE_AUTOMESSAGE_BACKEND;
      else process.env.ROUTECODEX_STOPMESSAGE_AUTOMESSAGE_BACKEND = previousBackend;
      if (previousCodexBin === undefined) delete process.env.ROUTECODEX_STOPMESSAGE_AUTOMESSAGE_CODEX_BIN;
      else process.env.ROUTECODEX_STOPMESSAGE_AUTOMESSAGE_CODEX_BIN = previousCodexBin;
      if (previousIflowBin === undefined) delete process.env.ROUTECODEX_STOPMESSAGE_AUTOMESSAGE_IFLOW_BIN;
      else process.env.ROUTECODEX_STOPMESSAGE_AUTOMESSAGE_IFLOW_BIN = previousIflowBin;
      if (fs.existsSync(mockIflowBinPath)) {
        fs.unlinkSync(mockIflowBinPath);
      }
    }
  });

  test('auto mode uses iflow -p output as followup text', async () => {
    const sessionId = 'stopmessage-spec-session-iflow-followup';
    const state: RoutingInstructionState = {
      forcedTarget: undefined,
      stickyTarget: undefined,
      allowedProviders: new Set(),
      disabledProviders: new Set(),
      disabledKeys: new Map(),
      disabledModels: new Map(),
      stopMessageText: '继续推进并执行下一步',
      stopMessageMaxRepeats: 2,
      stopMessageUsed: 0,
      stopMessageStageMode: 'auto',
      stopMessageAiMode: 'on'
    };
    writeRoutingStateForSession(sessionId, state);

    const prevBdMode = process.env.ROUTECODEX_STOPMESSAGE_BD_MODE;
    const prevAiIflowBin = process.env.ROUTECODEX_STOPMESSAGE_AI_FOLLOWUP_IFLOW_BIN;
    const prevIflowEnabled = process.env.ROUTECODEX_STOPMESSAGE_AUTOMESSAGE_IFLOW;
    const prevIflowBin = process.env.ROUTECODEX_STOPMESSAGE_AUTOMESSAGE_IFLOW_BIN;
    const promptCapturePath = path.join(USER_DIR, 'mock-iflow-prompt.txt');
    const mockIflowBinPath = path.join(USER_DIR, 'mock-iflow-success.sh');

    try {
      process.env.ROUTECODEX_STOPMESSAGE_BD_MODE = 'heuristic';
      process.env.ROUTECODEX_STOPMESSAGE_AUTOMESSAGE_IFLOW = '1';
      process.env.ROUTECODEX_STOPMESSAGE_AI_FOLLOWUP_IFLOW_BIN = mockIflowBinPath;
      process.env.ROUTECODEX_STOPMESSAGE_AUTOMESSAGE_IFLOW_BIN = mockIflowBinPath;
      fs.writeFileSync(
        mockIflowBinPath,
        [
          '#!/usr/bin/env bash',
          `printf '%s' "$2" > ${JSON.stringify(promptCapturePath)}`,
          "if [ \"$1\" = \"-p\" ]; then",
          "  echo '请继续完成当前拆分，并先运行构建验证。'",
          '  exit 0',
          'fi',
          'exit 2'
        ].join('\n'),
        { encoding: 'utf8' }
      );
      fs.chmodSync(mockIflowBinPath, 0o755);

      const result = await runServerSideToolEngine({
        chatResponse: {
          id: 'chatcmpl-stop-iflow-followup',
          object: 'chat.completion',
          model: 'gpt-test',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: '这里是正文输出',
                reasoning_content: '这里是推理输出'
              },
              finish_reason: 'stop'
            }
          ]
        } as JsonObject,
        adapterContext: {
          requestId: 'req-stopmessage-iflow-followup',
          entryEndpoint: '/v1/chat/completions',
          providerProtocol: 'openai-chat',
          sessionId,
          capturedChatRequest: {
            model: 'gpt-test',
            messages: [{ role: 'user', content: '继续处理当前任务' }]
          }
        } as any,
        entryEndpoint: '/v1/chat/completions',
        requestId: 'req-stopmessage-iflow-followup',
        providerProtocol: 'openai-chat'
      });

      expect(result.mode).toBe('tool_flow');
      const followup = result.execution?.followup as any;
      expect(Array.isArray(followup?.injection?.ops)).toBe(true);
      const appendOp = (followup.injection.ops as any[]).find((op) => op?.op === 'append_user_text');
      expect(appendOp?.text).toContain('请继续完成当前拆分，并先运行构建验证。');
      expect(appendOp?.text).toContain(EXECUTION_APPEND_TEXT);

      const capturedPrompt = fs.readFileSync(promptCapturePath, 'utf8');
      expect(capturedPrompt).toContain('baseStopMessage: 继续推进并执行下一步');
      expect(capturedPrompt).toContain('assistantText:');
      expect(capturedPrompt).toContain('这里是正文输出');
      expect(capturedPrompt).toContain('reasoningText:');
      expect(capturedPrompt).toContain('这里是推理输出');
      expect(capturedPrompt).toContain('先做代码 review（最多一句），再给指令：必须结合 workingDirectory 下当前实现/测试/构建状态给出建议；不能只做抽象建议。');
      expect(capturedPrompt).toContain('只有在消息内容或历史记录里存在明确证据时，才允许判断“偏离目标”；否则按同轨推进，不要泛化指责偏离。');
      expect(capturedPrompt).toContain('覆盖率类命令只能作为写动作后的验证步骤，不能作为本轮唯一或首要动作。');
      expect(capturedPrompt).toContain('禁止把 review 责任交回主模型');
    } finally {
      if (prevBdMode === undefined) {
        delete process.env.ROUTECODEX_STOPMESSAGE_BD_MODE;
      } else {
        process.env.ROUTECODEX_STOPMESSAGE_BD_MODE = prevBdMode;
      }
      if (prevIflowEnabled === undefined) {
        delete process.env.ROUTECODEX_STOPMESSAGE_AUTOMESSAGE_IFLOW;
      } else {
        process.env.ROUTECODEX_STOPMESSAGE_AUTOMESSAGE_IFLOW = prevIflowEnabled;
      }
      if (prevAiIflowBin === undefined) {
        delete process.env.ROUTECODEX_STOPMESSAGE_AI_FOLLOWUP_IFLOW_BIN;
      } else {
        process.env.ROUTECODEX_STOPMESSAGE_AI_FOLLOWUP_IFLOW_BIN = prevAiIflowBin;
      }
      if (prevIflowBin === undefined) {
        delete process.env.ROUTECODEX_STOPMESSAGE_AUTOMESSAGE_IFLOW_BIN;
      } else {
        process.env.ROUTECODEX_STOPMESSAGE_AUTOMESSAGE_IFLOW_BIN = prevIflowBin;
      }
      if (fs.existsSync(promptCapturePath)) {
        fs.unlinkSync(promptCapturePath);
      }
      if (fs.existsSync(mockIflowBinPath)) {
        fs.unlinkSync(mockIflowBinPath);
      }
    }
  });

  test('auto mode falls back to fixed "继续执行" when ai-followup backends fail', async () => {
    const sessionId = 'stopmessage-spec-session-iflow-followup-fallback';
    const state: RoutingInstructionState = {
      forcedTarget: undefined,
      stickyTarget: undefined,
      allowedProviders: new Set(),
      disabledProviders: new Set(),
      disabledKeys: new Map(),
      disabledModels: new Map(),
      stopMessageText: '请继续执行当前任务',
      stopMessageMaxRepeats: 2,
      stopMessageUsed: 0,
      stopMessageStageMode: 'auto',
      stopMessageAiMode: 'on'
    };
    writeRoutingStateForSession(sessionId, state);

    const prevBdMode = process.env.ROUTECODEX_STOPMESSAGE_BD_MODE;
    const prevAiIflowBin = process.env.ROUTECODEX_STOPMESSAGE_AI_FOLLOWUP_IFLOW_BIN;
    const prevAiCodexBin = process.env.ROUTECODEX_STOPMESSAGE_AI_FOLLOWUP_CODEX_BIN;
    const prevIflowEnabled = process.env.ROUTECODEX_STOPMESSAGE_AUTOMESSAGE_IFLOW;
    const prevIflowBin = process.env.ROUTECODEX_STOPMESSAGE_AUTOMESSAGE_IFLOW_BIN;
    const prevCodexBin = process.env.ROUTECODEX_STOPMESSAGE_AUTOMESSAGE_CODEX_BIN;
    const mockIflowBinPath = path.join(USER_DIR, 'mock-iflow-fail.sh');

    try {
      process.env.ROUTECODEX_STOPMESSAGE_BD_MODE = 'heuristic';
      process.env.ROUTECODEX_STOPMESSAGE_AUTOMESSAGE_IFLOW = '1';
      process.env.ROUTECODEX_STOPMESSAGE_AI_FOLLOWUP_IFLOW_BIN = mockIflowBinPath;
      process.env.ROUTECODEX_STOPMESSAGE_AUTOMESSAGE_IFLOW_BIN = mockIflowBinPath;
      process.env.ROUTECODEX_STOPMESSAGE_AI_FOLLOWUP_CODEX_BIN = path.join(USER_DIR, 'missing-codex-bin');
      process.env.ROUTECODEX_STOPMESSAGE_AUTOMESSAGE_CODEX_BIN = path.join(USER_DIR, 'missing-codex-bin');
      fs.writeFileSync(
        mockIflowBinPath,
        ['#!/usr/bin/env bash', "echo 'auth required' 1>&2", 'exit 1'].join('\n'),
        { encoding: 'utf8' }
      );
      fs.chmodSync(mockIflowBinPath, 0o755);

      const result = await runServerSideToolEngine({
        chatResponse: {
          id: 'chatcmpl-stop-iflow-followup-fallback',
          object: 'chat.completion',
          model: 'gpt-test',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'ok' },
              finish_reason: 'stop'
            }
          ]
        } as JsonObject,
        adapterContext: {
          requestId: 'req-stopmessage-iflow-followup-fallback',
          entryEndpoint: '/v1/chat/completions',
          providerProtocol: 'openai-chat',
          sessionId,
          capturedChatRequest: {
            model: 'gpt-test',
            messages: [{ role: 'user', content: '继续处理当前任务' }]
          }
        } as any,
        entryEndpoint: '/v1/chat/completions',
        requestId: 'req-stopmessage-iflow-followup-fallback',
        providerProtocol: 'openai-chat'
      });

      expect(result.mode).toBe('tool_flow');
      const followup = result.execution?.followup as any;
      expect(Array.isArray(followup?.injection?.ops)).toBe(true);
      const appendOp = (followup.injection.ops as any[]).find((op) => op?.op === 'append_user_text');
      expect(appendOp?.text).toContain('继续执行');
      expect(appendOp?.text).toContain(EXECUTION_APPEND_TEXT);
    } finally {
      if (prevBdMode === undefined) {
        delete process.env.ROUTECODEX_STOPMESSAGE_BD_MODE;
      } else {
        process.env.ROUTECODEX_STOPMESSAGE_BD_MODE = prevBdMode;
      }
      if (prevIflowEnabled === undefined) {
        delete process.env.ROUTECODEX_STOPMESSAGE_AUTOMESSAGE_IFLOW;
      } else {
        process.env.ROUTECODEX_STOPMESSAGE_AUTOMESSAGE_IFLOW = prevIflowEnabled;
      }
      if (prevAiIflowBin === undefined) {
        delete process.env.ROUTECODEX_STOPMESSAGE_AI_FOLLOWUP_IFLOW_BIN;
      } else {
        process.env.ROUTECODEX_STOPMESSAGE_AI_FOLLOWUP_IFLOW_BIN = prevAiIflowBin;
      }
      if (prevIflowBin === undefined) {
        delete process.env.ROUTECODEX_STOPMESSAGE_AUTOMESSAGE_IFLOW_BIN;
      } else {
        process.env.ROUTECODEX_STOPMESSAGE_AUTOMESSAGE_IFLOW_BIN = prevIflowBin;
      }
      if (prevAiCodexBin === undefined) {
        delete process.env.ROUTECODEX_STOPMESSAGE_AI_FOLLOWUP_CODEX_BIN;
      } else {
        process.env.ROUTECODEX_STOPMESSAGE_AI_FOLLOWUP_CODEX_BIN = prevAiCodexBin;
      }
      if (prevCodexBin === undefined) {
        delete process.env.ROUTECODEX_STOPMESSAGE_AUTOMESSAGE_CODEX_BIN;
      } else {
        process.env.ROUTECODEX_STOPMESSAGE_AUTOMESSAGE_CODEX_BIN = prevCodexBin;
      }
      if (fs.existsSync(mockIflowBinPath)) {
        fs.unlinkSync(mockIflowBinPath);
      }
    }
  });

  test('auto mode ignores fixed file text and falls back to "继续执行" when ai-followup backends fail', async () => {
    const sessionId = 'stopmessage-spec-session-iflow-followup-fallback-file';
    const state: RoutingInstructionState = {
      forcedTarget: undefined,
      stickyTarget: undefined,
      allowedProviders: new Set(),
      disabledProviders: new Set(),
      disabledKeys: new Map(),
      disabledModels: new Map(),
      stopMessageText: '文件策略：先运行验证，再汇报结果',
      stopMessageSource: 'explicit_file',
      stopMessageMaxRepeats: 2,
      stopMessageUsed: 0,
      stopMessageStageMode: 'auto',
      stopMessageAiMode: 'on'
    };
    writeRoutingStateForSession(sessionId, state);

    const prevBdMode = process.env.ROUTECODEX_STOPMESSAGE_BD_MODE;
    const prevAiIflowBin = process.env.ROUTECODEX_STOPMESSAGE_AI_FOLLOWUP_IFLOW_BIN;
    const prevAiCodexBin = process.env.ROUTECODEX_STOPMESSAGE_AI_FOLLOWUP_CODEX_BIN;
    const prevIflowEnabled = process.env.ROUTECODEX_STOPMESSAGE_AUTOMESSAGE_IFLOW;
    const prevIflowBin = process.env.ROUTECODEX_STOPMESSAGE_AUTOMESSAGE_IFLOW_BIN;
    const prevCodexBin = process.env.ROUTECODEX_STOPMESSAGE_AUTOMESSAGE_CODEX_BIN;
    const mockIflowBinPath = path.join(USER_DIR, 'mock-iflow-fail-file.sh');

    try {
      process.env.ROUTECODEX_STOPMESSAGE_BD_MODE = 'heuristic';
      process.env.ROUTECODEX_STOPMESSAGE_AUTOMESSAGE_IFLOW = '1';
      process.env.ROUTECODEX_STOPMESSAGE_AI_FOLLOWUP_IFLOW_BIN = mockIflowBinPath;
      process.env.ROUTECODEX_STOPMESSAGE_AUTOMESSAGE_IFLOW_BIN = mockIflowBinPath;
      process.env.ROUTECODEX_STOPMESSAGE_AI_FOLLOWUP_CODEX_BIN = path.join(USER_DIR, 'missing-codex-bin');
      process.env.ROUTECODEX_STOPMESSAGE_AUTOMESSAGE_CODEX_BIN = path.join(USER_DIR, 'missing-codex-bin');
      fs.writeFileSync(
        mockIflowBinPath,
        ['#!/usr/bin/env bash', "echo 'auth required' 1>&2", 'exit 1'].join('\n'),
        { encoding: 'utf8' }
      );
      fs.chmodSync(mockIflowBinPath, 0o755);

      const result = await runServerSideToolEngine({
        chatResponse: {
          id: 'chatcmpl-stop-iflow-followup-fallback-file',
          object: 'chat.completion',
          model: 'gpt-test',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'ok' },
              finish_reason: 'stop'
            }
          ]
        } as JsonObject,
        adapterContext: {
          requestId: 'req-stopmessage-iflow-followup-fallback-file',
          entryEndpoint: '/v1/chat/completions',
          providerProtocol: 'openai-chat',
          sessionId,
          capturedChatRequest: {
            model: 'gpt-test',
            messages: [{ role: 'user', content: '继续处理当前任务' }]
          }
        } as any,
        entryEndpoint: '/v1/chat/completions',
        requestId: 'req-stopmessage-iflow-followup-fallback-file',
        providerProtocol: 'openai-chat'
      });

      expect(result.mode).toBe('tool_flow');
      const followup = result.execution?.followup as any;
      expect(Array.isArray(followup?.injection?.ops)).toBe(true);
      const appendOp = (followup.injection.ops as any[]).find((op) => op?.op === 'append_user_text');
      expect(appendOp?.text).toContain('继续执行');
      expect(appendOp?.text).toContain(EXECUTION_APPEND_TEXT);
    } finally {
      if (prevBdMode === undefined) {
        delete process.env.ROUTECODEX_STOPMESSAGE_BD_MODE;
      } else {
        process.env.ROUTECODEX_STOPMESSAGE_BD_MODE = prevBdMode;
      }
      if (prevIflowEnabled === undefined) {
        delete process.env.ROUTECODEX_STOPMESSAGE_AUTOMESSAGE_IFLOW;
      } else {
        process.env.ROUTECODEX_STOPMESSAGE_AUTOMESSAGE_IFLOW = prevIflowEnabled;
      }
      if (prevAiIflowBin === undefined) {
        delete process.env.ROUTECODEX_STOPMESSAGE_AI_FOLLOWUP_IFLOW_BIN;
      } else {
        process.env.ROUTECODEX_STOPMESSAGE_AI_FOLLOWUP_IFLOW_BIN = prevAiIflowBin;
      }
      if (prevIflowBin === undefined) {
        delete process.env.ROUTECODEX_STOPMESSAGE_AUTOMESSAGE_IFLOW_BIN;
      } else {
        process.env.ROUTECODEX_STOPMESSAGE_AUTOMESSAGE_IFLOW_BIN = prevIflowBin;
      }
      if (prevAiCodexBin === undefined) {
        delete process.env.ROUTECODEX_STOPMESSAGE_AI_FOLLOWUP_CODEX_BIN;
      } else {
        process.env.ROUTECODEX_STOPMESSAGE_AI_FOLLOWUP_CODEX_BIN = prevAiCodexBin;
      }
      if (prevCodexBin === undefined) {
        delete process.env.ROUTECODEX_STOPMESSAGE_AUTOMESSAGE_CODEX_BIN;
      } else {
        process.env.ROUTECODEX_STOPMESSAGE_AUTOMESSAGE_CODEX_BIN = prevCodexBin;
      }
      if (fs.existsSync(mockIflowBinPath)) {
        fs.unlinkSync(mockIflowBinPath);
      }
    }
  });


  test('triggers stopMessage when a later choice has finish_reason=stop', async () => {
    const sessionId = 'stopmessage-spec-session-multi-choice-stop';
    const state: RoutingInstructionState = {
      forcedTarget: undefined,
      stickyTarget: undefined,
      allowedProviders: new Set(),
      disabledProviders: new Set(),
      disabledKeys: new Map(),
      disabledModels: new Map(),
      stopMessageText: '立即执行待处理任务',
      stopMessageMaxRepeats: 2,
      stopMessageUsed: 0
    };
    writeRoutingStateForSession(sessionId, state);

    const chatResponse: JsonObject = {
      id: 'chatcmpl-stop-multi-choice',
      object: 'chat.completion',
      model: 'gpt-test',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: 'ignored'
          },
          finish_reason: 'content_filter'
        },
        {
          index: 1,
          message: {
            role: 'assistant',
            content: 'ok'
          },
          finish_reason: 'stop'
        }
      ]
    };

    const adapterContext: AdapterContext = {
      requestId: 'req-stopmessage-multi-choice',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-chat',
      sessionId,
      capturedChatRequest: {
        model: 'gpt-test',
        messages: [{ role: 'user', content: '继续处理' }]
      }
    } as any;

    const result = await runServerSideToolEngine({
      chatResponse,
      adapterContext,
      entryEndpoint: '/v1/responses',
      requestId: 'req-stopmessage-multi-choice',
      providerProtocol: 'openai-chat'
    });

    expect(result.mode).toBe('tool_flow');
    expect(result.execution?.flowId).toBe('stop_message_flow');
  });


  test('resolves stopMessage session scope from adapterContext.metadata.sessionId (openai-chat)', async () => {
    const sessionId = 'stopmessage-spec-session-metadata-scope';
    const state: RoutingInstructionState = {
      forcedTarget: undefined,
      stickyTarget: undefined,
      allowedProviders: new Set(),
      disabledProviders: new Set(),
      disabledKeys: new Map(),
      disabledModels: new Map(),
      stopMessageText: '立即执行待处理任务',
      stopMessageMaxRepeats: 2,
      stopMessageUsed: 0
    };
    writeRoutingStateForSession(sessionId, state);

    const chatResponse: JsonObject = {
      id: 'chatcmpl-stop-metadata-scope',
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

    const adapterContext: AdapterContext = {
      requestId: 'req-stopmessage-metadata-scope',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      metadata: {
        sessionId
      },
      capturedChatRequest: {
        model: 'gpt-test',
        messages: [
          {
            role: 'user',
            content: '继续处理'
          }
        ]
      }
    } as any;

    const result = await runServerSideToolEngine({
      chatResponse,
      adapterContext,
      entryEndpoint: '/v1/chat/completions',
      requestId: 'req-stopmessage-metadata-scope',
      providerProtocol: 'openai-chat'
    });

    expect(result.mode).toBe('tool_flow');
    expect(result.execution?.flowId).toBe('stop_message_flow');

    const persisted = await readJsonFileUntil<{ state?: { stopMessageUsed?: number; stopMessageLastUsedAt?: number } }>(
      path.join(SESSION_DIR, `session-${sessionId}.json`),
      (data) => data?.state?.stopMessageUsed === 1 && typeof data?.state?.stopMessageLastUsedAt === 'number'
    );
    expect(persisted?.state?.stopMessageUsed).toBe(1);
  });


  test('uses adapterContext.originalRequest as captured seed fallback (openai-chat)', async () => {
    const sessionId = 'stopmessage-spec-session-original-request-fallback';
    const state: RoutingInstructionState = {
      forcedTarget: undefined,
      stickyTarget: undefined,
      allowedProviders: new Set(),
      disabledProviders: new Set(),
      disabledKeys: new Map(),
      disabledModels: new Map(),
      stopMessageText: '立即执行待处理任务',
      stopMessageMaxRepeats: 2,
      stopMessageUsed: 0
    };
    writeRoutingStateForSession(sessionId, state);

    const chatResponse: JsonObject = {
      id: 'chatcmpl-stop-original-fallback',
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

    const adapterContext: AdapterContext = {
      requestId: 'req-stopmessage-original-fallback',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      sessionId,
      originalRequest: {
        model: 'gpt-test',
        messages: [
          {
            role: 'user',
            content: '继续处理'
          }
        ],
        tools: [
          {
            type: 'function',
            function: {
              name: 'exec_command',
              parameters: {
                type: 'object',
                properties: {
                  cmd: { type: 'string' }
                },
                required: ['cmd']
              }
            }
          }
        ]
      }
    } as any;

    const result = await runServerSideToolEngine({
      chatResponse,
      adapterContext,
      entryEndpoint: '/v1/chat/completions',
      requestId: 'req-stopmessage-original-fallback',
      providerProtocol: 'openai-chat'
    });

    expect(result.mode).toBe('tool_flow');
    expect(result.execution?.flowId).toBe('stop_message_flow');
    const followup = result.execution?.followup as any;
    expect(followup).toBeDefined();
    const ops = followup.injection.ops as any[];
    expect(ops.some((op) => op?.op === 'append_user_text' && typeof op?.text === 'string')).toBe(true);
  });

  test('does not resolve stopMessage session scope from capturedContext fallback (prevents cross-session leakage)', async () => {
    const sessionId = 'stopmessage-spec-session-captured-context-only';
    const state: RoutingInstructionState = {
      forcedTarget: undefined,
      stickyTarget: undefined,
      allowedProviders: new Set(),
      disabledProviders: new Set(),
      disabledKeys: new Map(),
      disabledModels: new Map(),
      stopMessageText: '立即执行待处理任务',
      stopMessageMaxRepeats: 2,
      stopMessageUsed: 0
    };
    writeRoutingStateForSession(sessionId, state);

    const chatResponse: JsonObject = {
      id: 'chatcmpl-stop-captured-context-only',
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

    const adapterContext: AdapterContext = {
      requestId: 'req-stopmessage-captured-context-only',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      metadata: {
        capturedContext: {
          __hub_capture: {
            context: {
              sessionId
            }
          }
        }
      },
      capturedChatRequest: {
        model: 'gpt-test',
        messages: [
          {
            role: 'user',
            content: '继续处理'
          }
        ]
      }
    } as any;

    const result = await runServerSideToolEngine({
      chatResponse,
      adapterContext,
      entryEndpoint: '/v1/chat/completions',
      requestId: 'req-stopmessage-captured-context-only',
      providerProtocol: 'openai-chat'
    });

    expect(result.mode).toBe('passthrough');
    expect(result.execution).toBeUndefined();
  });

  test('openai-responses sticky key prefers request chain over session scope', () => {
    const key = resolveStickyKey({
      providerProtocol: 'openai-responses',
      requestId: 'req-responses-stopmessage',
      sessionId: 'session-should-win',
      responsesResume: { previousRequestId: 'req-responses-root' }
    });

    expect(key).toBe('req-responses-root');
  });

  test('openai-responses sticky key falls back to session scope when previousRequestId is missing', () => {
    const key = resolveStickyKey({
      providerProtocol: 'openai-responses',
      requestId: 'req-responses-stopmessage',
      sessionId: 'session-should-win'
    });

    expect(key).toBe('session:session-should-win');
  });

  test('openai-responses does not trigger stop_message when session stage mode is off', async () => {
    const sessionId = 'stopmessage-spec-session-responses-mode-off';
    const state: RoutingInstructionState = {
      forcedTarget: undefined,
      stickyTarget: undefined,
      allowedProviders: new Set(),
      disabledProviders: new Set(),
      disabledKeys: new Map(),
      disabledModels: new Map(),
      stopMessageStageMode: 'off'
    };
    writeRoutingStateForSession(sessionId, state);

    const chatResponse: JsonObject = {
      id: 'resp-stop-mode-off',
      object: 'response',
      status: 'completed',
      model: 'gpt-test',
      output: [
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'ok' }]
        }
      ]
    };

    const adapterContext: AdapterContext = {
      requestId: 'req-stopmessage-responses-mode-off',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses',
      sessionId,
      capturedChatRequest: {
        model: 'gpt-test',
        input: [{ role: 'user', content: [{ type: 'input_text', text: '继续处理' }] }]
      }
    } as any;

    const result = await runServerSideToolEngine({
      chatResponse,
      adapterContext,
      entryEndpoint: '/v1/responses',
      requestId: 'req-stopmessage-responses-mode-off',
      providerProtocol: 'openai-responses'
    });

    expect(result.mode).toBe('passthrough');
    expect(result.execution?.flowId).toBeUndefined();
  });

  test('skips stop_message retrigger on stop_message_flow followup hops', async () => {
    const sessionId = 'stopmessage-spec-session-followup-allow';
    const state: RoutingInstructionState = {
      forcedTarget: undefined,
      stickyTarget: undefined,
      allowedProviders: new Set(),
      disabledProviders: new Set(),
      disabledKeys: new Map(),
      disabledModels: new Map(),
      stopMessageText: '立即执行待处理任务',
      stopMessageMaxRepeats: 30,
      stopMessageUsed: 0
    };
    writeRoutingStateForSession(sessionId, state);

    const chatResponse: JsonObject = {
      id: 'chatcmpl-stop-followup-allow',
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

    const adapterContext: AdapterContext = {
      requestId: 'req-stopmessage-followup-allow',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      sessionId,
      capturedChatRequest: {
        model: 'gpt-test',
        messages: [{ role: 'user', content: 'hi' }]
      },
      __rt: {
        serverToolFollowup: true,
        serverToolLoopState: {
          flowId: 'stop_message_flow',
          repeatCount: 1,
          payloadHash: 'seed'
        }
      }
    } as any;

    const result = await runServerSideToolEngine({
      chatResponse,
      adapterContext,
      entryEndpoint: '/v1/chat/completions',
      requestId: 'req-stopmessage-followup-allow',
      providerProtocol: 'openai-chat'
    });

    expect(result.mode).toBe('passthrough');
    expect(result.execution).toBeUndefined();

    const persisted = await readJsonFileWithRetry<{ state?: { stopMessageUsed?: number } }>(
      path.join(SESSION_DIR, `session-${sessionId}.json`),
    );
    expect(persisted?.state?.stopMessageUsed).toBe(0);
  });

  test('skips stop_message retrigger for non-stop followup flows', async () => {
    const sessionId = 'stopmessage-spec-session-followup-cross-flow';
    const state: RoutingInstructionState = {
      forcedTarget: undefined,
      stickyTarget: undefined,
      allowedProviders: new Set(),
      disabledProviders: new Set(),
      disabledKeys: new Map(),
      disabledModels: new Map(),
      stopMessageText: '立即执行待处理任务',
      stopMessageMaxRepeats: 30,
      stopMessageUsed: 0
    };
    writeRoutingStateForSession(sessionId, state);

    const chatResponse: JsonObject = {
      id: 'chatcmpl-stop-followup-cross-flow',
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

    const adapterContext: AdapterContext = {
      requestId: 'req-stopmessage-followup-cross-flow',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      sessionId,
      capturedChatRequest: {
        model: 'gpt-test',
        messages: [{ role: 'user', content: 'hi' }]
      },
      __rt: {
        serverToolFollowup: true,
        serverToolLoopState: {
          flowId: 'web_search_flow',
          repeatCount: 1,
          payloadHash: 'seed'
        }
      }
    } as any;

    const result = await runServerSideToolEngine({
      chatResponse,
      adapterContext,
      entryEndpoint: '/v1/chat/completions',
      requestId: 'req-stopmessage-followup-cross-flow',
      providerProtocol: 'openai-chat'
    });

    expect(result.mode).toBe('passthrough');

    const persisted = await readJsonFileWithRetry<{ state?: { stopMessageUsed?: number } }>(
      path.join(SESSION_DIR, `session-${sessionId}.json`)
    );
    expect(persisted?.state?.stopMessageUsed).toBe(0);
  });
  test('builds /v1/responses followup and preserves parameters (non-streaming)', async () => {
    const sessionId = 'stopmessage-spec-session-responses';
    const state: RoutingInstructionState = {
      forcedTarget: undefined,
      stickyTarget: undefined,
      allowedProviders: new Set(),
      disabledProviders: new Set(),
      disabledKeys: new Map(),
      disabledModels: new Map(),
      stopMessageText: '继续执行',
      stopMessageMaxRepeats: 1,
      stopMessageUsed: 0
    };
    writeRoutingStateForSession(sessionId, state);

    const capturedChatRequest: JsonObject = {
      model: 'gemini-test',
      messages: [{ role: 'user', content: 'hi' }],
      parameters: {
        max_output_tokens: 99,
        temperature: 0.1,
        stream: true
      }
    };

    const responsesPayload: JsonObject = {
      id: 'resp-stopmessage-1',
      object: 'response',
      model: 'gemini-test',
      status: 'completed',
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }]
    };

    const adapterContext: AdapterContext = {
      requestId: 'req-stopmessage-resp-1',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'gemini-chat',
      sessionId,
      capturedChatRequest
    } as any;

    let capturedFollowup: { entryEndpoint?: string; body?: any; metadata?: any } | null = null;
    const orchestration = await runServerToolOrchestration({
      chat: responsesPayload,
      adapterContext,
      requestId: 'req-stopmessage-resp-1',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'gemini-chat',
      reenterPipeline: async (opts: any) => {
        capturedFollowup = { entryEndpoint: opts?.entryEndpoint, body: opts?.body, metadata: opts?.metadata };
        return {
          body: {
            id: 'resp-stopmessage-followup-1',
            object: 'response',
            model: 'gemini-test',
            status: 'completed',
            output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] }]
          } as JsonObject
        };
      }
    });

    expect(orchestration.executed).toBe(true);
    expect(orchestration.flowId).toBe('stop_message_flow');

    expect(fs.existsSync(path.join(SESSION_DIR, `session-${sessionId}.json`))).toBe(false);

    expect(capturedFollowup).toBeTruthy();
    expect(capturedFollowup?.entryEndpoint).toBe('/v1/responses');
    expect(capturedFollowup?.metadata?.__rt?.disableStickyRoutes).toBe(true);
    expect(capturedFollowup?.metadata?.__rt?.preserveRouteHint).toBe(false);
    expect(capturedFollowup?.metadata?.stream).toBe(false);
    expect(capturedFollowup?.metadata?.__rt?.serverToolOriginalEntryEndpoint).toBe('/v1/responses');

    const payload = capturedFollowup?.body as any;
    expect(Array.isArray(payload.messages)).toBe(true);
    expect(payload.stream).toBe(false);
    expect(payload.parameters).toBeDefined();
    expect(payload.parameters.stream).toBeUndefined();
    expect(payload.parameters.max_output_tokens).toBe(99);
    expect(payload.parameters.temperature).toBe(0.1);
    expect(Array.isArray(payload.tools)).toBe(true);
    expect(JSON.stringify(payload.tools)).toContain("\"name\":\"apply_patch\"");

    const inputText = JSON.stringify(payload.messages);
    expect(inputText).toContain('hi');
    expect(inputText).toContain('继续执行');
  });

  test('builds /v1/responses followup when captured request is a Responses payload', async () => {
    const sessionId = 'stopmessage-spec-session-responses-captured';
    const state: RoutingInstructionState = {
      forcedTarget: undefined,
      stickyTarget: undefined,
      allowedProviders: new Set(),
      disabledProviders: new Set(),
      disabledKeys: new Map(),
      disabledModels: new Map(),
      stopMessageText: '继续执行',
      stopMessageMaxRepeats: 1,
      stopMessageUsed: 0
    };
    writeRoutingStateForSession(sessionId, state);

    const capturedChatSeed: JsonObject = {
      model: 'gemini-test',
      messages: [{ role: 'user', content: 'hi' }],
      parameters: {
        max_output_tokens: 77,
        temperature: 0.2,
        stream: true
      }
    };
    const capturedChatRequest = buildResponsesRequestFromChat(capturedChatSeed as any, {
      stream: true
    }).request as unknown as JsonObject;

    const responsesPayload: JsonObject = {
      id: 'resp-stopmessage-2',
      object: 'response',
      model: 'gemini-test',
      status: 'completed',
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }]
    };

    const adapterContext: AdapterContext = {
      requestId: 'req-stopmessage-resp-2',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'gemini-chat',
      sessionId,
      capturedChatRequest
    } as any;

    let capturedFollowup: { entryEndpoint?: string; body?: any; metadata?: any } | null = null;
    const orchestration = await runServerToolOrchestration({
      chat: responsesPayload,
      adapterContext,
      requestId: 'req-stopmessage-resp-2',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'gemini-chat',
      reenterPipeline: async (opts: any) => {
        capturedFollowup = { entryEndpoint: opts?.entryEndpoint, body: opts?.body, metadata: opts?.metadata };
        return {
          body: {
            id: 'resp-stopmessage-followup-2',
            object: 'response',
            model: 'gemini-test',
            status: 'completed',
            output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] }]
          } as JsonObject
        };
      }
    });

    expect(orchestration.executed).toBe(true);
    expect(orchestration.flowId).toBe('stop_message_flow');
    expect(capturedFollowup).toBeTruthy();
    expect(capturedFollowup?.entryEndpoint).toBe('/v1/responses');
    expect(capturedFollowup?.metadata?.stream).toBe(false);

    const payload = capturedFollowup?.body as any;
    expect(Array.isArray(payload.messages)).toBe(true);
    expect(payload.stream).toBe(false);
    expect(payload.parameters).toBeDefined();
    expect(payload.parameters.stream).toBeUndefined();
    expect(payload.parameters.max_output_tokens).toBe(77);
    expect(payload.parameters.temperature).toBe(0.2);

    const inputText = JSON.stringify(payload.messages);
    expect(inputText).toContain('hi');
    expect(inputText).toContain('继续执行');
  });

  test('still arms stopMessage followup when client is already disconnected', async () => {
    const sessionId = 'stopmessage-spec-session-disconnected';
    const state: RoutingInstructionState = {
      forcedTarget: undefined,
      stickyTarget: undefined,
      allowedProviders: new Set(),
      disabledProviders: new Set(),
      disabledKeys: new Map(),
      disabledModels: new Map(),
      stopMessageText: '立即执行待处理任务',
      stopMessageMaxRepeats: 2,
      stopMessageUsed: 0
    };
    writeRoutingStateForSession(sessionId, state);

    const capturedChatRequest: JsonObject = {
      model: 'gpt-test',
      messages: [
        {
          role: 'user',
          content: 'hi'
        }
      ]
    };

    const chatResponse: JsonObject = {
      id: 'chatcmpl-stop-2',
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

    const adapterContext: AdapterContext = {
      requestId: 'req-stopmessage-2',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      sessionId,
      capturedChatRequest,
      clientConnectionState: { disconnected: true }
    } as any;

    const result = await runServerSideToolEngine({
      chatResponse,
      adapterContext,
      entryEndpoint: '/v1/chat/completions',
      requestId: 'req-stopmessage-2',
      providerProtocol: 'openai-chat'
    });

    expect(result.mode).toBe('tool_flow');
    expect(result.execution?.flowId).toBe('stop_message_flow');
    const persisted = await readJsonFileUntil<{ state?: { stopMessageUsed?: number; stopMessageLastUsedAt?: number } }>(
      path.join(SESSION_DIR, `session-${sessionId}.json`),
      (data) => data?.state?.stopMessageUsed === 1 && typeof data?.state?.stopMessageLastUsedAt === 'number'
    );
    expect(persisted?.state?.stopMessageUsed).toBe(1);
  });

  test('emits stop compare context even when client is already disconnected', async () => {
    const sessionId = 'stopmessage-spec-session-disconnected-compare';
    const state: RoutingInstructionState = {
      forcedTarget: undefined,
      stickyTarget: undefined,
      allowedProviders: new Set(),
      disabledProviders: new Set(),
      disabledKeys: new Map(),
      disabledModels: new Map(),
      stopMessageText: '立即执行待处理任务',
      stopMessageMaxRepeats: 2,
      stopMessageUsed: 0
    };
    writeRoutingStateForSession(sessionId, state);

    const chatResponse: JsonObject = {
      id: 'chatcmpl-stop-disconnected-compare',
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

    const adapterContext: AdapterContext = {
      requestId: 'req-stopmessage-disconnected-compare',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      sessionId,
      capturedChatRequest: {
        model: 'gpt-test',
        messages: [{ role: 'user', content: 'hi' }]
      },
      clientConnectionState: { disconnected: true }
    } as any;

    const records: Array<{ stage: string; payload: Record<string, unknown> }> = [];
    const stageRecorder = {
      record(stage: string, payload: Record<string, unknown>) {
        records.push({ stage, payload });
      }
    } as any;

    const result = await runServerToolOrchestration({
      chat: chatResponse,
      adapterContext,
      requestId: 'req-stopmessage-disconnected-compare',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      stageRecorder
    });

    expect(result.executed).toBe(true);
    expect(result.flowId).toBe('stop_message_flow');
    const compare = records.find((entry) => entry.stage === 'servertool.stop_compare')?.payload as any;
    expect(compare).toBeDefined();
    expect(typeof compare?.summary).toBe('string');
    expect(String(compare?.summary)).not.toContain('no_context');
    expect(compare?.compare?.reason).toBe('triggered');
  });

  test('stops waiting followup when client disconnects during reenter', async () => {
    const sessionId = 'stopmessage-spec-session-disconnect-during-followup';
    const state: RoutingInstructionState = {
      forcedTarget: undefined,
      stickyTarget: undefined,
      allowedProviders: new Set(),
      disabledProviders: new Set(),
      disabledKeys: new Map(),
      disabledModels: new Map(),
      stopMessageText: '立即执行待处理任务',
      stopMessageMaxRepeats: 2,
      stopMessageUsed: 0
    };
    writeRoutingStateForSession(sessionId, state);

    const capturedChatRequest: JsonObject = {
      model: 'gpt-test',
      messages: [
        {
          role: 'user',
          content: 'hi'
        }
      ]
    };

    const chatResponse: JsonObject = {
      id: 'chatcmpl-stop-disconnect-during-followup',
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

    const connectionState = { disconnected: false };
    const adapterContext: AdapterContext = {
      requestId: 'req-stopmessage-disconnect-during-followup',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      sessionId,
      capturedChatRequest,
      clientConnectionState: connectionState
    } as any;

    let reenterCalls = 0;
    setTimeout(() => {
      connectionState.disconnected = true;
    }, 30);

    const orchestration = await runServerToolOrchestration({
      chat: chatResponse,
      adapterContext,
      requestId: 'req-stopmessage-disconnect-during-followup',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      reenterPipeline: async () => {
        reenterCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 220));
        return {
          body: {
            id: 'chatcmpl-stop-disconnect-during-followup-final',
            object: 'chat.completion',
            model: 'gpt-test',
            choices: [{ index: 0, message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }]
          } as JsonObject
        };
      }
    });

    expect(reenterCalls).toBe(1);
    expect(orchestration.executed).toBe(true);
    expect(orchestration.flowId).toBe('stop_message_flow');
    expect((orchestration.chat as any)?.choices?.[0]?.message?.content).toBe('ok');
  });

  test('forces followup stream=false even when captured parameters.stream=true', async () => {
    const sessionId = 'stopmessage-spec-session-stream-override';
    const state: RoutingInstructionState = {
      forcedTarget: undefined,
      stickyTarget: undefined,
      allowedProviders: new Set(),
      disabledProviders: new Set(),
      disabledKeys: new Map(),
      disabledModels: new Map(),
      stopMessageText: '立即执行待处理任务',
      stopMessageMaxRepeats: 1,
      stopMessageUsed: 0
    };
    writeRoutingStateForSession(sessionId, state);

    const capturedChatRequest: JsonObject = {
      model: 'gpt-test',
      messages: [
        {
          role: 'user',
          content: 'hi'
        }
      ],
      parameters: {
        stream: true
      }
    };

    const chatResponse: JsonObject = {
      id: 'chatcmpl-stop-stream-1',
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

    const adapterContext: AdapterContext = {
      requestId: 'req-stopmessage-stream-1',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      sessionId,
      capturedChatRequest
    } as any;

    let sawFollowupStreamFalse = false;
    const orchestration = await runServerToolOrchestration({
      chat: chatResponse,
      adapterContext,
      requestId: 'req-stopmessage-stream-1',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      reenterPipeline: async (opts: any) => {
        sawFollowupStreamFalse = opts?.body?.stream === false;
        return {
          body: {
            id: 'chatcmpl-stop-stream-1-followup',
            object: 'chat.completion',
            model: 'gpt-test',
            choices: [{ index: 0, message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }]
          } as JsonObject
        };
      }
    });

    expect(orchestration.executed).toBe(true);
    expect(orchestration.flowId).toBe('stop_message_flow');
    expect(sawFollowupStreamFalse).toBe(true);
  });

  test('retries once on empty stop_followup and then succeeds', async () => {
    const sessionId = 'stopmessage-spec-session-empty-retry';
    const state: RoutingInstructionState = {
      forcedTarget: undefined,
      stickyTarget: undefined,
      allowedProviders: new Set(),
      disabledProviders: new Set(),
      disabledKeys: new Map(),
      disabledModels: new Map(),
      stopMessageText: '立即执行待处理任务',
      stopMessageMaxRepeats: 1,
      stopMessageUsed: 0
    };
    writeRoutingStateForSession(sessionId, state);

    const capturedChatRequest: JsonObject = {
      model: 'gpt-test',
      messages: [
        {
          role: 'user',
          content: 'hi'
        }
      ]
    };

    const chatResponse: JsonObject = {
      id: 'chatcmpl-stop-empty-1',
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

    const adapterContext: AdapterContext = {
      requestId: 'req-stopmessage-empty-1',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      sessionId,
      capturedChatRequest
    } as any;

    let callCount = 0;
    const orchestration = await runServerToolOrchestration({
      chat: chatResponse,
      adapterContext,
      requestId: 'req-stopmessage-empty-1',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      reenterPipeline: async () => {
        callCount += 1;
        if (callCount === 1) {
          return {
            body: {
              id: 'chatcmpl-followup-empty',
              object: 'chat.completion',
              model: 'gpt-test',
              choices: [{ index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'stop' }]
            } as JsonObject
          };
        }
        return {
          body: {
            id: 'chatcmpl-followup-nonempty',
            object: 'chat.completion',
            model: 'gpt-test',
            choices: [{ index: 0, message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }]
          } as JsonObject
        };
      }
    });

    expect(orchestration.executed).toBe(true);
    expect(orchestration.flowId).toBe('stop_message_flow');
    expect(callCount).toBe(2);
    expect((orchestration.chat as any)?.id).toBe('chatcmpl-followup-nonempty');
  });


  test('errors when stop_followup stays empty after retry', async () => {
    const sessionId = 'stopmessage-spec-session-empty-error';
    const state: RoutingInstructionState = {
      forcedTarget: undefined,
      stickyTarget: undefined,
      allowedProviders: new Set(),
      disabledProviders: new Set(),
      disabledKeys: new Map(),
      disabledModels: new Map(),
      stopMessageText: '立即执行待处理任务',
      stopMessageMaxRepeats: 1,
      stopMessageUsed: 0
    };
    writeRoutingStateForSession(sessionId, state);

    const capturedChatRequest: JsonObject = {
      model: 'gpt-test',
      messages: [
        {
          role: 'user',
          content: 'hi'
        }
      ]
    };

    const chatResponse: JsonObject = {
      id: 'chatcmpl-stop-empty-2',
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

    const adapterContext: AdapterContext = {
      requestId: 'req-stopmessage-empty-2',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      sessionId,
      capturedChatRequest
    } as any;

    const orchestration = await runServerToolOrchestration({
      chat: chatResponse,
      adapterContext,
      requestId: 'req-stopmessage-empty-2',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      reenterPipeline: async () => ({
        body: {
          id: 'chatcmpl-followup-empty',
          object: 'chat.completion',
          model: 'gpt-test',
          choices: [{ index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'stop' }]
        } as JsonObject
      })
    });

    // stopMessage followup empty: should not bubble 502; return original response and disable stopMessage to avoid loops.
    expect(orchestration.executed).toBe(true);
    expect(orchestration.flowId).toBe('stop_message_flow');
    expect((orchestration.chat as any)?.id).toBe('chatcmpl-stop-empty-2');

    expect(fs.existsSync(path.join(SESSION_DIR, `session-${sessionId}.json`))).toBe(false);
  });

  test('throws explicit empty-followup error when both followup and original response are empty', async () => {
    const sessionId = 'stopmessage-spec-session-empty-error-empty-original';
    const state: RoutingInstructionState = {
      forcedTarget: undefined,
      stickyTarget: undefined,
      allowedProviders: new Set(),
      disabledProviders: new Set(),
      disabledKeys: new Map(),
      disabledModels: new Map(),
      stopMessageText: '立即执行待处理任务',
      stopMessageMaxRepeats: 1,
      stopMessageUsed: 0
    };
    writeRoutingStateForSession(sessionId, state);

    const capturedChatRequest: JsonObject = {
      model: 'gpt-test',
      messages: [{ role: 'user', content: 'hi' }]
    };

    const chatResponse: JsonObject = {
      id: 'chatcmpl-stop-empty-original',
      object: 'chat.completion',
      model: 'gpt-test',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: ''
          },
          finish_reason: 'stop'
        }
      ]
    };

    const adapterContext: AdapterContext = {
      requestId: 'req-stopmessage-empty-original',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      sessionId,
      capturedChatRequest
    } as any;

    let callCount = 0;
    await expect(
      runServerToolOrchestration({
        chat: chatResponse,
        adapterContext,
        requestId: 'req-stopmessage-empty-original',
        entryEndpoint: '/v1/chat/completions',
        providerProtocol: 'openai-chat',
        reenterPipeline: async () => {
          callCount += 1;
          return {
            body: {
              id: 'chatcmpl-followup-empty-empty-original',
              object: 'chat.completion',
              model: 'gpt-test',
              choices: [{ index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'stop' }]
            } as JsonObject
          };
        }
      })
    ).rejects.toMatchObject({
      code: 'SERVERTOOL_EMPTY_FOLLOWUP',
      status: 502
    });
    expect(callCount).toBe(2);

    expect(fs.existsSync(path.join(SESSION_DIR, `session-${sessionId}.json`))).toBe(false);
  });

  test('injects loop-break warning after 5 identical stopMessage request/response rounds', async () => {
    const sessionId = 'stopmessage-spec-session-loop-warn';
    const state: RoutingInstructionState = {
      forcedTarget: undefined,
      stickyTarget: undefined,
      allowedProviders: new Set(),
      disabledProviders: new Set(),
      disabledKeys: new Map(),
      disabledModels: new Map(),
      stopMessageText: '立即执行待处理任务',
      stopMessageMaxRepeats: 30,
      stopMessageUsed: 0
    };
    writeRoutingStateForSession(sessionId, state);

    const capturedChatRequest: JsonObject = {
      model: 'gpt-test',
      messages: [{ role: 'user', content: 'hi' }]
    };

    const chatResponse: JsonObject = {
      id: 'chatcmpl-stop-loop-warn',
      object: 'chat.completion',
      model: 'gpt-test',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'ok' },
          finish_reason: 'stop'
        }
      ]
    };

    const adapterContext: AdapterContext = {
      requestId: 'req-stopmessage-loop-warn',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      sessionId,
      capturedChatRequest
    } as any;

    let lastFollowupBody: JsonObject | undefined;
    for (let round = 1; round <= 5; round += 1) {
      let nextLoopState: Record<string, unknown> | undefined;
      const orchestration = await runServerToolOrchestration({
        chat: chatResponse,
        adapterContext,
        requestId: `req-stopmessage-loop-warn-${round}`,
        entryEndpoint: '/v1/chat/completions',
        providerProtocol: 'openai-chat',
        reenterPipeline: async (opts: any) => {
          nextLoopState = opts?.metadata?.__rt?.serverToolLoopState as Record<string, unknown> | undefined;
          lastFollowupBody = opts?.body as JsonObject;
          return {
            body: {
              id: 'chatcmpl-followup-loop-warn',
              object: 'chat.completion',
              model: 'gpt-test',
              choices: [{ index: 0, message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }]
            } as JsonObject
          };
        }
      });

      expect(orchestration.executed).toBe(true);
      expect(orchestration.flowId).toBe('stop_message_flow');
      adapterContext.__rt = nextLoopState ? { serverToolLoopState: nextLoopState } : undefined;
    }

    const messages = Array.isArray((lastFollowupBody as any)?.messages) ? ((lastFollowupBody as any).messages as any[]) : [];
    expect(
      messages.some(
        (item) =>
          item &&
          typeof item === 'object' &&
          item.role === 'system' &&
          typeof item.content === 'string' &&
          item.content.includes('连续 5 轮一致')
      )
    ).toBe(true);
  });

  test('returns fetch failed after 10 identical stopMessage request/response rounds', async () => {
    const sessionId = 'stopmessage-spec-session-loop-fail';
    const state: RoutingInstructionState = {
      forcedTarget: undefined,
      stickyTarget: undefined,
      allowedProviders: new Set(),
      disabledProviders: new Set(),
      disabledKeys: new Map(),
      disabledModels: new Map(),
      stopMessageText: '立即执行待处理任务',
      stopMessageMaxRepeats: 30,
      stopMessageUsed: 0
    };
    writeRoutingStateForSession(sessionId, state);

    const capturedChatRequest: JsonObject = {
      model: 'gpt-test',
      messages: [{ role: 'user', content: 'hi' }]
    };

    const chatResponse: JsonObject = {
      id: 'chatcmpl-stop-loop-fail',
      object: 'chat.completion',
      model: 'gpt-test',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'ok' },
          finish_reason: 'stop'
        }
      ]
    };

    const adapterContext: AdapterContext = {
      requestId: 'req-stopmessage-loop-fail',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      sessionId,
      capturedChatRequest
    } as any;

    for (let round = 1; round <= 9; round += 1) {
      let nextLoopState: Record<string, unknown> | undefined;
      const orchestration = await runServerToolOrchestration({
        chat: chatResponse,
        adapterContext,
        requestId: `req-stopmessage-loop-fail-${round}`,
        entryEndpoint: '/v1/chat/completions',
        providerProtocol: 'openai-chat',
        reenterPipeline: async (opts: any) => {
          nextLoopState = opts?.metadata?.__rt?.serverToolLoopState as Record<string, unknown> | undefined;
          return {
            body: {
              id: 'chatcmpl-followup-loop-fail',
              object: 'chat.completion',
              model: 'gpt-test',
              choices: [{ index: 0, message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }]
            } as JsonObject
          };
        }
      });
      expect(orchestration.executed).toBe(true);
      adapterContext.__rt = nextLoopState ? { serverToolLoopState: nextLoopState } : undefined;
    }

    let followupCalled = false;
    await expect(
      runServerToolOrchestration({
        chat: chatResponse,
        adapterContext,
        requestId: 'req-stopmessage-loop-fail-10',
        entryEndpoint: '/v1/chat/completions',
        providerProtocol: 'openai-chat',
        reenterPipeline: async () => {
          followupCalled = true;
          return {
            body: {
              id: 'chatcmpl-followup-loop-fail-10',
              object: 'chat.completion',
              model: 'gpt-test',
              choices: [{ index: 0, message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }]
            } as JsonObject
          };
        }
      })
    ).rejects.toMatchObject({
      code: 'SERVERTOOL_TIMEOUT',
      status: 502
    });
    expect(followupCalled).toBe(false);
  });

  test('returns fetch failed when stopMessage flow elapsed time exceeds 900 seconds', async () => {
    const sessionId = 'stopmessage-spec-session-stage-timeout';
    const state: RoutingInstructionState = {
      forcedTarget: undefined,
      stickyTarget: undefined,
      allowedProviders: new Set(),
      disabledProviders: new Set(),
      disabledKeys: new Map(),
      disabledModels: new Map(),
      stopMessageText: '立即执行待处理任务',
      stopMessageMaxRepeats: 30,
      stopMessageUsed: 0
    };
    writeRoutingStateForSession(sessionId, state);

    const capturedChatRequest: JsonObject = {
      model: 'gpt-test',
      messages: [{ role: 'user', content: 'hi' }]
    };

    const chatResponse: JsonObject = {
      id: 'chatcmpl-stop-stage-timeout',
      object: 'chat.completion',
      model: 'gpt-test',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'ok' },
          finish_reason: 'stop'
        }
      ]
    };

    const adapterContext: AdapterContext = {
      requestId: 'req-stopmessage-stage-timeout',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      sessionId,
      capturedChatRequest,
      __rt: {
        serverToolLoopState: {
          flowId: 'stop_message_flow',
          payloadHash: '__servertool_auto__',
          repeatCount: 7,
          startedAtMs: Date.now() - 901_000
        }
      }
    } as any;

    let followupCalled = false;
    await expect(
      runServerToolOrchestration({
        chat: chatResponse,
        adapterContext,
        requestId: 'req-stopmessage-stage-timeout-1',
        entryEndpoint: '/v1/chat/completions',
        providerProtocol: 'openai-chat',
        reenterPipeline: async () => {
          followupCalled = true;
          return {
            body: {
              id: 'chatcmpl-followup-stage-timeout',
              object: 'chat.completion',
              model: 'gpt-test',
              choices: [{ index: 0, message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }]
            } as JsonObject
          };
        }
      })
    ).rejects.toMatchObject({
      code: 'SERVERTOOL_TIMEOUT',
      status: 502
    });
    expect(followupCalled).toBe(false);
  });
  test('ignores stage policy templates in stop_message_auto followup flow', async () => {
    const tempUserDir = fs.mkdtempSync(path.join(process.cwd(), 'tmp', 'stopmessage-stage-userdir-'));
    const prevUserDir = process.env.ROUTECODEX_USER_DIR;
    const prevStageMode = process.env.ROUTECODEX_STOPMESSAGE_STAGE_MODE;
    try {
      fs.mkdirSync(path.join(tempUserDir, 'stopMessage'), { recursive: true });
      fs.writeFileSync(
        path.join(tempUserDir, 'stopMessage', 'stage-status-check.md'),
        '阶段A：先看 BD 状态\n{{BASE_STOP_MESSAGE}}',
        'utf8'
      );
      fs.writeFileSync(
        path.join(tempUserDir, 'stopMessage', 'stage-loop-self-check.md'),
        '阶段B：循环自检\n{{BASE_STOP_MESSAGE}}',
        'utf8'
      );
      process.env.ROUTECODEX_USER_DIR = tempUserDir;
      process.env.ROUTECODEX_STOPMESSAGE_STAGE_MODE = 'on';

      const sessionId = 'stopmessage-spec-session-stage-1';
      const state: RoutingInstructionState = {
        forcedTarget: undefined,
        stickyTarget: undefined,
        allowedProviders: new Set(),
        disabledProviders: new Set(),
        disabledKeys: new Map(),
        disabledModels: new Map(),
        stopMessageText: '先执行、后汇报',
        stopMessageMaxRepeats: 5,
        stopMessageUsed: 0
      };
      writeRoutingStateForSession(sessionId, state);

      const chatResponse: JsonObject = {
        id: 'chatcmpl-stage-1',
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

      const adapterContext: AdapterContext = {
        requestId: 'req-stopmessage-stage-1',
        entryEndpoint: '/v1/chat/completions',
        providerProtocol: 'openai-chat',
        sessionId,
        capturedChatRequest: {
          model: 'gpt-test',
          messages: [
            { role: 'user', content: '先执行任务' },
            { role: 'assistant', content: '收到' },
            { role: 'tool', content: '执行了代码修改并准备验证' }
          ]
        }
      } as any;

      const result = await runServerSideToolEngine({
        chatResponse,
        adapterContext,
        entryEndpoint: '/v1/chat/completions',
        requestId: 'req-stopmessage-stage-1',
        providerProtocol: 'openai-chat'
      });

      expect(result.mode).toBe('tool_flow');
      const followup = result.execution?.followup as any;
      const ops = Array.isArray(followup?.injection?.ops) ? followup.injection.ops : [];
      const appendUserText = ops.find((entry: any) => entry?.op === 'append_user_text');
      expect(appendUserText?.text).toContain('先执行、后汇报');

      const persisted = await readJsonFileUntil<{ state?: { stopMessageUsed?: number; stopMessageStage?: unknown } }>(
        path.join(SESSION_DIR, `session-${sessionId}.json`),
        (data) => data?.state?.stopMessageUsed === 1
      );
      expect(appendUserText?.text).not.toContain('阶段A：先看 BD 状态');
      expect(persisted?.state?.stopMessageStage).toBeUndefined();
    } finally {
      if (prevUserDir === undefined) {
        delete process.env.ROUTECODEX_USER_DIR;
      } else {
        process.env.ROUTECODEX_USER_DIR = prevUserDir;
      }
      if (prevStageMode === undefined) {
        delete process.env.ROUTECODEX_STOPMESSAGE_STAGE_MODE;
      } else {
        process.env.ROUTECODEX_STOPMESSAGE_STAGE_MODE = prevStageMode;
      }
      fs.rmSync(tempUserDir, { recursive: true, force: true });
    }
  });


  test('mode-only stopMessage does not trigger followup without text', async () => {
    const tempUserDir = fs.mkdtempSync(path.join(process.cwd(), 'tmp', 'stopmessage-stage-mode-only-userdir-'));
    const prevUserDir = process.env.ROUTECODEX_USER_DIR;
    const prevStageMode = process.env.ROUTECODEX_STOPMESSAGE_STAGE_MODE;
    const prevBdMode = process.env.ROUTECODEX_STOPMESSAGE_BD_MODE;
    try {
      fs.mkdirSync(path.join(tempUserDir, 'stopMessage'), { recursive: true });
      fs.writeFileSync(
        path.join(tempUserDir, 'stopMessage', 'stage-status-check.md'),
        '阶段A：状态确认\n{{BASE_STOP_MESSAGE}}',
        'utf8'
      );
      fs.writeFileSync(
        path.join(tempUserDir, 'stopMessage', 'stage-active-continue.md'),
        '阶段A2：根据 BD 状态继续执行\n{{BASE_STOP_MESSAGE}}',
        'utf8'
      );
      fs.writeFileSync(
        path.join(tempUserDir, 'stopMessage', 'stage-loop-self-check.md'),
        '阶段B：循环自检\n{{BASE_STOP_MESSAGE}}',
        'utf8'
      );
      process.env.ROUTECODEX_USER_DIR = tempUserDir;
      process.env.ROUTECODEX_STOPMESSAGE_STAGE_MODE = 'on';
      process.env.ROUTECODEX_STOPMESSAGE_BD_MODE = 'heuristic';

      const sessionId = 'stopmessage-spec-session-stage-mode-only';
      const state: RoutingInstructionState = {
        forcedTarget: undefined,
        stickyTarget: undefined,
        allowedProviders: new Set(),
        disabledProviders: new Set(),
        disabledKeys: new Map(),
        disabledModels: new Map(),
        stopMessageMaxRepeats: 10,
        stopMessageUsed: 0,
        stopMessageStageMode: 'on'
      };
      writeRoutingStateForSession(sessionId, state);

      const chatResponse: JsonObject = {
        id: 'chatcmpl-stage-mode-only',
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

      const adapterContext: AdapterContext = {
        requestId: 'req-stopmessage-stage-mode-only',
        entryEndpoint: '/v1/chat/completions',
        providerProtocol: 'openai-chat',
        sessionId,
        capturedChatRequest: {
          model: 'gpt-test',
          messages: [
            { role: 'user', content: '继续执行' },
            { role: 'tool', content: 'bd --no-db show routecodex-95\nstatus: in_progress' }
          ]
        }
      } as any;

      const result = await runServerSideToolEngine({
        chatResponse,
        adapterContext,
        entryEndpoint: '/v1/chat/completions',
        requestId: 'req-stopmessage-stage-mode-only',
        providerProtocol: 'openai-chat'
      });

      expect(result.mode).toBe('passthrough');
      expect(result.execution).toBeUndefined();
      const persisted = await readJsonFileUntil<{ state?: { stopMessageText?: unknown; stopMessageStageMode?: unknown; stopMessageUsed?: unknown } }>(
        path.join(SESSION_DIR, `session-${sessionId}.json`),
        (data) =>
          data?.state?.stopMessageText === undefined &&
          data?.state?.stopMessageStageMode === 'on' &&
          data?.state?.stopMessageUsed === 0
      );
      expect(persisted?.state?.stopMessageText).toBeUndefined();
      expect(persisted?.state?.stopMessageStageMode).toBe('on');
    } finally {
      if (prevUserDir === undefined) {
        delete process.env.ROUTECODEX_USER_DIR;
      } else {
        process.env.ROUTECODEX_USER_DIR = prevUserDir;
      }
      if (prevStageMode === undefined) {
        delete process.env.ROUTECODEX_STOPMESSAGE_STAGE_MODE;
      } else {
        process.env.ROUTECODEX_STOPMESSAGE_STAGE_MODE = prevStageMode;
      }
      if (prevBdMode === undefined) {
        delete process.env.ROUTECODEX_STOPMESSAGE_BD_MODE;
      } else {
        process.env.ROUTECODEX_STOPMESSAGE_BD_MODE = prevBdMode;
      }
      fs.rmSync(tempUserDir, { recursive: true, force: true });
    }
  });

  test('mode-only stopMessage remains inactive by default without text', async () => {
    const sessionId = 'stopmessage-spec-session-stage-mode-only-default';
    const state: RoutingInstructionState = {
      forcedTarget: undefined,
      stickyTarget: undefined,
      allowedProviders: new Set(),
      disabledProviders: new Set(),
      disabledKeys: new Map(),
      disabledModels: new Map(),
      stopMessageMaxRepeats: 10,
      stopMessageUsed: 0,
      stopMessageStageMode: 'on'
    };
    writeRoutingStateForSession(sessionId, state);

    const chatResponse: JsonObject = {
      id: 'chatcmpl-stage-mode-only-default',
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

    const adapterContext: AdapterContext = {
      requestId: 'req-stopmessage-stage-mode-only-default',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      sessionId,
      capturedChatRequest: {
        model: 'gpt-test',
        messages: [{ role: 'user', content: '继续执行' }]
      }
    } as any;

    const result = await runServerSideToolEngine({
      chatResponse,
      adapterContext,
      entryEndpoint: '/v1/chat/completions',
      requestId: 'req-stopmessage-stage-mode-only-default',
      providerProtocol: 'openai-chat'
    });

    expect(result.mode).toBe('passthrough');
    expect(result.execution).toBeUndefined();
    const persisted = await readJsonFileUntil<{ state?: { stopMessageUsed?: unknown; stopMessageStageMode?: unknown } }>(
      path.join(SESSION_DIR, `session-${sessionId}.json`),
      (data) => data?.state?.stopMessageUsed === 0
    );
    expect(persisted?.state?.stopMessageUsed).toBe(0);
    expect(persisted?.state?.stopMessageStageMode).toBe('on');
  });

  test('legacy mode-only session state without text does not self-activate', async () => {
    const sessionId = 'stopmessage-spec-session-legacy-mode-only-no-max';
    const state: RoutingInstructionState = {
      forcedTarget: undefined,
      stickyTarget: undefined,
      allowedProviders: new Set(),
      disabledProviders: new Set(),
      disabledKeys: new Map(),
      disabledModels: new Map(),
      stopMessageUsed: 0,
      stopMessageStageMode: 'on'
    };
    writeRoutingStateForSession(sessionId, state);

    const chatResponse: JsonObject = {
      id: 'chatcmpl-stage-legacy-no-max',
      object: 'chat.completion',
      model: 'gpt-test',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: '继续'
          },
          finish_reason: 'stop'
        }
      ]
    };

    const adapterContext: AdapterContext = {
      requestId: 'req-stopmessage-legacy-mode-only-no-max',
      entryEndpoint: '/v1/messages',
      providerProtocol: 'anthropic-messages',
      sessionId,
      capturedChatRequest: {
        model: 'gpt-test',
        messages: [{ role: 'user', content: '继续' }]
      }
    } as any;

    const result = await runServerSideToolEngine({
      chatResponse,
      adapterContext,
      entryEndpoint: '/v1/messages',
      requestId: 'req-stopmessage-legacy-mode-only-no-max',
      providerProtocol: 'anthropic-messages'
    });

    expect(result.mode).toBe('passthrough');
    expect(result.execution).toBeUndefined();

    const persisted = await readJsonFileUntil<{ state?: { stopMessageText?: unknown; stopMessageStageMode?: unknown; stopMessageMaxRepeats?: unknown; stopMessageUsed?: unknown } }>(
      path.join(SESSION_DIR, `session-${sessionId}.json`),
      (data) =>
        data?.state?.stopMessageText === undefined &&
        data?.state?.stopMessageStageMode === 'on' &&
        data?.state?.stopMessageMaxRepeats === undefined &&
        data?.state?.stopMessageUsed === 0
    );
    expect(persisted?.state?.stopMessageText).toBeUndefined();
    expect(persisted?.state?.stopMessageStageMode).toBe('on');
    expect(persisted?.state?.stopMessageMaxRepeats).toBeUndefined();
  });


  test('keeps base stopMessage text even when stage templates and bd in_progress are present', async () => {
    const tempUserDir = fs.mkdtempSync(path.join(process.cwd(), 'tmp', 'stopmessage-stage-active-userdir-'));
    const prevUserDir = process.env.ROUTECODEX_USER_DIR;
    const prevStageMode = process.env.ROUTECODEX_STOPMESSAGE_STAGE_MODE;
    try {
      fs.mkdirSync(path.join(tempUserDir, 'stopMessage'), { recursive: true });
      fs.writeFileSync(
        path.join(tempUserDir, 'stopMessage', 'stage-status-check.md'),
        '阶段A：状态确认\n{{BASE_STOP_MESSAGE}}',
        'utf8'
      );
      fs.writeFileSync(
        path.join(tempUserDir, 'stopMessage', 'stage-active-continue.md'),
        '阶段A2：强制继续执行\n{{BASE_STOP_MESSAGE}}',
        'utf8'
      );
      fs.writeFileSync(
        path.join(tempUserDir, 'stopMessage', 'stage-loop-self-check.md'),
        '阶段B：循环自检\n{{BASE_STOP_MESSAGE}}',
        'utf8'
      );
      process.env.ROUTECODEX_USER_DIR = tempUserDir;
      process.env.ROUTECODEX_STOPMESSAGE_STAGE_MODE = 'on';

      const sessionId = 'stopmessage-spec-session-stage-active';
      const state: RoutingInstructionState = {
        forcedTarget: undefined,
        stickyTarget: undefined,
        allowedProviders: new Set(),
        disabledProviders: new Set(),
        disabledKeys: new Map(),
        disabledModels: new Map(),
        stopMessageText: '继续推进任务',
        stopMessageMaxRepeats: 5,
        stopMessageUsed: 0
      };
      writeRoutingStateForSession(sessionId, state);

      const chatResponse: JsonObject = {
        id: 'chatcmpl-stage-active',
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

      const adapterContext: AdapterContext = {
        requestId: 'req-stopmessage-stage-active',
        entryEndpoint: '/v1/chat/completions',
        providerProtocol: 'openai-chat',
        sessionId,
        capturedChatRequest: {
          model: 'gpt-test',
          messages: [
            { role: 'user', content: '继续执行' },
            { role: 'tool', content: 'bd --no-db show routecodex-77\nstatus: in_progress' }
          ]
        }
      } as any;

      const result = await runServerSideToolEngine({
        chatResponse,
        adapterContext,
        entryEndpoint: '/v1/chat/completions',
        requestId: 'req-stopmessage-stage-active',
        providerProtocol: 'openai-chat'
      });

      expect(result.mode).toBe('tool_flow');
      const followup = result.execution?.followup as any;
      const ops = Array.isArray(followup?.injection?.ops) ? followup.injection.ops : [];
      const appendUserText = ops.find((entry: any) => entry?.op === 'append_user_text');
      expect(appendUserText?.text).toContain('继续推进任务');
      const persisted = await readJsonFileUntil<{ state?: { stopMessageUsed?: number; stopMessageStage?: unknown } }>(
        path.join(SESSION_DIR, `session-${sessionId}.json`),
        (data) => data?.state?.stopMessageUsed === 1
      );
      expect(persisted?.state?.stopMessageStage).toBeUndefined();
    } finally {
      if (prevUserDir === undefined) {
        delete process.env.ROUTECODEX_USER_DIR;
      } else {
        process.env.ROUTECODEX_USER_DIR = prevUserDir;
      }
      if (prevStageMode === undefined) {
        delete process.env.ROUTECODEX_STOPMESSAGE_STAGE_MODE;
      } else {
        process.env.ROUTECODEX_STOPMESSAGE_STAGE_MODE = prevStageMode;
      }
      fs.rmSync(tempUserDir, { recursive: true, force: true });
    }
  });

  test('keeps plain stopMessage followup across repeated rounds', async () => {
    const tempUserDir = fs.mkdtempSync(path.join(process.cwd(), 'tmp', 'stopmessage-stage-loop-userdir-'));
    const prevUserDir = process.env.ROUTECODEX_USER_DIR;
    const prevStageMode = process.env.ROUTECODEX_STOPMESSAGE_STAGE_MODE;
    try {
      fs.mkdirSync(path.join(tempUserDir, 'stopMessage'), { recursive: true });
      fs.writeFileSync(
        path.join(tempUserDir, 'stopMessage', 'stage-status-check.md'),
        '阶段A：状态确认\n{{BASE_STOP_MESSAGE}}',
        'utf8'
      );
      fs.writeFileSync(
        path.join(tempUserDir, 'stopMessage', 'stage-loop-self-check.md'),
        '阶段B：循环自检\n{{BASE_STOP_MESSAGE}}',
        'utf8'
      );
      process.env.ROUTECODEX_USER_DIR = tempUserDir;
      process.env.ROUTECODEX_STOPMESSAGE_STAGE_MODE = 'on';

      const sessionId = 'stopmessage-spec-session-stage-loop';
      const state: RoutingInstructionState = {
        forcedTarget: undefined,
        stickyTarget: undefined,
        allowedProviders: new Set(),
        disabledProviders: new Set(),
        disabledKeys: new Map(),
        disabledModels: new Map(),
        stopMessageText: '继续推进同一任务',
        stopMessageMaxRepeats: 10,
        stopMessageUsed: 0
      };
      writeRoutingStateForSession(sessionId, state);

      const chatResponse: JsonObject = {
        id: 'chatcmpl-stage-loop',
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

      const adapterContext: AdapterContext = {
        requestId: 'req-stopmessage-stage-loop',
        entryEndpoint: '/v1/chat/completions',
        providerProtocol: 'openai-chat',
        sessionId,
        capturedChatRequest: {
          model: 'gpt-test',
          messages: [
            { role: 'user', content: '继续处理' },
            { role: 'assistant', content: '处理中' },
            { role: 'tool', content: 'bd --no-db show routecodex-77\nstatus: in_progress' }
          ]
        }
      } as any;

      const first = await runServerSideToolEngine({
        chatResponse,
        adapterContext,
        entryEndpoint: '/v1/chat/completions',
        requestId: 'req-stopmessage-stage-loop-1',
        providerProtocol: 'openai-chat'
      });
      expect(first.mode).toBe('tool_flow');
      await readJsonFileUntil<{ state?: { stopMessageUsed?: number } }>(
        path.join(SESSION_DIR, `session-${sessionId}.json`),
        (data) => data?.state?.stopMessageUsed === 1
      );

      const second = await runServerSideToolEngine({
        chatResponse,
        adapterContext,
        entryEndpoint: '/v1/chat/completions',
        requestId: 'req-stopmessage-stage-loop-2',
        providerProtocol: 'openai-chat'
      });
      expect(second.mode).toBe('tool_flow');
      await readJsonFileUntil<{ state?: { stopMessageUsed?: number } }>(
        path.join(SESSION_DIR, `session-${sessionId}.json`),
        (data) => data?.state?.stopMessageUsed === 2
      );

      const third = await runServerSideToolEngine({
        chatResponse,
        adapterContext,
        entryEndpoint: '/v1/chat/completions',
        requestId: 'req-stopmessage-stage-loop-3',
        providerProtocol: 'openai-chat'
      });
      expect(third.mode).toBe('tool_flow');

      const persisted = await readJsonFileUntil<{ state?: { stopMessageText?: unknown; stopMessageMaxRepeats?: unknown; stopMessageUsed?: number } }>(
        path.join(SESSION_DIR, `session-${sessionId}.json`),
        (data) =>
          data?.state?.stopMessageText === '继续推进同一任务' &&
          data?.state?.stopMessageMaxRepeats === 10 &&
          data?.state?.stopMessageUsed === 3
      );
      expect(persisted?.state?.stopMessageText).toBe('继续推进同一任务');
      expect(persisted?.state?.stopMessageMaxRepeats).toBe(10);
    } finally {
      if (prevUserDir === undefined) {
        delete process.env.ROUTECODEX_USER_DIR;
      } else {
        process.env.ROUTECODEX_USER_DIR = prevUserDir;
      }
      if (prevStageMode === undefined) {
        delete process.env.ROUTECODEX_STOPMESSAGE_STAGE_MODE;
      } else {
        process.env.ROUTECODEX_STOPMESSAGE_STAGE_MODE = prevStageMode;
      }
      fs.rmSync(tempUserDir, { recursive: true, force: true });
    }
  });


  test('extracts structured blocked JSON report from assistant text payload', () => {
    const report = extractBlockedReportFromMessagesForTests([
      {
        role: 'assistant',
        content: [
          {
            type: 'text',
            text: [
              '执行受阻，请建单：',
              '```json',
              '{"type":"blocked","summary":"deepseek token refresh failed","blocker":"HTTP 401 from oauth endpoint","impact":"cannot continue auth flow","next_action":"rotate credential and retry","evidence":["requestId=req_1","provider=deepseek-web.3"]}',
              '```'
            ].join('\n')
          }
        ]
      }
    ]);

    expect(report).toBeTruthy();
    expect(report?.summary).toBe('deepseek token refresh failed');
    expect(report?.blocker).toBe('HTTP 401 from oauth endpoint');
    expect(report?.nextAction).toBe('rotate credential and retry');
    expect(report?.evidence).toEqual(['requestId=req_1', 'provider=deepseek-web.3']);
  });

});
