import { normalizeAssistantTextToToolCalls } from '../../sharedmodule/llmswitch-core/src/conversion/shared/text-markup-normalizer.js';
import { canonicalizeChatResponseTools } from '../../sharedmodule/llmswitch-core/src/conversion/shared/tool-canonicalizer.js';

describe('text-markup-normalizer (tool text → tool_calls)', () => {
  it('converts <list_directory> XML block into list_directory tool_calls and clears content', () => {
    const message = {
      role: 'assistant',
      content: `
        I'll help you list the local files.

        <list_directory>
          <path>/Users/fanzhang/Documents/github/routecodex</path>
          <recursive>false</recursive>
        </list_directory>
      `
    };

    const normalized = normalizeAssistantTextToToolCalls(message);
    expect(normalized).toBeDefined();

    const toolCalls = Array.isArray((normalized as any).tool_calls)
      ? (normalized as any).tool_calls
      : [];
    expect(toolCalls.length).toBeGreaterThanOrEqual(1);

    const tc = toolCalls[0];
    expect(tc.type).toBe('function');
    expect(tc.function).toBeDefined();
    expect(typeof tc.function.name).toBe('string');
    expect(tc.function.name).toBe('list_directory');
    expect(typeof tc.function.arguments).toBe('string');

    const args = JSON.parse(tc.function.arguments);
    expect(args.path).toBe('/Users/fanzhang/Documents/github/routecodex');
    expect(args.recursive).toBe(false);

    // 文本被收割为工具调用后，content 应被清空，避免残留 XML 垃圾
    expect((normalized as any).content).toBe('');

    // 将 message 包装成 Chat completion 形状，验证 canonicalizer + finish_reason 约束
    const chatLike = {
      id: 'test-list-directory',
      object: 'chat.completion',
      choices: [
        {
          index: 0,
          message: normalized,
          finish_reason: null
        }
      ]
    };

    const canonical = canonicalizeChatResponseTools(chatLike) as any;
    const choices = Array.isArray(canonical?.choices) ? canonical.choices : [];
    expect(choices.length).toBeGreaterThan(0);

    const choice = choices[0];
    const msg = choice?.message || {};
    const tc2 = Array.isArray(msg.tool_calls) ? msg.tool_calls[0] : undefined;

    expect(choice.finish_reason).toBe('tool_calls');
    expect(tc2).toBeDefined();
    expect(tc2.function.name).toBe('list_directory');
    expect(typeof tc2.function.arguments).toBe('string');
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

  it('converts <tool:exec_command> XML blocks into exec_command tool_calls (antigravity compact variant)', () => {
    const message = {
      role: 'assistant',
      content: `
<tool:exec_command>
<command>cd /Users/fanzhang/Documents/github/cloudplayplus_stone && flutter --version</command>
<requires_approval>false</requires_approval>
</tool:exec_command>

<tool:exec_command>
<command>cd /Users/fanzhang/Documents/github/cloudplayplus_stone && flutter doctor -v</command>
<timeout_ms>120000</timeout_ms>
</tool:exec_command>
      `
    };

    const normalized = normalizeAssistantTextToToolCalls(message);
    const toolCalls = Array.isArray((normalized as any).tool_calls)
      ? (normalized as any).tool_calls
      : [];
    expect(toolCalls.length).toBeGreaterThanOrEqual(2);

    for (const tc of toolCalls.slice(0, 2)) {
      expect(tc.type).toBe('function');
      expect(tc.function?.name).toBe('exec_command');
      const args = JSON.parse(tc.function.arguments);
      const cmd = (args.cmd ?? args.command) as string;
      expect(typeof cmd).toBe('string');
      expect(cmd).toContain('cd /Users/fanzhang/Documents/github/cloudplayplus_stone');
    }

    // After harvesting, the text content must be cleared to avoid leaking the markup.
    expect((normalized as any).content).toBe('');
  });
});
