import {
  buildClientExecCliProjectionOutputWithNative,
  buildClientVisibleProjectionShellWithNative
} from '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-servertool-core-semantics.js';

describe('servertool CLI native bridge', () => {
  it('uses Rust-owned projection output and client-visible shell', () => {
    const nativeProjection = buildClientExecCliProjectionOutputWithNative({
      flowId: 'stop_message_flow',
      input: {
        continuationPrompt: '继续执行原任务',
        repeatCount: 1,
        maxRepeats: 3
      },
      stdoutPreview: 'continue'
    });

    expect(nativeProjection).toMatchObject({
      toolName: 'stop_message_auto',
      flowId: 'stop_message_flow',
      repeatCount: 1,
      maxRepeats: 3
    });
    expect(nativeProjection.execCommand).toContain('routecodex servertool run stop_message_auto');
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
});
