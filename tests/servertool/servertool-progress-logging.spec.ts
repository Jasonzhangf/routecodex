import { jest } from '@jest/globals';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { runServerToolOrchestration } from '../../sharedmodule/llmswitch-core/src/servertool/engine.js';
import type { AdapterContext } from '../../sharedmodule/llmswitch-core/src/conversion/hub/types/chat-envelope.js';
import type { JsonObject } from '../../sharedmodule/llmswitch-core/src/conversion/hub/types/json.js';
import { serializeRoutingInstructionState, type RoutingInstructionState } from '../../sharedmodule/llmswitch-core/src/router/virtual-router/routing-instructions.js';

describe('servertool progress logging', () => {
  test('prints yellow progress steps when a servertool followup executes', async () => {
    const SESSION_DIR = path.join(process.cwd(), 'tmp', 'jest-progress-sessions');
    const ORIGINAL = process.env.ROUTECODEX_SESSION_DIR;
    process.env.ROUTECODEX_SESSION_DIR = SESSION_DIR;
    const sessionId = 'sess-progress-1';
    fs.mkdirSync(SESSION_DIR, { recursive: true });
    const filepath = path.join(SESSION_DIR, `session-${sessionId}.json`);
    const state: RoutingInstructionState = {
      forcedTarget: undefined,
      stickyTarget: undefined,
      allowedProviders: new Set(),
      disabledProviders: new Set(),
      disabledKeys: new Map(),
      disabledModels: new Map(),
      stopMessageText: '继续',
      stopMessageMaxRepeats: 10,
      stopMessageUsed: 0,
      stopMessageUpdatedAt: Date.now()
    };
    fs.writeFileSync(filepath, JSON.stringify({ version: 1, state: serializeRoutingInstructionState(state) }), { encoding: 'utf8' });

    const spy = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const adapterContext: AdapterContext = {
        requestId: 'req-progress-1',
        entryEndpoint: '/v1/responses',
        providerProtocol: 'openai-responses',
        sessionId,
        capturedChatRequest: {
          model: 'gpt-test',
          messages: [{ role: 'user', content: 'hi' }]
        }
      } as any;

      const responsesPayload: JsonObject = {
        id: 'resp-progress-1',
        object: 'response',
        model: 'gpt-test',
        status: 'completed',
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }]
      };

      await runServerToolOrchestration({
        chat: responsesPayload,
        adapterContext,
        requestId: 'req-progress-1',
        entryEndpoint: '/v1/responses',
        providerProtocol: 'openai-responses',
        reenterPipeline: async () => {
          return {
            body: {
              id: 'resp-progress-followup-1',
              object: 'response',
              model: 'gpt-test',
              status: 'completed',
              output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] }]
            } as JsonObject
          };
        }
      });

      const lines = spy.mock.calls.map((c) => String(c[0] ?? ''));
      // 38;5;214 = bright yellow/orange used in other logs (e.g. stopMessage tag)
      expect(lines.some((l) => l.includes('\u001b[38;5;214m[servertool][progress 1/5]'))).toBe(true);
      expect(lines.some((l) => l.includes('[servertool][progress 5/5]'))).toBe(true);
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
});
