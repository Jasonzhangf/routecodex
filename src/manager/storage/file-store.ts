import fs from 'node:fs/promises';
import path from 'node:path';
import type { StateStore } from './base-store.js';

export interface FileStoreOptions {
  filePath: string;
}

type JsonlEnvelope<TSnapshot, TEvent> =
  | { kind: 'snapshot'; timestamp: number; snapshot: TSnapshot }
  | { kind: 'event'; timestamp: number; event: TEvent };

export class JsonlFileStore<TSnapshot, TEvent = unknown>
  implements StateStore<TSnapshot, TEvent>
{
  private readonly filePath: string;

  constructor(options: FileStoreOptions) {
    this.filePath = options.filePath;
  }

  async load(): Promise<TSnapshot | null> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      if (!raw.trim()) {
        return null;
      }
      const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
      for (let idx = lines.length - 1; idx >= 0; idx -= 1) {
        const line = lines[idx];
        try {
          const parsed = JSON.parse(line) as JsonlEnvelope<TSnapshot, TEvent>;
          if (parsed && parsed.kind === 'snapshot' && parsed.snapshot !== undefined) {
            return parsed.snapshot;
          }
        } catch {
          // ignore parse errors for individual lines
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  async save(snapshot: TSnapshot): Promise<void> {
    const envelope: JsonlEnvelope<TSnapshot, TEvent> = {
      kind: 'snapshot',
      timestamp: Date.now(),
      snapshot
    };
    await this.appendLine(envelope);
  }

  async append(event: TEvent): Promise<void> {
    const envelope: JsonlEnvelope<TSnapshot, TEvent> = {
      kind: 'event',
      timestamp: Date.now(),
      event
    };
    await this.appendLine(envelope);
  }

  async compact(): Promise<void> {
    // 简单实现：当前不做自动压缩；调用方可在未来根据需要重写。
    return;
  }

  private async appendLine(payload: JsonlEnvelope<TSnapshot, TEvent>): Promise<void> {
    try {
      const dir = path.dirname(this.filePath);
      await fs.mkdir(dir, { recursive: true });
      const line = `${JSON.stringify(payload)}\n`;
      await fs.appendFile(this.filePath, line, 'utf8');
    } catch {
      // 持久化失败不应影响主流程；吞掉错误。
    }
  }
}
