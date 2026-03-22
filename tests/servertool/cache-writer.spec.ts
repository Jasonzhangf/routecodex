import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  writeCacheEntry,
  extractAssistantTextFromResponse,
  resolveWorkingDirectoryFromAdapterContext,
} from '../../sharedmodule/llmswitch-core/src/servertool/handlers/memory/cache-writer.js';

describe('cache-writer request dedupe', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcc-cache-writer-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('only writes the first identical user request before assistant reply', () => {
    const first = writeCacheEntry({
      type: 'request',
      workingDirectory: tempDir,
      requestId: 'req-1',
      sessionId: 'sess-1',
      timestampMs: Date.now(),
      role: 'user',
      content: '继续',
      metadata: {
        model: 'gpt-test',
        providerProtocol: 'openai-responses',
      },
    });
    expect(first.ok).toBe(true);

    const second = writeCacheEntry({
      type: 'request',
      workingDirectory: tempDir,
      requestId: 'req-2',
      sessionId: 'sess-1',
      timestampMs: Date.now() + 1,
      role: 'user',
      content: '继续',
      metadata: {
        model: 'gpt-test',
        providerProtocol: 'openai-responses',
      },
    });
    expect(second.ok).toBe(true);

    const cachePath = path.join(tempDir, 'CACHE.md');
    const content = fs.readFileSync(cachePath, 'utf8');
    expect((content.match(/^### User · /gm) || []).length).toBe(1);
    expect(content).toContain('requestId: req-1');
    expect(content).not.toContain('requestId: req-2');
    expect(content).toMatch(/### User · .*?\n\n继续\n\n<!-- cache-meta/s);
  });

  it('allows the same user content after an assistant reply', () => {
    writeCacheEntry({
      type: 'request',
      workingDirectory: tempDir,
      requestId: 'req-1',
      sessionId: 'sess-1',
      timestampMs: Date.now(),
      role: 'user',
      content: '继续',
      metadata: {
        model: 'gpt-test',
        providerProtocol: 'openai-responses',
      },
    });

    writeCacheEntry({
      type: 'response',
      workingDirectory: tempDir,
      requestId: 'resp-1',
      sessionId: 'sess-1',
      timestampMs: Date.now() + 1,
      role: 'assistant',
      content: '好的，我继续处理。',
      metadata: {
        model: 'gpt-test',
        providerProtocol: 'openai-responses',
        finishReason: 'stop',
      },
    });

    writeCacheEntry({
      type: 'request',
      workingDirectory: tempDir,
      requestId: 'req-2',
      sessionId: 'sess-1',
      timestampMs: Date.now() + 2,
      role: 'user',
      content: '继续',
      metadata: {
        model: 'gpt-test',
        providerProtocol: 'openai-responses',
      },
    });

    const cachePath = path.join(tempDir, 'CACHE.md');
    const content = fs.readFileSync(cachePath, 'utf8');
    expect((content.match(/^### User · /gm) || []).length).toBe(2);
    expect(content).toContain('requestId: req-2');
  });

  it('keeps visible conversation content before metadata comment', () => {
    writeCacheEntry({
      type: 'response',
      workingDirectory: tempDir,
      requestId: 'resp-1',
      sessionId: 'sess-1',
      timestampMs: Date.now(),
      role: 'assistant',
      content: '已完成处理。',
      metadata: {
        model: 'gpt-test',
        providerProtocol: 'openai-responses',
        finishReason: 'stop',
      },
    });

    const cachePath = path.join(tempDir, 'CACHE.md');
    const content = fs.readFileSync(cachePath, 'utf8');
    expect(content).toMatch(/### Assistant · .*?\n\n已完成处理。\n\n<!-- cache-meta/s);
  });
});

describe('cache-writer response/content extraction and workdir resolution', () => {
  it('extracts assistant text from chat message content array', () => {
    const content = extractAssistantTextFromResponse({
      choices: [
        {
          message: {
            role: 'assistant',
            content: [
              { type: 'text', text: '第一段' },
              { type: 'output_text', text: { value: '第二段' } },
            ],
          },
          finish_reason: 'stop',
        },
      ],
    } as any);
    expect(content).toBe('第一段\n第二段');
  });

  it('extracts assistant text from responses output content text.value shape', () => {
    const content = extractAssistantTextFromResponse({
      output: [
        {
          type: 'message',
          role: 'assistant',
          content: [
            { type: 'output_text', text: { value: '响应正文' } },
          ],
        },
      ],
    } as any);
    expect(content).toBe('响应正文');
  });

  it('resolves working directory from multiple adapter context keys', () => {
    expect(
      resolveWorkingDirectoryFromAdapterContext({
        clientWorkdir: '/tmp/a',
      } as any),
    ).toBe('/tmp/a');
    expect(
      resolveWorkingDirectoryFromAdapterContext({
        __rt: { workdir: '/tmp/b' },
      } as any),
    ).toBe('/tmp/b');
  });
});
