import {
  executeServertoolCliCommand,
  parseServertoolCliInputJson
} from '../../sharedmodule/llmswitch-core/src/servertool/cli-executor.js';

describe('servertool CLI direct execution flow', () => {
  it('executes fixture command with direct JSON input', async () => {
    await expect(executeServertoolCliCommand({
      toolName: 'servertool_fixture',
      input: { value: 1 }
    })).resolves.toMatchObject({
      ok: true,
      kind: 'fixture',
      tool: 'servertool_fixture',
      result: { value: 1 }
    });
  });

  it('executes stopless command with short summary output', async () => {
    await expect(executeServertoolCliCommand({
      toolName: 'stop_message_auto',
      input: {
        stdoutPreview: 'continue next step',
        continuationPrompt: '继续执行原任务',
        repeatCount: 2,
        maxRepeats: 3
      }
    })).resolves.toMatchObject({
      ok: true,
      kind: 'stop_message_auto',
      tool: 'stop_message_auto',
      summary: 'continue next step',
      continuationPrompt: '继续执行原任务',
      repeatCount: 2,
      maxRepeats: 3,
      injectedPromptPreview: '继续执行原任务'
    });
  });

  it('fails fast for unsupported tool', async () => {
    await expect(executeServertoolCliCommand({
      toolName: 'web_search',
      input: { query: 'x' }
    })).rejects.toThrow(/unsupported tool: web_search/);
  });

  it('parses only JSON object input', () => {
    expect(parseServertoolCliInputJson('{"ok":true}')).toEqual({ ok: true });
    expect(parseServertoolCliInputJson(undefined)).toEqual({});
    expect(() => parseServertoolCliInputJson('[]')).toThrow(/--input-json must be a JSON object/);
    expect(() => parseServertoolCliInputJson('{')).toThrow(/--input-json must be a JSON object/);
  });
});
