import { jest } from '@jest/globals';

const normalizeApplyPatchArgs = (rawArgs: unknown): string => {
  if (typeof rawArgs === 'string') {
    if (rawArgs.includes('*** Begin Patch')) {
      return JSON.stringify({ patch: rawArgs, input: rawArgs });
    }
    if (rawArgs.includes("apply_patch <<'PATCH'")) {
      const match = rawArgs.match(/(\*\*\* Begin Patch[\s\S]*\*\*\* End Patch)/);
      const patch = match?.[1] ?? rawArgs;
      return JSON.stringify({ patch, input: patch });
    }
    try {
      return normalizeApplyPatchArgs(JSON.parse(rawArgs));
    } catch {
      return rawArgs;
    }
  }
  if (!rawArgs || typeof rawArgs !== 'object' || Array.isArray(rawArgs)) {
    return JSON.stringify({ patch: '', input: '' });
  }
  const row = rawArgs as Record<string, unknown>;
  const patch = typeof row.patch === 'string' ? row.patch : typeof row.input === 'string' ? row.input : '';
  return JSON.stringify({ ...row, patch, input: patch });
};

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/router/virtual-router/engine-selection/native-chat-process-governance-semantics.js',
  () => ({
    normalizeApplyPatchArgumentsWithNative: jest.fn((rawArgs: unknown) => ({
      normalizedArguments: normalizeApplyPatchArgs(rawArgs),
      repaired: true
    })),
    prepareRespProcessToolGovernancePayloadWithNative: jest.fn((payload: Record<string, unknown>) => ({
      preparedPayload: payload,
      summary: { converted: false, shapeSanitized: false, harvestedToolCalls: 0 }
    })),
    applyRespProcessToolGovernanceWithNative: jest.fn((input: { payload: any }) => {
      const payload = JSON.parse(JSON.stringify(input.payload));
      const choices = Array.isArray(payload?.choices) ? payload.choices : [];
      for (const choice of choices) {
        const message = choice?.message;
        const toolCalls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
        for (const toolCall of toolCalls) {
          if (toolCall?.function?.name === 'apply_patch') {
            toolCall.function.arguments = normalizeApplyPatchArgs(toolCall.function.arguments);
          }
        }
      }
      return {
        governedPayload: payload,
        summary: { applied: true, toolCallsNormalized: 0, applyPatchRepaired: 0 }
      };
    }),
    validateApplyPatchArgumentsWithNative: jest.fn()
  })
);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/router/virtual-router/engine-selection/native-shared-conversion-semantics.js',
  () => ({
    parseLenientJsonishWithNative: jest.fn((value: string) => {
      try {
        return JSON.parse(value);
      } catch {
        return {};
      }
    }),
    repairArgumentsToStringWithNative: jest.fn((value: unknown) =>
      typeof value === 'string' ? value : JSON.stringify(value ?? {})
    ),
    readRuntimeMetadataWithNative: jest.fn(() => undefined),
    ensureRuntimeMetadataCarrierWithNative: jest.fn((value: unknown) => value),
    cloneRuntimeMetadataWithNative: jest.fn(() => undefined),
    chunkStringWithNative: jest.fn((value: string) => [value]),
    deriveToolCallKeyWithNative: jest.fn((value: unknown) => String(value ?? '')),
    flattenByCommaWithNative: jest.fn((value: string[]) => value.join(',')),
    packShellArgsWithNative: jest.fn((value: string[]) => value.join(' ')),
    repairFindMetaWithNative: jest.fn((value: unknown) => value),
    splitCommandStringWithNative: jest.fn((value: string) => value.split(/\s+/).filter(Boolean))
  })
);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/conversion/runtime-metadata.js',
  () => ({
    readRuntimeMetadata: jest.fn(() => undefined),
    ensureRuntimeMetadata: jest.fn(() => ({})),
    cloneRuntimeMetadata: jest.fn(() => undefined)
  })
);

const {
  normalizeApplyPatchToolCallsOnRequest,
  processChatResponseTools
} = await import('../../sharedmodule/llmswitch-core/src/conversion/shared/tool-governor.js');
const { processChatRequestTools } = await import(
  '../../sharedmodule/llmswitch-core/src/conversion/shared/tool-governor-request.js'
);

describe('tool governor apply_patch canonicalization', () => {
  const patchText = [
    '*** Begin Patch',
    '*** Update File: apps/host_console/lib/main.dart',
    '@@',
    '-void main() {}',
    '+void main() { runApp(const SizedBox()); }',
    '*** End Patch'
  ].join('\n');

  it('does not rewrite response exec_command(apply_patch ...) into a second tool name', () => {
    const response: any = {
      choices: [
        {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: {
                  name: 'exec_command',
                  arguments: JSON.stringify({
                    command: ['apply_patch', patchText],
                    workdir: '/tmp/project'
                  })
                }
              }
            ]
          },
          finish_reason: 'tool_calls'
        }
      ]
    };

    const out: any = processChatResponseTools(response as any);
    const fn = out.choices?.[0]?.message?.tool_calls?.[0]?.function;
    expect(fn?.name).toBe('exec_command');

    expect(typeof fn?.arguments).toBe('string');
  });

  it('does not rewrite request history exec_command(apply_patch ...) or inject TS policy messages', () => {
    const request: any = {
      messages: [
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_2',
              type: 'function',
              function: {
                name: 'exec_command',
                arguments: JSON.stringify({ command: ['apply_patch', patchText] })
              }
            }
          ]
        }
      ]
    };

    const out: any = normalizeApplyPatchToolCallsOnRequest(request as any);
    const fn = out.messages?.[0]?.tool_calls?.[0]?.function;
    expect(fn?.name).toBe('exec_command');

    expect(typeof fn?.arguments).toBe('string');

    const policyMessage = out.messages?.find(
      (entry: any) => entry?.role === 'system' && String(entry?.content || '').includes('[Codex NestedApplyPatch Policy]')
    );
    expect(policyMessage).toBeFalsy();
  });

  it('normalizes request-side apply_patch args through Rust canonical contract', () => {
    const request: any = {
      messages: [
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_bad_req',
              type: 'function',
              function: {
                name: 'apply_patch',
                arguments: JSON.stringify({ patch: patchText })
              }
            }
          ]
        }
      ]
    };

    const out: any = normalizeApplyPatchToolCallsOnRequest(request);
    const fn = out.messages?.[0]?.tool_calls?.[0]?.function;
    expect(fn?.name).toBe('apply_patch');
    const args = JSON.parse(String(fn?.arguments || '{}')) as Record<string, unknown>;
    expect(String(args.patch || '')).toContain('*** Begin Patch');
    expect(args.patch).toBe(args.input);
  });

  it('normalizes request-side apply_patch args through the real chat-process request entry', () => {
    const request: any = {
      messages: [
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_bad_req_real_entry',
              type: 'function',
              function: {
                name: 'apply_patch',
                arguments: JSON.stringify({ patch: patchText })
              }
            }
          ]
        }
      ]
    };

    const out: any = processChatRequestTools(request);
    const fn = out.messages?.[0]?.tool_calls?.[0]?.function;
    expect(fn?.name).toBe('apply_patch');
    const args = JSON.parse(String(fn?.arguments || '{}')) as Record<string, unknown>;
    expect(String(args.patch || '')).toContain('*** Begin Patch');
    expect(args.patch).toBe(args.input);
  });

  it('normalizes response-side apply_patch args through Rust canonical contract', () => {
    const response: any = {
      choices: [
        {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_bad_resp',
                type: 'function',
                function: {
                  name: 'apply_patch',
                  arguments: JSON.stringify({ patch: patchText })
                }
              }
            ]
          },
          finish_reason: 'tool_calls'
        }
      ]
    };

    const out: any = processChatResponseTools(response);
    const fn = out.choices?.[0]?.message?.tool_calls?.[0]?.function;
    const args = JSON.parse(String(fn?.arguments || '{}')) as Record<string, unknown>;
    expect(String(args.patch || '')).toContain('*** Begin Patch');
    expect(args.patch).toBe(args.input);
  });

  it('repairs response-side shell-wrapped apply_patch heredoc into canonical patch payload', () => {
    const response: any = {
      choices: [
        {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_bad_shell',
                type: 'function',
                function: {
                  name: 'apply_patch',
                  arguments: `bash -lc "echo hi && apply_patch <<'PATCH'
*** Begin Patch
*** Add File: src/nope.ts
+console.log('nope');
*** End Patch
PATCH"`
                }
              }
            ]
          },
          finish_reason: 'tool_calls'
        }
      ]
    };

    const out: any = processChatResponseTools(response);
    const fn = out.choices?.[0]?.message?.tool_calls?.[0]?.function;
    const args = JSON.parse(String(fn?.arguments || '{}')) as Record<string, unknown>;
    expect(String(args.patch || '')).toContain('*** Begin Patch');
    expect(String(args.patch || '')).toContain('*** Add File: src/nope.ts');
    expect(String(args.patch || '')).toContain("+console.log('nope');");
    expect(args.input).toBe(args.patch);
  });

  it('keeps canonical response-side patch when stray filePath is present', () => {
    const response: any = {
      choices: [
        {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_stray_filepath_resp',
                type: 'function',
                function: {
                  name: 'apply_patch',
                  arguments: JSON.stringify({
                    filePath: 'test_apply_patch/sample.txt',
                    input: '*** Begin Patch\n*** Update File: test_apply_patch/sample.txt\n@@ -1,3 +1,3 @@\n Original line 1\n-Original line 2\n+Modified line 2: UPDATED!\n Original line 3\n*** End Patch',
                    patch: '*** Begin Patch\n*** Update File: test_apply_patch/sample.txt\n@@ -1,3 +1,3 @@\n Original line 1\n-Original line 2\n+Modified line 2: UPDATED!\n Original line 3\n*** End Patch'
                  })
                }
              }
            ]
          },
          finish_reason: 'tool_calls'
        }
      ]
    };

    const out: any = processChatResponseTools(response);
    const fn = out.choices?.[0]?.message?.tool_calls?.[0]?.function;
    const args = JSON.parse(String(fn?.arguments || '{}')) as Record<string, unknown>;
    expect(String(args.patch || '')).toContain('*** Begin Patch');
    expect(String(args.patch || '')).toContain('*** Update File: test_apply_patch/sample.txt');
    expect(args.input).toBe(args.patch);
  });
});
