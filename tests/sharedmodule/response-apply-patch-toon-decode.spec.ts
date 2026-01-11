import { ResponseApplyPatchToonDecodeFilter } from '../../sharedmodule/llmswitch-core/src/filters/special/response-apply-patch-toon-decode.js';
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

describe('ResponseApplyPatchToonDecodeFilter', () => {
  const filter = new ResponseApplyPatchToonDecodeFilter();

  it('normalizes structured apply_patch payload into unified diff for client', () => {
    const payload = {
      choices: [
        {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_apply_patch_structured',
                type: 'function',
                function: {
                  name: 'apply_patch',
                  arguments: JSON.stringify({
                    file: 'src/foo.ts',
                    changes: [
                      {
                        kind: 'insert_after',
                        anchor: 'const foo = 1;',
                        lines: ['const bar = 2;']
                      }
                    ]
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

    expect(typeof args.patch).toBe('string');
    expect(args.patch).toContain('*** Begin Patch');
    expect(args.patch).toContain('*** Update File: src/foo.ts');
    expect(args.patch).toContain('+const bar = 2;');

    // 确保每个 @@ hunk 都包含至少一行有效内容，避免空 hunk 触发客户端语法错误。
    const lines: string[] = String(args.patch).split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      if (lines[i] === '@@') {
        const next = lines[i + 1] || '';
        expect(/^[ +-]/.test(next)).toBe(true);
      }
    }
  });
});

