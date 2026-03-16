import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  writeCacheEntry,
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
