/**
 * Configuration Watcher
 * 配置文件监听器
 */

import { watch } from 'node:fs';
import type { FSWatcher } from 'node:fs';
import path from 'path';

export class ConfigWatcher {
  private watchers: Map<string, FSWatcher> = new Map();
  private callbacks: Map<string, Function[]> = new Map();

  /**
   * 监听配置文件
   */
  watchFile(filePath: string, callback: Function): void {
    try {
      const watcher = watch(filePath, (eventType) => {
        if (eventType === 'change') {
          console.log(`📝 Configuration file changed: ${filePath}`);
          callback(filePath);
        }
      });

      this.watchers.set(filePath, watcher);

      // 添加回调
      if (!this.callbacks.has(filePath)) {
        this.callbacks.set(filePath, []);
      }
      this.callbacks.get(filePath)!.push(callback);

      console.log(`👀 Started watching: ${filePath}`);
    } catch (error) {
      console.error(`Failed to watch file ${filePath}:`, error);
    }
  }

  /**
   * 停止监听文件
   */
  unwatchFile(filePath: string): void {
    const watcher = this.watchers.get(filePath);
    if (watcher) {
      watcher.close();
      this.watchers.delete(filePath);
      this.callbacks.delete(filePath);
      console.log(`🛑 Stopped watching: ${filePath}`);
    }
  }

  /**
   * 停止所有监听
   */
  stopAllWatching(): void {
    for (const [filePath, watcher] of this.watchers) {
      watcher.close();
      console.log(`🛑 Stopped watching: ${filePath}`);
    }
    this.watchers.clear();
    this.callbacks.clear();
  }

  /**
   * 触发回调
   */
  private triggerCallbacks(filePath: string): void {
    const callbacks = this.callbacks.get(filePath);
    if (callbacks) {
      for (const callback of callbacks) {
        try {
          callback(filePath);
        } catch (error) {
          console.error(`Error in config change callback for ${filePath}:`, error);
        }
      }
    }
  }
}
