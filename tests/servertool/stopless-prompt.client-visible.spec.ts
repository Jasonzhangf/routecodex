import { describe, expect, it } from '@jest/globals';
import { Command } from 'commander';
import fs from 'node:fs';
import path from 'node:path';

import { runServerToolOrchestration } from '../../sharedmodule/llmswitch-core/src/servertool/engine.js';
import type { AdapterContext } from '../../sharedmodule/llmswitch-core/src/conversion/hub/types/chat-envelope.js';
import type { JsonObject } from '../../sharedmodule/llmswitch-core/src/conversion/hub/types/json.js';
import {
  loadRoutingInstructionStateSync
} from '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-virtual-router-routing-state.js';
import {
  recordStoplessContinuationState
} from '../../sharedmodule/llmswitch-core/src/servertool/handlers/stop-message-auto/runtime-utils.js';
import { createServertoolCommand } from '../../src/cli/commands/servertool.js';

const FORBIDDEN_TOKENS = [
  'schema',
  'hook',
  'stopless',
  'servertool',
  'stop_message_auto',
  '第一轮',
  '第二轮',
  '第三轮',
  '必须调用',
  '必须调用可用工具',
  '必须直接调用工具',
  '必须主动调用停止 hook',
  'stop schema',
  'stop reason',
  '证据不足',
  '用户目标',
  '已排除因素',
  '排查顺序',
  'stop_reason'
];

function buildStopChatResponse(content = 'need more evidence'): JsonObject {
  return {
    id: 'chatcmpl-stopless-prompt-red',
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
    requestId: overrides.requestId ?? `req-stopless-prompt-${unique}`,
    entryEndpoint: overrides.entryEndpoint ?? '/v1/chat/completions',
    providerProtocol: overrides.providerProtocol ?? 'openai-chat',
    sessionId: overrides.sessionId ?? `session-stopless-prompt-${unique}`,
    capturedChatRequest: overrides.capturedChatRequest ?? {
      model: 'gpt-test',
      messages: [{ role: 'user', content: 'diagnose this' }]
    }
  } as any;
}

function extractInputPayload(command: string): Record<string, unknown> {
  const inputJson = command.match(/--input-json '([^']+)'(?=\s--session-id|\s--request-id|$)/)?.[1];
  return inputJson ? JSON.parse(inputJson) as Record<string, unknown> : {};
}

async function getStoplessCommand(adapterContext: AdapterContext) {
  const result = await runServerToolOrchestration({
    chat: buildStopChatResponse('需要继续推进'),
    adapterContext,
    requestId: adapterContext.requestId,
    entryEndpoint: '/v1/responses',
    providerProtocol: 'openai-responses',
    reenterPipeline: async () => {
      throw new Error('stopless CLI projection must not reenter');
    }
  });
  const toolCall = (result.chat as any).choices[0].message.tool_calls[0];
  return JSON.parse(toolCall.function.arguments).cmd as string;
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
    'servertool',
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

function isolateSessionDir(label: string): void {
  const dir = path.join(process.cwd(), '.tmp', 'jest-stopless-prompt', `${label}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  process.env.ROUTECODEX_SESSION_DIR = dir;
}

describe('stopless client-visible prompt rewrite', () => {
  it('uses first-round natural-user template without forbidden tokens', async () => {
    isolateSessionDir('first-round');
    const sessionId = `session-stopless-prompt-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const command = await getStoplessCommand(buildAdapterContext({ sessionId }));
    const payload = await runStoplessCliStdout(command);
    const prompt = String(payload.continuationPrompt ?? '');
    expect(command).toContain('routecodex hook run reasoning_stop');
    expect(command).not.toContain('stop_message_auto');
    expect(extractInputPayload(command).repeatCount).toBe(1);
    expect(payload.schemaGuidance).toBeDefined();
    expect(payload.schemaGuidance.requiredFields).toContain('stopreason');
    expect(payload.schemaGuidance.requiredFields).toContain('next_step');
    expect(prompt).toContain('继续做下一步');
    expect(prompt).not.toContain('第一轮');
    expect(prompt).not.toContain('第二轮');
    expect(prompt).not.toContain('第三轮');
    for (const token of FORBIDDEN_TOKENS) {
      expect(prompt).not.toContain(token);
    }
  });

  it('re-projects stopless command with repeatCount=2 after used=1 is persisted on the same session', async () => {
    isolateSessionDir('repeat-2');
    const sessionId = `session-stopless-prompt-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const firstRequestId = `req-stopless-prompt-${Date.now()}-1`;
    const firstCommand = await getStoplessCommand(buildAdapterContext({
      sessionId,
      requestId: firstRequestId
    }));
    recordStoplessContinuationState({
      sessionId,
      requestId: firstRequestId,
      text: '继续做下一步；先把手头能确认的结果拿回来。',
      nextUsed: 1,
      maxRepeats: 3
    });
    expect(loadRoutingInstructionStateSync(`session:${sessionId}`)?.stopMessageUsed).toBe(1);
    const secondCommand = await getStoplessCommand(buildAdapterContext({
      sessionId,
      requestId: `req-stopless-prompt-${Date.now()}-2`
    }));
    expect(extractInputPayload(firstCommand).repeatCount).toBe(1);
    expect(extractInputPayload(secondCommand).repeatCount).toBe(2);
    expect(secondCommand).toContain(`--session-id '${sessionId}'`);
  });

  it('re-projects stopless command with repeatCount=3 after used=2 is persisted on the same session', async () => {
    isolateSessionDir('repeat-3');
    const sessionId = `session-stopless-prompt-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const firstRequestId = `req-stopless-prompt-${Date.now()}-1`;
    const secondRequestId = `req-stopless-prompt-${Date.now()}-2`;
    const firstCommand = await getStoplessCommand(buildAdapterContext({
      sessionId,
      requestId: firstRequestId
    }));
    recordStoplessContinuationState({
      sessionId,
      requestId: firstRequestId,
      text: '继续做下一步；先把手头能确认的结果拿回来。',
      nextUsed: 1,
      maxRepeats: 3
    });
    const secondCommand = await getStoplessCommand(buildAdapterContext({
      sessionId,
      requestId: secondRequestId
    }));
    recordStoplessContinuationState({
      sessionId,
      requestId: secondRequestId,
      text: '继续推进；缺哪块结果就补哪块，别停在概述上。',
      nextUsed: 2,
      maxRepeats: 3
    });
    expect(loadRoutingInstructionStateSync(`session:${sessionId}`)?.stopMessageUsed).toBe(2);
    const thirdCommand = await getStoplessCommand(buildAdapterContext({
      sessionId,
      requestId: `req-stopless-prompt-${Date.now()}-3`
    }));
    expect(extractInputPayload(firstCommand).repeatCount).toBe(1);
    expect(extractInputPayload(secondCommand).repeatCount).toBe(2);
    expect(extractInputPayload(thirdCommand).repeatCount).toBe(3);
  });

  it('does not leak internal continuation prompt or schema markers in CLI command', async () => {
    isolateSessionDir('no-leak');
    const command = await getStoplessCommand(buildAdapterContext());
    expect(command).not.toContain('continuationPrompt');
    expect(command).not.toContain('schemaGuidance');
    expect(command).not.toContain('injectedPromptPreview');
    expect(command).not.toContain('stop_message_auto');
  });

  it('advances used state 0 -> 1 -> 2 -> 3 on the same session-scoped stopless flow', async () => {
    isolateSessionDir('state-advance');
    const sessionId = `session-stopless-prompt-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    for (const used of [1, 2, 3]) {
      recordStoplessContinuationState({
        sessionId,
        requestId: `req-stopless-prompt-${Date.now()}-${used}`,
        text: `step-${used}`,
        nextUsed: used,
        maxRepeats: 3
      });
      expect(loadRoutingInstructionStateSync(`session:${sessionId}`)?.stopMessageUsed).toBe(used);
    }
  });
});
