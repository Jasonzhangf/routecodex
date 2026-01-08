import type { StateStore } from './base-store.js';

export interface FileStoreOptions {
  filePath: string;
}

export class JsonlFileStore<TSnapshot, TEvent = unknown>
  implements StateStore<TSnapshot, TEvent>
{
  // 实际持久化逻辑后续实现，这里仅占位以便先搭建模块化结构。
  constructor(_options: FileStoreOptions) {}

  async load(): Promise<TSnapshot | null> {
    return null;
  }

  async save(_snapshot: TSnapshot): Promise<void> {
    // no-op placeholder
  }

  async append(_event: TEvent): Promise<void> {
    // no-op placeholder
  }

  async compact(): Promise<void> {
    // no-op placeholder
  }
}

