import { describe, it, expect } from '@jest/globals';
import { GeminiSemanticMapper } from '../../sharedmodule/llmswitch-core/src/conversion/hub/semantic-mappers/gemini-mapper.js';
import type { ChatEnvelope } from '../../sharedmodule/llmswitch-core/src/conversion/hub/types/chat-envelope.js';

describe('GeminiSemanticMapper functionCall.args shape', () => {
  it('ensures functionCall.args is always an object (no top-level arrays)', async () => {
    const mapper = new GeminiSemanticMapper();

    const chat: ChatEnvelope = {
      messages: [
        {
          role: 'assistant',
          content: null,
          // 两种 tool_calls：一个 arguments 为对象，一个为数组
          // 都应被映射为 functionCall.args 为对象，避免上游 Proto 报错。
          tool_calls: [
            {
              id: 'call_object',
              type: 'function',
              function: {
                name: 'exec_command',
                arguments: JSON.stringify({ cmd: 'echo 1', workdir: '/tmp' })
              }
            } as any,
            {
              id: 'call_array',
              type: 'function',
              function: {
                name: 'exec_command',
                // 顶层为数组的 arguments，在映射时应被包装为对象
                arguments: JSON.stringify([
                  { cmd: 'echo 2', workdir: '/tmp' },
                  { cmd: 'echo 3', workdir: '/tmp' }
                ])
              }
            } as any
          ]
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
                command: { type: 'string' },
                workdir: { type: 'string' }
              }
            }
          }
        } as any
      ],
      toolOutputs: [],
      metadata: {
        context: {
          providerId: 'antigravity.jasonqueque.claude-sonnet-4-5'
        }
      } as any
    };

    const ctx = { requestId: 'req_test' } as any;
    const envelope = await mapper.fromChat(chat, ctx);
    const payload = envelope.payload as any;

    const contents = Array.isArray(payload?.contents) ? payload.contents : [];
    const functionCalls: any[] = [];
    for (const entry of contents) {
      const parts = Array.isArray(entry?.parts) ? entry.parts : [];
      for (const part of parts) {
        if (part && typeof part === 'object' && part.functionCall) {
          functionCalls.push(part.functionCall);
        }
      }
    }

    // 至少包含上面两条 tool_calls 映射出来的 functionCall
    expect(functionCalls.length).toBeGreaterThanOrEqual(2);

    for (const fc of functionCalls) {
      const args = fc.args;
      expect(args).toBeDefined();
      expect(typeof args).toBe('object');
      expect(Array.isArray(args)).toBe(false);
    }

    // 针对数组 arguments 的那条，确认被包装为 { value: [...] }
    const arrayCall = functionCalls.find((fc) => fc.id === 'call_array');
    expect(arrayCall).toBeDefined();
    expect(Array.isArray(arrayCall.args.value)).toBe(true);
  });

  it('aligns historical tool_call arguments to declared tool schema keys (exec_command cmd→command, apply_patch patch→instructions, write_stdin text→chars)', async () => {
    const mapper = new GeminiSemanticMapper();

    const chat: ChatEnvelope = {
      messages: [
        // History: first tool call uses internal/canonical keys (cmd/patch/text)
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_exec_hist',
              type: 'function',
              function: {
                name: 'exec_command',
                arguments: JSON.stringify({
                  cmd: 'echo 1',
                  workdir: '/tmp',
                  yield_time_ms: 123
                })
              }
            } as any,
            {
              id: 'call_patch_hist',
              type: 'function',
              function: {
                name: 'apply_patch',
                arguments: JSON.stringify({
                  patch: '*** Begin Patch\n*** End Patch',
                  input: '*** Begin Patch\n*** End Patch'
                })
              }
            } as any,
            {
              id: 'call_stdin_hist',
              type: 'function',
              function: {
                name: 'write_stdin',
                arguments: JSON.stringify({
                  session_id: 1,
                  text: 'hello',
                  yield_time_ms: 50
                })
              }
            } as any
          ]
        },
        // A later user turn, to ensure the mapping applies across history.
        {
          role: 'user',
          content: 'continue'
        } as any
      ],
      tools: [
        // The declared schema uses command/workdir, not cmd.
        {
          type: 'function',
          function: {
            name: 'exec_command',
            parameters: {
              type: 'object',
              properties: {
                command: { type: 'string' },
                workdir: { type: 'string' }
              }
            }
          }
        } as any,
        // The declared schema uses instructions (patch text accepted as a string).
        {
          type: 'function',
          function: {
            name: 'apply_patch',
            parameters: {
              type: 'object',
              properties: {
                instructions: { type: 'string' }
              }
            }
          }
        } as any,
        // The declared schema uses chars, not text.
        {
          type: 'function',
          function: {
            name: 'write_stdin',
            parameters: {
              type: 'object',
              properties: {
                chars: { type: 'string' },
                session_id: { type: 'number' },
                yield_time_ms: { type: 'number' }
              }
            }
          }
        } as any
      ],
      toolOutputs: [],
      metadata: {
        context: {
          providerId: 'antigravity.geetasamodgeetasamoda.gemini-3-pro-high',
          entryEndpoint: '/v1/responses',
          providerProtocol: 'gemini-chat',
          requestId: 'req_test'
        }
      } as any
    };

    const ctx = { requestId: 'req_test' } as any;
    const envelope = await mapper.fromChat(chat, ctx);
    const payload = envelope.payload as any;

    const contents = Array.isArray(payload?.contents) ? payload.contents : [];
    const calls: Record<string, any> = {};
    for (const entry of contents) {
      const parts = Array.isArray(entry?.parts) ? entry.parts : [];
      for (const part of parts) {
        const fc = part?.functionCall;
        if (fc && typeof fc === 'object' && typeof fc.id === 'string') {
          calls[fc.id] = fc;
        }
      }
    }

    expect(calls.call_exec_hist).toBeDefined();
    expect(calls.call_exec_hist.args).toEqual({ command: 'echo 1', workdir: '/tmp' });

    expect(calls.call_patch_hist).toBeDefined();
    expect(calls.call_patch_hist.args).toEqual({ instructions: '*** Begin Patch\n*** End Patch' });

    expect(calls.call_stdin_hist).toBeDefined();
    expect(calls.call_stdin_hist.args).toEqual({ chars: 'hello', session_id: 1, yield_time_ms: 50 });
  });
});
