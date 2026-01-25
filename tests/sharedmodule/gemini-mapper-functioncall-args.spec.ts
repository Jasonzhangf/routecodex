import { describe, it, expect } from '@jest/globals';
import { GeminiSemanticMapper } from '../../sharedmodule/llmswitch-core/src/conversion/hub/semantic-mappers/gemini-mapper.js';
import type { ChatEnvelope } from '../../sharedmodule/llmswitch-core/src/conversion/hub/types/chat-envelope.js';

describe('GeminiSemanticMapper functionCall.args shape', () => {
  it('normalizes historical tool alias execute_command -> exec_command for Gemini payload', async () => {
    const mapper = new GeminiSemanticMapper();

    const chat: ChatEnvelope = {
      messages: [
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_exec_alias',
              type: 'function',
              function: {
                name: 'execute_command',
                arguments: JSON.stringify({ command: 'echo 1', workdir: '/tmp' })
              }
            } as any
          ]
        } as any
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'exec_command',
            parameters: {
              type: 'object',
              properties: {
                cmd: { type: 'string' },
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
          providerId: 'antigravity.geetasamodgeetasamoda.gemini-3-pro-high',
          entryEndpoint: '/v1/responses',
          providerProtocol: 'gemini-chat',
          requestId: 'req_test'
        }
      } as any,
      parameters: { model: 'gemini-3-pro-high' } as any
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
    expect(functionCalls.find((fc) => fc?.name === 'execute_command')).toBeUndefined();
    expect(functionCalls.find((fc) => fc?.name === 'exec_command')).toBeDefined();
  });

  it('includes tools + structured functionCall for gemini-cli providers (no text-only tool transcripts)', async () => {
    const mapper = new GeminiSemanticMapper();

    const chat: ChatEnvelope = {
      messages: [
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_exec',
              type: 'function',
              function: {
                name: 'exec_command',
                arguments: JSON.stringify({ cmd: 'echo 1', workdir: '/tmp' })
              }
            } as any
          ]
        } as any
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
          providerId: 'gemini-cli.geetasamodgeetasamoda.gemini-2.5-pro',
          entryEndpoint: '/v1/responses',
          providerProtocol: 'gemini-chat',
          requestId: 'req_test'
        }
      } as any,
      parameters: { model: 'gemini-2.5-pro' } as any
    };

    const ctx = { requestId: 'req_test' } as any;
    const envelope = await mapper.fromChat(chat, ctx);
    const payload = envelope.payload as any;

    expect(Array.isArray(payload?.tools)).toBe(true);
    expect(Array.isArray(payload.tools?.[0]?.functionDeclarations)).toBe(true);
    const names = payload.tools[0].functionDeclarations.map((d: any) => d?.name).filter(Boolean);
    expect(names).toContain('exec_command');

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
    expect(functionCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('does not shrink Antigravity tool surface for large tool lists (tools must remain stable)', async () => {
    const mapper = new GeminiSemanticMapper();

    const manyTools: any[] = [];
    manyTools.push({
      type: 'function',
      function: {
        name: 'exec_command',
        parameters: { type: 'object', properties: { command: { type: 'string' } } }
      }
    });
    manyTools.push({
      type: 'function',
      function: {
        name: 'mcp__playwright__browser_close',
        parameters: { type: 'object', properties: {} }
      }
    });
    // Pad with dummy tools so we exceed the shrink threshold.
    for (let i = 0; i < 24; i += 1) {
      manyTools.push({
        type: 'function',
        function: {
          name: `dummy_tool_${i}`,
          parameters: { type: 'object', properties: { ok: { type: 'boolean' } } }
        }
      });
    }

    const chat: ChatEnvelope = {
      messages: [
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_exec',
              type: 'function',
              function: { name: 'exec_command', arguments: JSON.stringify({ command: 'echo 1' }) }
            } as any
          ]
        } as any
      ],
      tools: manyTools as any,
      toolOutputs: [],
      metadata: {
        context: {
          providerId: 'antigravity.geetasamodgeetasamoda.gemini-3-pro-high',
          entryEndpoint: '/v1/responses',
          providerProtocol: 'gemini-chat',
          requestId: 'req_test'
        }
      } as any,
      parameters: { model: 'gemini-3-pro-high' } as any
    };

    const ctx = { requestId: 'req_test' } as any;
    const envelope = await mapper.fromChat(chat, ctx);
    const payload = envelope.payload as any;

    const decls = payload?.tools?.[0]?.functionDeclarations ?? [];
    const names = Array.isArray(decls) ? decls.map((d: any) => d?.name).filter(Boolean) : [];
    expect(names).toContain('exec_command');
    expect(names).toContain('mcp__playwright__browser_close');
    expect(names.find((n: string) => typeof n === 'string' && n.startsWith('dummy_tool_'))).toBeTruthy();
  });

  it('keeps JSON Schema constraints (minLength, etc.) for Antigravity/Gemini tools (gcli2api style)', async () => {
    const mapper = new GeminiSemanticMapper();

    const chat: ChatEnvelope = {
      messages: [{ role: 'user', content: 'ping' } as any],
      tools: [
        {
          type: 'function',
          function: {
            name: 'list_mcp_resources',
            parameters: {
              type: 'object',
              properties: {
                server: { type: 'string', minLength: 1 },
                filter: { type: 'string' }
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
      } as any,
      parameters: { model: 'gemini-3-pro-high' } as any
    };

    const ctx = { requestId: 'req_test' } as any;
    const envelope = await mapper.fromChat(chat, ctx);
    const payload = envelope.payload as any;

    const decls = payload?.tools?.[0]?.functionDeclarations ?? [];
    const decl = Array.isArray(decls) ? decls.find((d: any) => d?.name === 'list_mcp_resources') : undefined;
    expect(decl).toBeTruthy();
    expect(decl.parameters?.properties?.server?.type).toBe('STRING');
    expect(decl.parameters?.properties?.server?.minLength).toBe(1);
  });

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
      } as any,
      parameters: { model: 'claude-sonnet-4-5' } as any
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
        // The declared schema uses instructions, but governance will also augment apply_patch
        // with patch/input aliases for compatibility.
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
      } as any,
      parameters: { model: 'gemini-3-pro-high' } as any
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
    expect(calls.call_patch_hist.args).toEqual({
      instructions: '*** Begin Patch\n*** End Patch',
      patch: '*** Begin Patch\n*** End Patch',
      input: '*** Begin Patch\n*** End Patch'
    });

    expect(calls.call_stdin_hist).toBeDefined();
    expect(calls.call_stdin_hist.args).toEqual({ chars: 'hello', session_id: 1, yield_time_ms: 50 });
  });
});
