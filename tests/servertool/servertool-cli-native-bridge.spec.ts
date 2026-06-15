import {
  buildClientExecCliProjectionOutputWithNative,
  buildClientVisibleProjectionShellWithNative
} from '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-servertool-core-semantics.js';
import { loadNativeRouterHotpathBindingForInternalUse } from '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-router-hotpath.js';

describe('servertool CLI native bridge', () => {
  it('uses Rust-owned projection output and client-visible shell', () => {
    const nativeProjection = buildClientExecCliProjectionOutputWithNative({
      flowId: 'stop_message_flow',
      input: {
        continuationPrompt: '继续执行原任务',
        repeatCount: 1,
        maxRepeats: 3
      }
    });

    expect(nativeProjection).toMatchObject({
      toolName: 'stop_message_auto',
      flowId: 'stop_message_flow',
      repeatCount: 1,
      maxRepeats: 3
    });
    expect(nativeProjection.execCommand).toContain('routecodex hook run stop_message_auto');
    expect(nativeProjection.execCommand).not.toContain('continuationPrompt');
    expect(nativeProjection.execCommand).not.toContain('继续执行原任务');
    expect(nativeProjection.execCommand).not.toContain('stdoutPreview');
    expect(nativeProjection.execCommand).not.toContain('schemaGuidance');
    expect(nativeProjection.execCommand).not.toContain(['--', 'ticket'].join(''));
    expect(nativeProjection.execCommand).not.toContain('old_cli_');

    const shell = buildClientVisibleProjectionShellWithNative({
      requestId: 'req_native_bridge',
      clientCallId: 'call_native_bridge',
      nativeProjection,
      reasoningText: '模型 stop 后需要继续执行',
      additionalToolCalls: []
    } as any);

    const toolCall = (shell as any).choices?.[0]?.message?.tool_calls?.[0];
    expect((shell as any).choices?.[0]?.finish_reason).toBe('tool_calls');
    expect(toolCall?.function?.name).toBe('exec_command');
    expect(JSON.parse(toolCall.function.arguments).cmd).toBe(nativeProjection.execCommand);
    expect((shell as any).__servertool_cli_projection).toMatchObject({
      toolName: 'stop_message_auto',
      requestId: 'req_native_bridge'
    });
    expect(JSON.stringify(shell)).not.toContain('"metadata"');
    expect(JSON.stringify(shell)).not.toContain('"__rt"');
  });

  it('keeps the raw NAPI projection shell contract as JSON string', () => {
    const binding = loadNativeRouterHotpathBindingForInternalUse() as Record<string, unknown> | null;
    const buildProjection = binding?.buildClientExecCliProjectionOutputJson;
    const buildShell = binding?.buildClientVisibleProjectionShellJson;
    expect(typeof buildProjection).toBe('function');
    expect(typeof buildShell).toBe('function');

    const rawProjection = (buildProjection as (input: string) => unknown)(JSON.stringify({
      flowId: 'stop_message_flow',
      input: {
        continuationPrompt: '继续执行原任务',
        repeatCount: 1,
        maxRepeats: 3
      }
    }));
    expect(typeof rawProjection).toBe('string');

    const rawShell = (buildShell as (input: string) => unknown)(JSON.stringify({
      requestId: 'req_native_raw_shell',
      clientCallId: 'call_native_raw_shell',
      nativeProjection: JSON.parse(rawProjection as string),
      reasoningText: '模型 stop 后需要继续执行',
      additionalToolCalls: []
    }));

    expect(typeof rawShell).toBe('string');
    expect(JSON.parse(rawShell as string).choices?.[0]?.finish_reason).toBe('tool_calls');
  });

  it.each(['web_search', 'vision_auto', 'memory_cache_auto'])(
    'rejects %s as client exec CLI projection at the Rust bridge',
    (toolName) => {
      expect(() => buildClientExecCliProjectionOutputWithNative({
        toolName,
        input: { query: 'x' }
      })).toThrow(`SERVERTOOL_UNSUPPORTED_TOOL: ${toolName}`);
    }
  );

  it('rejects additional servertool calls in the client-visible shell', () => {
    const nativeProjection = buildClientExecCliProjectionOutputWithNative({
      toolName: 'servertool_fixture',
      input: { value: 1 }
    });

    expect(() => buildClientVisibleProjectionShellWithNative({
      requestId: 'req_native_bridge_extra_tool',
      clientCallId: 'call_native_bridge_extra_tool',
      nativeProjection,
      reasoningText: 'servertool fixture',
      additionalToolCalls: [
        {
          id: 'call_web_search',
          type: 'function',
          function: {
            name: 'web_search',
            arguments: '{}'
          }
        }
      ]
    } as any)).toThrow('SERVERTOOL_UNSUPPORTED_TOOL: web_search');
  });
});
