import { describe, it, expect } from '@jest/globals';
import { ResponseToolArgumentsToonDecodeFilter } from '../../sharedmodule/llmswitch-core/src/filters/special/response-tool-arguments-toon-decode.js';
import type { FilterContext } from '../../sharedmodule/llmswitch-core/src/filters/types.js';

const buildContext = (overrides?: Partial<FilterContext>): FilterContext => ({
  requestId: 'req_test',
  model: 'gpt-test',
  endpoint: '/v1/chat/completions',
  provider: 'openai',
  profile: 'openai-chat',
  stage: 'response_pre',
  debug: { emit: () => {} },
  ...overrides
});

describe('ResponseToolArgumentsToonDecodeFilter', () => {
  const filter = new ResponseToolArgumentsToonDecodeFilter();

  it('decodes exec_command toon arguments into cmd/workdir shape', () => {
    const payload = {
      choices: [
        {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_exec_toon',
                type: 'function',
                function: {
                  name: 'exec_command',
                  arguments: JSON.stringify({
                    toon: 'command: ls -la\nworkdir: /tmp'
                  })
                }
              }
            ]
          }
        }
      ]
    };

    const result = filter.apply(payload as any, buildContext());
    expect(result.ok).toBe(true);

    const out = result.data as any;
    const choices = Array.isArray(out.choices) ? out.choices : [];
    expect(choices.length).toBeGreaterThan(0);

    const msg = choices[0].message || {};
    const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
    expect(toolCalls.length).toBe(1);

    const fn = toolCalls[0].function;
    expect(typeof fn.arguments).toBe('string');
    const args = JSON.parse(fn.arguments);

    expect(args.cmd).toBe('ls -la');
    expect(args.command).toBe('ls -la');
    expect(args.workdir).toBe('/tmp');
  });

  it('emits warning and keeps original arguments when TOON cannot be decoded', () => {
    const debugEvents: Array<{ event: string; data: unknown }> = [];
    const ctx = buildContext({
      debug: {
        emit: (event: string, data: unknown) => {
          debugEvents.push({ event, data });
        }
      }
    });

    const originalArguments = JSON.stringify({
      toon: 'this is not a key/value TOON payload'
    });

    const payload = {
      choices: [
        {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_bad_toon',
                type: 'function',
                function: {
                  name: 'exec_command',
                  arguments: originalArguments
                }
              }
            ]
          }
        }
      ]
    };

    const result = filter.apply(payload as any, ctx);
    expect(result.ok).toBe(true);

    const out = result.data as any;
    const choices = Array.isArray(out.choices) ? out.choices : [];
    expect(choices.length).toBeGreaterThan(0);

    const msg = choices[0].message || {};
    const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
    expect(toolCalls.length).toBe(1);

    const fn = toolCalls[0].function;
    expect(fn.arguments).toBe(originalArguments);

    const toonErrors = debugEvents.filter((e) => e.event === 'tool_toon_decode_error');
    expect(toonErrors.length).toBeGreaterThanOrEqual(1);
  });

  it('decodes generic toon arguments for non-shell tools (e.g., view_image)', () => {
    const payload = {
      choices: [
        {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_view_image',
                type: 'function',
                function: {
                  name: 'view_image',
                  arguments: JSON.stringify({
                    toon: 'path: images/example.png'
                  })
                }
              }
            ]
          }
        }
      ]
    };

    const result = filter.apply(payload as any, buildContext());
    expect(result.ok).toBe(true);

    const out = result.data as any;
    const choices = Array.isArray(out.choices) ? out.choices : [];
    expect(choices.length).toBeGreaterThan(0);

    const msg = choices[0].message || {};
    const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
    expect(toolCalls.length).toBe(1);

    const fn = toolCalls[0].function;
    expect(typeof fn.arguments).toBe('string');

    const args = JSON.parse(fn.arguments);
    expect(args.path).toBe('images/example.png');
  });
});
