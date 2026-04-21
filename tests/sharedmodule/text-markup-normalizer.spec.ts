import {
  extractApplyPatchCallsFromText,
  extractBareExecCommandFromText,
  extractExploredListDirectoryCallsFromText,
  extractSimpleXmlToolsFromText,
  extractToolNamespaceXmlBlocksFromText,
  normalizeAssistantTextToToolCalls
} from '../../sharedmodule/llmswitch-core/src/conversion/shared/text-markup-normalizer.js';

describe('text-markup-normalizer (tool text → tool_calls)', () => {
  it('extracts <list_directory> XML block via dedicated simple-xml extractor', () => {
    const calls = extractSimpleXmlToolsFromText(`
      I'll help you list the local files.

      <list_directory>
        <path>/Users/fanzhang/Documents/github/routecodex</path>
        <recursive>false</recursive>
      </list_directory>
    `);

    expect(Array.isArray(calls)).toBe(true);
    expect(calls?.length).toBe(1);
    expect(calls?.[0]?.name).toBe('list_directory');
    const args = JSON.parse(String(calls?.[0]?.args || '{}'));
    expect(args.path).toBe('/Users/fanzhang/Documents/github/routecodex');
    expect(args.recursive).toBe(false);
  });

  it('converts tool:exec_command markup into exec_command tool_calls', () => {
    const message = {
      role: 'assistant',
      content: `
• 我来帮你构建 APK

tool:exec_command (tool:exec_command)
  <command>cd /Users/fanzhang/Documents/github/cloudplayplus_stone && flutter --version</command>
  <requires_approval>false</requires_approval>
  <timeout_ms>10000</timeout_ms>
  </tool:exec_command>
      `
    };

    const normalized = normalizeAssistantTextToToolCalls(message);
    const toolCalls = Array.isArray((normalized as any).tool_calls)
      ? (normalized as any).tool_calls
      : [];
    expect(toolCalls.length).toBeGreaterThanOrEqual(1);

    const tc = toolCalls[0];
    expect(tc.type).toBe('function');
    expect(tc.function?.name).toBe('exec_command');
    const args = JSON.parse(tc.function.arguments);
    // exec_command should always carry a cmd/command string for transport.
    expect(typeof args.cmd === 'string' || typeof args.command === 'string').toBe(true);
    const cmd = (args.cmd ?? args.command) as string;
    expect(cmd).toContain('flutter --version');

    // After harvesting, the text content must be cleared to avoid leaking the markup.
    expect((normalized as any).content).toBe('');
  });

  it('extracts <tool:exec_command> XML blocks via dedicated namespace extractor', () => {
    const calls = extractToolNamespaceXmlBlocksFromText(`
<tool:exec_command>
<command>cd /Users/fanzhang/Documents/github/cloudplayplus_stone && flutter --version</command>
<requires_approval>false</requires_approval>
</tool:exec_command>

<tool:exec_command>
<command>cd /Users/fanzhang/Documents/github/cloudplayplus_stone && flutter doctor -v</command>
<timeout_ms>120000</timeout_ms>
</tool:exec_command>
    `);

    expect(Array.isArray(calls)).toBe(true);
    expect(calls?.length).toBeGreaterThanOrEqual(2);

    for (const tc of (calls ?? []).slice(0, 2)) {
      expect(tc.name).toBe('exec_command');
      const args = JSON.parse(String(tc.args || '{}'));
      const cmd = (args.cmd ?? args.command) as string;
      expect(typeof cmd).toBe('string');
      expect(cmd).toContain('cd /Users/fanzhang/Documents/github/cloudplayplus_stone');
    }
  });

  it('harvests JSON tool_calls text (shell_command/input.command) into exec_command tool_calls', () => {
    const message = {
      role: 'assistant',
      content: '{"tool_calls":[{"name":"shell_command","input":{"command":"bd --no-db ready"}}]}'
    };

    const normalized = normalizeAssistantTextToToolCalls(message);
    const toolCalls = Array.isArray((normalized as any).tool_calls) ? (normalized as any).tool_calls : [];
    expect(toolCalls.length).toBe(1);

    const call = toolCalls[0];
    expect(call?.function?.name).toBe('exec_command');
    const args = JSON.parse(String(call?.function?.arguments || '{}'));
    expect(args.cmd).toBe('bd --no-db ready');
    expect((normalized as any).content).toBe('');

    const sanitized = {
      ...normalized,
      tool_calls: toolCalls.map((item: any) => ({ ...item, id: '<tool_call_id>' }))
    };
    expect(sanitized).toMatchInlineSnapshot(`
{
  "content": "",
  "role": "assistant",
  "tool_calls": [
    {
      "function": {
        "arguments": "{"cmd":"bd --no-db ready"}",
        "name": "exec_command",
      },
      "id": "<tool_call_id>",
      "type": "function",
    },
  ],
}
`);
  });

  it('harvests noisy marker + trailing text wrapper around JSON tool_calls', () => {
    const message = {
      role: 'assistant',
      content: [
        '先处理一下：',
        '',
        '⏺ {"tool_calls":[{"name":"shell_command","input":{"command":"bd --no-db ready"}}]}',
        '',
        '✻ Baked for 12s'
      ].join('\n')
    };

    const normalized = normalizeAssistantTextToToolCalls(message);
    const toolCalls = Array.isArray((normalized as any).tool_calls) ? (normalized as any).tool_calls : [];
    expect(toolCalls.length).toBe(1);
    expect(toolCalls[0]?.function?.name).toBe('exec_command');
    const args = JSON.parse(String(toolCalls[0]?.function?.arguments || '{}'));
    expect(args.cmd).toBe('bd --no-db ready');
    expect((normalized as any).content).toBe('');
  });

  it('harvests JSON tool_calls embedded inside quote envelope when payload is explicit', () => {
    const message = {
      role: 'assistant',
      content: [
        '<quote>',
        '不要废话',
        '',
        '⏺ {"tool_calls":[{"name":"shell_command","input":{"command":"bd --no-db list --status in_progress"}}]}',
        '</quote>'
      ].join('\n')
    };

    const normalized = normalizeAssistantTextToToolCalls(message);
    const toolCalls = Array.isArray((normalized as any).tool_calls) ? (normalized as any).tool_calls : [];
    expect(toolCalls.length).toBe(1);
    expect(toolCalls[0]?.function?.name).toBe('exec_command');
    const args = JSON.parse(String(toolCalls[0]?.function?.arguments || '{}'));
    expect(args.cmd).toBe('bd --no-db list --status in_progress');
    expect((normalized as any).content).toBe('');
  });

  it('extracts plain Begin/End Patch transcript via dedicated apply_patch extractor', () => {
    const calls = extractApplyPatchCallsFromText(`
I need to add a backend endpoint and then execute the patch.

*** Begin Patch
*** Update File: server.js
@@ -882,6 +882,12 @@ app.delete('/tabs/:tabId', async (req, res) => {
+app.get('/tabs/:tabId/view', async (req, res) => {
+  res.send('ok');
+});
*** End Patch
    `);

    expect(Array.isArray(calls)).toBe(true);
    expect(calls?.length).toBe(1);
    const call = calls?.[0];
    expect(call?.name).toBe('apply_patch');
    const args = JSON.parse(String(call?.args || '{}'));
    const patchText = String(args.patch || args.input || '');
    expect(patchText).toContain('*** Begin Patch');
    expect(patchText).toContain('app.get(\'/tabs/:tabId/view\'');
  });

  it('extracts codex explored list transcript via dedicated list_directory extractor', () => {
    const calls = extractExploredListDirectoryCallsFromText([
        '服务已启动，API 测试通过。',
        '',
        '• Explored',
        '  └ List xiaohongshu',
        '',
        '• Explored',
        '  └ List xiaohongshu',
        '    List xiaohongshu',
        '    List app',
        '    List app',
        '',
        '› Summarize recent commits'
      ].join('\n'));

    expect(Array.isArray(calls)).toBe(true);
    expect(calls?.length).toBe(2);

    const firstArgs = JSON.parse(String(calls?.[0]?.args || '{}'));
    const secondArgs = JSON.parse(String(calls?.[1]?.args || '{}'));
    expect(calls?.[0]?.name).toBe('list_directory');
    expect(firstArgs.path).toBe('xiaohongshu');
    expect(firstArgs.recursive).toBe(false);
    expect(calls?.[1]?.name).toBe('list_directory');
    expect(secondArgs.path).toBe('app');
    expect(secondArgs.recursive).toBe(false);
  });

  it('extracts bare ran-command transcript via dedicated exec extractor', () => {
    const calls = extractBareExecCommandFromText([
        '• Ran git push origin main',
        '  └ Everything up-to-date',
        '',
        '• {"type":"blocked","summary":"服务状态异常导致 state API 测试失败","blocker":"unified-api 服务 health check 失败，core-daemon 显示 unified-api 状态为 unhealthy","impact":"无法验证新分解的 Xiaohongshu 模块与 state API 的集成","next_action":"检查 unified-api 日志 (/Users/fanzhang/.webauto/logs/unified-api.log) 定位启动失败原因","evidence":["node scripts/xiaohongshu/tests/test-state-api.mjs 返回 ECONNREFUSED","node scripts/core-daemon.mjs status 显示 unified-api 为 unhealthy"]}'
      ].join('\n'));

    expect(Array.isArray(calls)).toBe(true);
    expect(calls?.length).toBe(1);
    expect(calls?.[0]?.name).toBe('exec_command');
    const args = JSON.parse(String(calls?.[0]?.args || '{}'));
    expect(args.cmd).toBe('git push origin main');
  });
});
