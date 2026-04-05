import fs from 'node:fs/promises';
import path from 'node:path';
import type { StateStore } from './base-store.js';

export interface FileStoreOptions {
  filePath: string;
  /**
   * 最大事件保留时长（毫秒）。超出该时间窗口的旧事件会在 compact 时被丢弃。
   * 若未设置或 <=0，则不按时间裁剪。
   */
  maxAgeMs?: number;
  /**
   * 单个文件中最多保留的事件条数（不含最新快照）。
   * 若未设置或 <=0，则不按数量裁剪。
   */
  maxEvents?: number;
}

type JsonlEnvelope<TSnapshot, TEvent> =
  | { kind: 'snapshot'; timestamp: number; snapshot: TSnapshot }
  | { kind: 'event'; timestamp: number; event: TEvent };

function isEnoentError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === 'object' &&
      'code' in error &&
      typeof (error as { code?: unknown }).code === 'string' &&
      (error as { code: string }).code === 'ENOENT'
  );
}

function logJsonlFileStoreNonBlockingError(operation: string, error: unknown, details?: Record<string, unknown>): void {
  const reason = error instanceof Error ? error.message : String(error);
  const suffix = details ? ` details=${JSON.stringify(details)}` : '';
  console.warn(`[jsonl-file-store] ${operation} failed (non-blocking): ${reason}${suffix}`);
}

export class JsonlFileStore<TSnapshot, TEvent = unknown>
  implements StateStore<TSnapshot, TEvent>
{
  private readonly filePath: string;
  private readonly maxAgeMs: number | undefined;
  private readonly maxEvents: number | undefined;

  constructor(options: FileStoreOptions) {
    this.filePath = options.filePath;
    this.maxAgeMs = typeof options.maxAgeMs === 'number' && options.maxAgeMs > 0 ? options.maxAgeMs : undefined;
    this.maxEvents = typeof options.maxEvents === 'number' && options.maxEvents > 0 ? options.maxEvents : undefined;
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
        } catch (error) {
          logJsonlFileStoreNonBlockingError('load.parseLine', error, { filePath: this.filePath, line: idx });
        }
      }
      return null;
    } catch (error) {
      if (isEnoentError(error)) {
        return null;
      }
      logJsonlFileStoreNonBlockingError('load.readFile', error, { filePath: this.filePath });
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
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const lines = raw
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      if (!lines.length) {
        return;
      }

      const envelopes: JsonlEnvelope<TSnapshot, TEvent>[] = [];
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line) as JsonlEnvelope<TSnapshot, TEvent>;
          if (parsed && typeof parsed.timestamp === 'number') {
            envelopes.push(parsed);
          }
        } catch (error) {
          logJsonlFileStoreNonBlockingError('compact.parseLine', error, { filePath: this.filePath });
        }
      }
      if (!envelopes.length) {
        return;
      }

      // 保留最后一个快照
      const snapshots = envelopes.filter((entry) => entry.kind === 'snapshot');
      const lastSnapshot = snapshots.length ? snapshots[snapshots.length - 1] : undefined;

      // 事件按时间与数量窗口裁剪
      const now = Date.now();
      let events = envelopes.filter((entry) => entry.kind === 'event') as Array<
        Extract<JsonlEnvelope<TSnapshot, TEvent>, { kind: 'event' }>
      >;
      if (this.maxAgeMs) {
        const cutoff = now - this.maxAgeMs;
        events = events.filter((entry) => entry.timestamp >= cutoff);
      }
      if (this.maxEvents && events.length > this.maxEvents) {
        events = events.slice(-this.maxEvents);
      }

      const next: JsonlEnvelope<TSnapshot, TEvent>[] = [];
      if (lastSnapshot) {
        next.push(lastSnapshot);
      }
      next.push(...events);

      const dir = path.dirname(this.filePath);
      await fs.mkdir(dir, { recursive: true });
      const payload = `${next.map((entry) => JSON.stringify(entry)).join('\n')  }\n`;
      await fs.writeFile(this.filePath, payload, 'utf8');
    } catch (error) {
      logJsonlFileStoreNonBlockingError('compact', error, { filePath: this.filePath });
    }
  }

  private async appendLine(payload: JsonlEnvelope<TSnapshot, TEvent>): Promise<void> {
    try {
      const dir = path.dirname(this.filePath);
      await fs.mkdir(dir, { recursive: true });
      const line = `${JSON.stringify(payload)}\n`;
      await fs.appendFile(this.filePath, line, 'utf8');
    } catch (error) {
      logJsonlFileStoreNonBlockingError('appendLine', error, { filePath: this.filePath });
    }
  }
}
