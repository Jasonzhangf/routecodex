import { afterAll, describe, expect, test } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runServerToolOrchestration } from '../../sharedmodule/llmswitch-core/src/servertool/engine.js';
import type { AdapterContext } from '../../sharedmodule/llmswitch-core/src/conversion/hub/types/chat-envelope.js';
import type { JsonObject } from '../../sharedmodule/llmswitch-core/src/conversion/hub/types/json.js';

function buildReviewToolCallPayload(argsOverride?: Record<string, unknown>): JsonObject {
  const toolArgs = {
    goal: '检查当前实现是否真的完成目标并给出下一步动作',
    focus: 'tests/build/evidence',
    ...(argsOverride ?? {})
  };
  return {
    id: 'chatcmpl-review-1',
    object: 'chat.completion',
    model: 'kimi-k2.5',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_review_1',
              type: 'function',
              function: {
                name: 'review',
                arguments: JSON.stringify(toolArgs)
              }
            }
          ]
        },
        finish_reason: 'tool_calls'
      }
    ]
  } as JsonObject;
}

function flattenMessageText(body: JsonObject | undefined): string {
  const messages = Array.isArray((body as any)?.messages) ? ((body as any).messages as Array<Record<string, unknown>>) : [];
  const chunks: string[] = [];
  for (const message of messages) {
    const content = message?.content;
    if (typeof content === 'string' && content.trim()) {
      chunks.push(content.trim());
    }
  }
  return chunks.join('\n');
}

function readLastMessageText(body: JsonObject | undefined): string {
  const messages = Array.isArray((body as any)?.messages) ? ((body as any).messages as Array<Record<string, unknown>>) : [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const content = messages[i]?.content;
    if (typeof content === 'string' && content.trim()) {
      return content.trim();
    }
  }
  return '';
}

describe('review servertool followup', () => {
  const prevEnabled = process.env.ROUTECODEX_STOPMESSAGE_AI_FOLLOWUP_ENABLED;

  afterAll(() => {
    if (prevEnabled === undefined) {
      delete process.env.ROUTECODEX_STOPMESSAGE_AI_FOLLOWUP_ENABLED;
      return;
    }
    process.env.ROUTECODEX_STOPMESSAGE_AI_FOLLOWUP_ENABLED = prevEnabled;
  });

  test('uses reenter followup by default and skips clientInject dispatch', async () => {
    process.env.ROUTECODEX_STOPMESSAGE_AI_FOLLOWUP_ENABLED = '0';

    const adapterContext: AdapterContext = {
      requestId: 'req-review-1',
      entryEndpoint: '/v1/messages',
      providerProtocol: 'anthropic-messages',
      providerKey: 'glm.1-186.kimi-k2.5',
      stream: false,
      sessionId: 'session-review-1',
      metadata: {
        workdir: '/tmp/review-workdir'
      },
      capturedChatRequest: {
        model: 'kimi-k2.5',
        messages: [{ role: 'user', content: '请继续实现并自查。' }]
      }
    } as any;

    let capturedFollowupMeta: Record<string, unknown> | null = null;
    let capturedFollowupBody: JsonObject | undefined;
    let clientInjectCalled = false;
    let reenterCalled = false;
    const orchestration = await runServerToolOrchestration({
      chat: buildReviewToolCallPayload(),
      adapterContext,
      requestId: 'req-review-1',
      entryEndpoint: '/v1/messages',
      providerProtocol: 'anthropic-messages',
      reenterPipeline: async (opts: any) => {
        reenterCalled = true;
        capturedFollowupMeta =
          opts?.metadata && typeof opts.metadata === 'object'
            ? (opts.metadata as Record<string, unknown>)
            : null;
        capturedFollowupBody = opts?.body as JsonObject | undefined;
        return { body: { id: 'reentered' } as JsonObject };
      },
      clientInjectDispatch: async (opts: any) => {
        clientInjectCalled = true;
        capturedFollowupMeta =
          opts?.metadata && typeof opts.metadata === 'object'
            ? (opts.metadata as Record<string, unknown>)
            : null;
        capturedFollowupBody = opts?.body as JsonObject | undefined;
        return { ok: true } as any;
      }
    });

    expect(orchestration.executed).toBe(true);
    expect(orchestration.flowId).toBe('review_flow');
    expect(reenterCalled).toBe(true);
    expect(clientInjectCalled).toBe(false);
    expect(capturedFollowupMeta).toBeTruthy();
    expect((capturedFollowupMeta as any)?.clientInjectOnly).toBeUndefined();
    expect((capturedFollowupMeta as any)?.workdir).toBe('/tmp/review-workdir');
    expect((capturedFollowupMeta as any)?.cwd).toBe('/tmp/review-workdir');
    const followupText = flattenMessageText(capturedFollowupBody);
    expect(followupText).toContain('代码 review');
    expect(followupText).toContain(
      '必须先根据本次请求逐条核验代码'
    );
    const followupBodyJson = JSON.stringify(capturedFollowupBody);
    expect(followupBodyJson).toContain('queued for servertool reenter');
    expect(followupBodyJson).not.toContain('client injection');
    expect((capturedFollowupMeta as any)?.clientInjectSource).toBe('servertool.review');
    expect((capturedFollowupMeta as any)?.__shadowCompareForcedProviderKey).toBe('glm.1-186.kimi-k2.5');
  });

  test('can disable review ai followup via ROUTECODEX_REVIEW_AI_FOLLOWUP_ENABLED=0', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-ai-gate-'));
    const markerPath = path.join(tmpDir, 'called.marker');
    const fakeBinPath = path.join(tmpDir, 'fake-codex.sh');
    fs.writeFileSync(
      fakeBinPath,
      ['#!/usr/bin/env bash', `echo called > "${markerPath}"`, 'echo "fake-ai-followup"', 'exit 0', ''].join('\n'),
      { encoding: 'utf8' }
    );
    fs.chmodSync(fakeBinPath, 0o755);

    const prevStopEnabled = process.env.ROUTECODEX_STOPMESSAGE_AI_FOLLOWUP_ENABLED;
    const prevBackend = process.env.ROUTECODEX_STOPMESSAGE_AI_FOLLOWUP_BACKEND;
    const prevCodexBin = process.env.ROUTECODEX_STOPMESSAGE_AI_FOLLOWUP_CODEX_BIN;
    const prevReviewEnabled = process.env.ROUTECODEX_REVIEW_AI_FOLLOWUP_ENABLED;
    process.env.ROUTECODEX_REVIEW_AI_FOLLOWUP_ENABLED = '0';
    process.env.ROUTECODEX_STOPMESSAGE_AI_FOLLOWUP_ENABLED = '1';
    process.env.ROUTECODEX_STOPMESSAGE_AI_FOLLOWUP_BACKEND = 'codex';
    process.env.ROUTECODEX_STOPMESSAGE_AI_FOLLOWUP_CODEX_BIN = fakeBinPath;
    try {
      const adapterContext: AdapterContext = {
        requestId: 'req-review-no-ai-default',
        entryEndpoint: '/v1/messages',
        providerProtocol: 'anthropic-messages',
        providerKey: 'glm.1-186.kimi-k2.5',
        stream: false,
        sessionId: 'session-review-no-ai-default',
        metadata: {
          workdir: '/tmp/review-workdir'
        },
        capturedChatRequest: {
          model: 'kimi-k2.5',
          messages: [{ role: 'user', content: '请继续实现并自查。' }]
        }
      } as any;

      let capturedFollowupMeta: Record<string, unknown> | null = null;
      let capturedFollowupBody: JsonObject | undefined;
      const orchestration = await runServerToolOrchestration({
        chat: buildReviewToolCallPayload(),
        adapterContext,
        requestId: 'req-review-no-ai-default',
        entryEndpoint: '/v1/messages',
        providerProtocol: 'anthropic-messages',
        reenterPipeline: async (opts: any) => {
          capturedFollowupMeta =
            opts?.metadata && typeof opts.metadata === 'object'
              ? (opts.metadata as Record<string, unknown>)
              : null;
          capturedFollowupBody = opts?.body as JsonObject | undefined;
          return { body: { id: 'ok' } as JsonObject } as any;
        }
      });

      expect(orchestration.executed).toBe(true);
      expect(orchestration.flowId).toBe('review_flow');
      expect(fs.existsSync(markerPath)).toBe(false);
      const followupText = flattenMessageText(capturedFollowupBody);
      expect(followupText).toContain('严格代码 review');
      expect(followupText).toContain(
        '必须先根据本次请求逐条核验代码'
      );
    } finally {
      if (prevStopEnabled === undefined) delete process.env.ROUTECODEX_STOPMESSAGE_AI_FOLLOWUP_ENABLED;
      else process.env.ROUTECODEX_STOPMESSAGE_AI_FOLLOWUP_ENABLED = prevStopEnabled;
      if (prevBackend === undefined) delete process.env.ROUTECODEX_STOPMESSAGE_AI_FOLLOWUP_BACKEND;
      else process.env.ROUTECODEX_STOPMESSAGE_AI_FOLLOWUP_BACKEND = prevBackend;
      if (prevCodexBin === undefined) delete process.env.ROUTECODEX_STOPMESSAGE_AI_FOLLOWUP_CODEX_BIN;
      else process.env.ROUTECODEX_STOPMESSAGE_AI_FOLLOWUP_CODEX_BIN = prevCodexBin;
      if (prevReviewEnabled === undefined) delete process.env.ROUTECODEX_REVIEW_AI_FOLLOWUP_ENABLED;
      else process.env.ROUTECODEX_REVIEW_AI_FOLLOWUP_ENABLED = prevReviewEnabled;
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // best effort cleanup
      }
    }
  });

  test('invokes ai followup command for review flow when enabled', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-ai-on-'));
    const markerPath = path.join(tmpDir, 'called.marker');
    const fakeBinPath = path.join(tmpDir, 'fake-codex.sh');
    fs.writeFileSync(
      fakeBinPath,
      [
        '#!/usr/bin/env bash',
        `echo called > "${markerPath}"`,
        'sleep 0.2',
        'echo "下一步：先补一个最小回归测试再继续实现。"',
        'exit 0',
        ''
      ].join('\n'),
      { encoding: 'utf8' }
    );
    fs.chmodSync(fakeBinPath, 0o755);

    const prevStopEnabled = process.env.ROUTECODEX_STOPMESSAGE_AI_FOLLOWUP_ENABLED;
    const prevBackend = process.env.ROUTECODEX_STOPMESSAGE_AI_FOLLOWUP_BACKEND;
    const prevCodexBin = process.env.ROUTECODEX_STOPMESSAGE_AI_FOLLOWUP_CODEX_BIN;
    const prevReviewEnabled = process.env.ROUTECODEX_REVIEW_AI_FOLLOWUP_ENABLED;
    process.env.ROUTECODEX_REVIEW_AI_FOLLOWUP_ENABLED = '1';
    process.env.ROUTECODEX_STOPMESSAGE_AI_FOLLOWUP_ENABLED = '1';
    process.env.ROUTECODEX_STOPMESSAGE_AI_FOLLOWUP_BACKEND = 'codex';
    process.env.ROUTECODEX_STOPMESSAGE_AI_FOLLOWUP_CODEX_BIN = fakeBinPath;
    try {
      const adapterContext: AdapterContext = {
        requestId: 'req-review-ai-enabled',
        entryEndpoint: '/v1/messages',
        providerProtocol: 'anthropic-messages',
        providerKey: 'glm.1-186.kimi-k2.5',
        stream: false,
        sessionId: 'session-review-ai-enabled',
        metadata: {
          workdir: tmpDir
        },
        capturedChatRequest: {
          model: 'kimi-k2.5',
          messages: [{ role: 'user', content: '请继续实现并自查。' }]
        }
      } as any;

      let capturedFollowupMeta: Record<string, unknown> | null = null;
      let capturedFollowupBody: JsonObject | undefined;
      let timerTicked = false;
      const timer = setTimeout(() => {
        timerTicked = true;
      }, 30);
      const orchestration = await runServerToolOrchestration({
        chat: buildReviewToolCallPayload(),
        adapterContext,
        requestId: 'req-review-ai-enabled',
        entryEndpoint: '/v1/messages',
        providerProtocol: 'anthropic-messages',
        reenterPipeline: async (opts: any) => {
          capturedFollowupMeta =
            opts?.metadata && typeof opts.metadata === 'object'
              ? (opts.metadata as Record<string, unknown>)
              : null;
          capturedFollowupBody = opts?.body as JsonObject | undefined;
          return { body: { id: 'ok' } as JsonObject } as any;
        }
      });
      clearTimeout(timer);

      expect(orchestration.executed).toBe(true);
      expect(orchestration.flowId).toBe('review_flow');
      expect(timerTicked).toBe(true);
      expect(fs.existsSync(markerPath)).toBe(true);
      expect(flattenMessageText(capturedFollowupBody)).toContain('下一步：先补一个最小回归测试再继续实现');
    } finally {
      if (prevStopEnabled === undefined) delete process.env.ROUTECODEX_STOPMESSAGE_AI_FOLLOWUP_ENABLED;
      else process.env.ROUTECODEX_STOPMESSAGE_AI_FOLLOWUP_ENABLED = prevStopEnabled;
      if (prevBackend === undefined) delete process.env.ROUTECODEX_STOPMESSAGE_AI_FOLLOWUP_BACKEND;
      else process.env.ROUTECODEX_STOPMESSAGE_AI_FOLLOWUP_BACKEND = prevBackend;
      if (prevCodexBin === undefined) delete process.env.ROUTECODEX_STOPMESSAGE_AI_FOLLOWUP_CODEX_BIN;
      else process.env.ROUTECODEX_STOPMESSAGE_AI_FOLLOWUP_CODEX_BIN = prevCodexBin;
      if (prevReviewEnabled === undefined) delete process.env.ROUTECODEX_REVIEW_AI_FOLLOWUP_ENABLED;
      else process.env.ROUTECODEX_REVIEW_AI_FOLLOWUP_ENABLED = prevReviewEnabled;
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // best effort cleanup
      }
    }
  });

  test('prefers cwd passed in review tool arguments', async () => {
    process.env.ROUTECODEX_STOPMESSAGE_AI_FOLLOWUP_ENABLED = '0';

    const adapterContext: AdapterContext = {
      requestId: 'req-review-args-cwd',
      entryEndpoint: '/v1/messages',
      providerProtocol: 'anthropic-messages',
      providerKey: 'glm.1-186.kimi-k2.5',
      stream: false,
      sessionId: 'session-review-args-cwd',
      metadata: {},
      capturedChatRequest: {
        model: 'kimi-k2.5',
        messages: [{ role: 'user', content: '请继续实现并自查。' }]
      }
    } as any;

    let capturedFollowupMeta: Record<string, unknown> | null = null;
    const orchestration = await runServerToolOrchestration({
      chat: buildReviewToolCallPayload({ cwd: '/tmp/review-args-cwd' }),
      adapterContext,
      requestId: 'req-review-args-cwd',
      entryEndpoint: '/v1/messages',
      providerProtocol: 'anthropic-messages',
      reenterPipeline: async (opts: any) => {
        capturedFollowupMeta =
          opts?.metadata && typeof opts.metadata === 'object'
            ? (opts.metadata as Record<string, unknown>)
            : null;
        return { body: { id: 'ok' } as JsonObject } as any;
      }
    });

    expect(orchestration.executed).toBe(true);
    expect(orchestration.flowId).toBe('review_flow');
    expect(capturedFollowupMeta).toBeTruthy();
    expect((capturedFollowupMeta as any)?.workdir).toBe('/tmp/review-args-cwd');
    expect((capturedFollowupMeta as any)?.cwd).toBe('/tmp/review-args-cwd');
  });

  test('strips stopMessage markers, time tags, and image placeholders from review followup text', async () => {
    process.env.ROUTECODEX_STOPMESSAGE_AI_FOLLOWUP_ENABLED = '0';

    const adapterContext: AdapterContext = {
      requestId: 'req-review-sanitize',
      entryEndpoint: '/v1/messages',
      providerProtocol: 'anthropic-messages',
      providerKey: 'glm.1-186.kimi-k2.5',
      stream: false,
      sessionId: 'session-review-sanitize',
      metadata: {},
      capturedChatRequest: {
        model: 'kimi-k2.5',
        messages: [
          {
            role: 'user',
            content:
              '<**stopMessage:"继续推进",3**>\n[Time/Date]: utc=`2026-03-10T11:23:29.255Z` local=`2026-03-10 19:23:29.255 +08:00` tz=`Asia/Shanghai` nowMs=`1773141809255` ntpOffsetMs=`40`\n[Image omitted]\n请继续实现并自查。'
          }
        ]
      }
    } as any;

    let capturedFollowupMeta: Record<string, unknown> | null = null;
    let capturedFollowupBody: JsonObject | undefined;
    const orchestration = await runServerToolOrchestration({
      chat: buildReviewToolCallPayload({
        goal:
          '<**stopMessage:"继续推进",3**>\n[Time/Date]: utc=`2026-03-10T11:23:29.255Z` local=`2026-03-10 19:23:29.255 +08:00` tz=`Asia/Shanghai` nowMs=`1773141809255` ntpOffsetMs=`40`\n[Image omitted]\n检查是否真正完成目标'
      }),
      adapterContext,
      requestId: 'req-review-sanitize',
      entryEndpoint: '/v1/messages',
      providerProtocol: 'anthropic-messages',
      reenterPipeline: async (opts: any) => {
        capturedFollowupMeta =
          opts?.metadata && typeof opts.metadata === 'object'
            ? (opts.metadata as Record<string, unknown>)
            : null;
        capturedFollowupBody = opts?.body as JsonObject | undefined;
        return { body: { id: 'ok' } as JsonObject } as any;
      }
    });

    expect(orchestration.executed).toBe(true);
    const followupText = readLastMessageText(capturedFollowupBody);
    expect(followupText).toContain('代码 review');
    expect(followupText).not.toContain('<**stopMessage');
    expect(followupText).not.toContain('[Time/Date]:');
    expect(followupText).not.toContain('[Image omitted]');
  });

  test('heartbeat handoff wording still preserves review followup source and uses reenter', async () => {
    process.env.ROUTECODEX_STOPMESSAGE_AI_FOLLOWUP_ENABLED = '0';

    const adapterContext: AdapterContext = {
      requestId: 'req-review-heartbeat',
      entryEndpoint: '/v1/messages',
      providerProtocol: 'anthropic-messages',
      providerKey: 'glm.1-186.kimi-k2.5',
      stream: false,
      sessionId: 'session-review-heartbeat',
      metadata: {
        workdir: '/tmp/review-heartbeat'
      },
      capturedChatRequest: {
        model: 'kimi-k2.5',
        messages: [{ role: 'user', content: '读取 HEARTBEAT.md，更新 DELIVERY.md，然后调用 review。' }]
      }
    } as any;

    let capturedFollowupMeta: Record<string, unknown> | null = null;
    const orchestration = await runServerToolOrchestration({
      chat: buildReviewToolCallPayload({
        goal: '读取 HEARTBEAT.md 并检查 DELIVERY.md 是否完整'
      }),
      adapterContext,
      requestId: 'req-review-heartbeat',
      entryEndpoint: '/v1/messages',
      providerProtocol: 'anthropic-messages',
      reenterPipeline: async (opts: any) => {
        capturedFollowupMeta =
          opts?.metadata && typeof opts.metadata === 'object'
            ? (opts.metadata as Record<string, unknown>)
            : null;
        return { body: { id: 'ok' } as JsonObject } as any;
      }
    });

    expect(orchestration.executed).toBe(true);
    expect(orchestration.flowId).toBe('review_flow');
    expect((capturedFollowupMeta as any)?.clientInjectOnly).toBeUndefined();
    expect((capturedFollowupMeta as any)?.clientInjectSource).toBe('servertool.review');
  });
});
