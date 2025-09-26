/**
 * File Watcher Utility
 * Cross-platform file watching with error handling and debouncing
 */

import fs from 'fs';
import { EventEmitter } from 'events';
import type { ErrorHandlingOptions } from '../utils/error-handling-utils';

/**
 * File watcher configuration options
 */
export interface FileWatcherOptions {
  interval?: number;
  debounceMs?: number;
  persistent?: boolean;
  encoding?: BufferEncoding;
}

/**
 * File change event data
 */
export interface FileChangeEvent {
  path: string;
  eventType: 'change' | 'rename' | 'delete';
  stats?: fs.Stats;
  timestamp: number;
}

/**
 * File watcher with debouncing and error handling
 */
export class FileWatcher extends EventEmitter {
  private path: string;
  private options: Required<FileWatcherOptions>;
  private intervalId?: NodeJS.Timeout;
  private lastStats?: fs.Stats;
  private debounceTimeout?: NodeJS.Timeout;
  private isWatching: boolean = false;
  private errorUtils?: {
    handle: (error: Error, operation: string, options?: ErrorHandlingOptions) => Promise<void>;
  };

  constructor(
    path: string,
    options: FileWatcherOptions = {},
    errorUtils?: {
      handle: (error: Error, operation: string, options?: ErrorHandlingOptions) => Promise<void>;
    }
  ) {
    super();
    this.path = path;
    this.options = {
      interval: options.interval || 1000,
      debounceMs: options.debounceMs || 100,
      persistent: options.persistent ?? true,
      encoding: options.encoding || 'utf8',
    };
    this.errorUtils = errorUtils;
  }

  /**
   * Start watching the file
   */
  async start(): Promise<void> {
    if (this.isWatching) {
      return;
    }

    try {
      // Get initial stats
      this.lastStats = await this.getFileStats();

      // Start polling
      this.startPolling();
      this.isWatching = true;

      this.emit('ready');
    } catch (error) {
      await this.handleError(error as Error, 'start');
      throw error;
    }
  }

  /**
   * Stop watching the file
   */
  stop(): void {
    if (!this.isWatching) {
      return;
    }

    this.stopPolling();
    this.isWatching = false;
    this.emit('stopped');
  }

  /**
   * Check if currently watching
   */
  get isWatchingFile(): boolean {
    return this.isWatching;
  }

  /**
   * Get the watched file path
   */
  get watchedPath(): string {
    return this.path;
  }

  /**
   * Start polling for file changes
   */
  private startPolling(): void {
    this.intervalId = setInterval(async () => {
      try {
        await this.checkFileChanges();
      } catch (error) {
        await this.handleError(error as Error, 'polling');
      }
    }, this.options.interval);
  }

  /**
   * Stop polling
   */
  private stopPolling(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
    }

    if (this.debounceTimeout) {
      clearTimeout(this.debounceTimeout);
      this.debounceTimeout = undefined;
    }
  }

  /**
   * Check for file changes
   */
  private async checkFileChanges(): Promise<void> {
    try {
      const currentStats = await this.getFileStats();

      if (!this.lastStats) {
        this.lastStats = currentStats;
        return;
      }

      const hasChanged = this.hasFileChanged(this.lastStats, currentStats);

      if (hasChanged) {
        this.lastStats = currentStats;
        this.debouncedNotify('change', currentStats);
      }
    } catch (error) {
      const err = error as Error & { code?: string };

      if (err.code === 'ENOENT') {
        // File was deleted
        this.debouncedNotify('delete');
      } else {
        await this.handleError(error as Error, 'checkFileChanges');
      }
    }
  }

  /**
   * Check if file has changed
   */
  private hasFileChanged(oldStats: fs.Stats, newStats: fs.Stats): boolean {
    return (
      oldStats.mtimeMs !== newStats.mtimeMs ||
      oldStats.size !== newStats.size ||
      oldStats.ino !== newStats.ino
    );
  }

  /**
   * Debounced change notification
   */
  private debouncedNotify(eventType: FileChangeEvent['eventType'], stats?: fs.Stats): void {
    if (this.debounceTimeout) {
      clearTimeout(this.debounceTimeout);
    }

    this.debounceTimeout = setTimeout(() => {
      const event: FileChangeEvent = {
        path: this.path,
        eventType,
        stats,
        timestamp: Date.now(),
      };

      this.emit('change', event);
    }, this.options.debounceMs);
  }

  /**
   * Get file stats
   */
  private async getFileStats(): Promise<fs.Stats> {
    return new Promise((resolve, reject) => {
      fs.stat(this.path, (error, stats) => {
        if (error) {
          reject(error);
        } else {
          resolve(stats);
        }
      });
    });
  }

  /**
   * Handle errors
   */
  private async handleError(error: Error, operation: string): Promise<void> {
    if (this.errorUtils) {
      await this.errorUtils.handle(error, operation, {
        additionalContext: {
          path: this.path,
          operation: `file-watcher-${operation}`,
        },
      });
    } else {
      this.emit('error', error);
    }
  }

  /**
   * Cleanup resources
   */
  destroy(): void {
    this.stop();
    this.removeAllListeners();
  }
}

/**
 * Factory function to create a file watcher
 */
export function createFileWatcher(
  path: string,
  options?: FileWatcherOptions,
  errorUtils?: {
    handle: (error: Error, operation: string, options?: ErrorHandlingOptions) => Promise<void>;
  }
): FileWatcher {
  return new FileWatcher(path, options, errorUtils);
}
