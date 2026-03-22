import '../apply-patch-fixer.js';
import { createBridgeActionState, runBridgeActionPipeline } from '../../../bridge-actions.js';

describe('apply-patch-fixer native wrapper action', () => {
  test('normalizes inline apply_patch payload and marks repaired calls', () => {
    const state = createBridgeActionState({
      messages: [
        {
          role: 'assistant',
          tool_calls: [
            {
              type: 'function',
              function: {
                name: 'apply_patch',
                arguments: '*** Begin Patch *** Add File: src/hello.ts\nconsole.log("ok")\n*** End Patch'
              }
            }
          ]
        }
      ] as Array<Record<string, unknown>>
    });

    runBridgeActionPipeline({
      stage: 'response_inbound',
      state,
      actions: [{ name: 'compat.fix-apply-patch' }]
    });

    const toolCall = (state.messages[0] as any).tool_calls[0];
    const args = String(toolCall.function.arguments ?? '');
    expect(args).toContain('"patch":"*** Begin Patch\\n*** Add File: src/hello.ts\\n+console.log(\\"ok\\")\\n*** End Patch"');
    expect(toolCall._fixed_apply_patch).toBe(true);
  });

  test('leaves tool call unchanged when payload still carries unsupported git metadata', () => {
    const raw = [
      '*** Begin Patch',
      '*** Update File: src/hello.ts',
      'diff --git a/src/hello.ts b/src/hello.ts',
      '@@ -1 +1 @@',
      '-old',
      '+new',
      '*** End Patch'
    ].join('\n');

    const state = createBridgeActionState({
      messages: [
        {
          role: 'assistant',
          tool_calls: [
            {
              type: 'function',
              function: {
                name: 'apply_patch',
                arguments: raw
              }
            }
          ]
        }
      ] as Array<Record<string, unknown>>
    });

    runBridgeActionPipeline({
      stage: 'response_inbound',
      state,
      actions: [{ name: 'compat.fix-apply-patch' }]
    });

    const toolCall = (state.messages[0] as any).tool_calls[0];
    expect(toolCall.function.arguments).toBe(raw);
    expect(toolCall._fixed_apply_patch).toBeUndefined();
  });

  test('strips apply_patch command prefix before Begin Patch marker', () => {
    const state = createBridgeActionState({
      messages: [
        {
          role: 'assistant',
          tool_calls: [
            {
              type: 'function',
              function: {
                name: 'apply_patch',
                arguments:
                  'apply_patch *** Begin Patch\\n*** Update File: src/a.ts\\n@@\\n-a\\n+b\\n*** End Patch'
              }
            }
          ]
        }
      ] as Array<Record<string, unknown>>
    });

    runBridgeActionPipeline({
      stage: 'response_inbound',
      state,
      actions: [{ name: 'compat.fix-apply-patch' }]
    });

    const toolCall = (state.messages[0] as any).tool_calls[0];
    const normalized = JSON.parse(String(toolCall.function.arguments || '{}'));
    expect(String(normalized.patch || '')).toMatch(/^\*\*\* Begin Patch/);
    expect(String(normalized.patch || '')).not.toContain('apply_patch *** Begin Patch');
    expect(toolCall._fixed_apply_patch).toBe(true);
  });

  test('extracts nested result.command wrapper payload to canonical patch arguments', () => {
    const wrappedArgs = JSON.stringify({
      ok: true,
      result: {
        command:
          'apply_patch *** Begin Patch\\n*** Add File: src/zen.ts\\nconsole.log(\"zen\");\\n*** End Patch'
      }
    });

    const state = createBridgeActionState({
      messages: [
        {
          role: 'assistant',
          tool_calls: [
            {
              type: 'function',
              function: {
                name: 'apply_patch',
                arguments: wrappedArgs
              }
            }
          ]
        }
      ] as Array<Record<string, unknown>>
    });

    runBridgeActionPipeline({
      stage: 'response_inbound',
      state,
      actions: [{ name: 'compat.fix-apply-patch' }]
    });

    const toolCall = (state.messages[0] as any).tool_calls[0];
    const normalized = JSON.parse(String(toolCall.function.arguments || '{}'));
    expect(String(normalized.patch || '')).toContain('*** Add File: src/zen.ts');
    expect(String(normalized.patch || '')).toContain('+console.log("zen");');
    expect(toolCall._fixed_apply_patch).toBe(true);
  });

  test('normalizes apply_patch arguments in responses input function_call items', () => {
    const state = createBridgeActionState({
      input: [
        {
          type: 'function_call',
          name: 'apply_patch',
          arguments:
            'apply_patch *** Begin Patch\\n*** Add File: src/from-input.ts\\nconsole.log(\"input\");\\n*** End Patch'
        }
      ] as Array<Record<string, unknown>>,
      messages: [] as Array<Record<string, unknown>>
    });

    runBridgeActionPipeline({
      stage: 'response_inbound',
      state,
      actions: [{ name: 'compat.fix-apply-patch' }]
    });

    const item = (state as any).input[0];
    const normalized = JSON.parse(String(item.arguments || '{}'));
    expect(String(normalized.patch || '')).toContain('*** Add File: src/from-input.ts');
    expect(String(normalized.patch || '')).toContain('+console.log("input");');
    expect(item._fixed_apply_patch).toBe(true);
  });
});
