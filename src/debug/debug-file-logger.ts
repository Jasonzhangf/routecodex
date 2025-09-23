/**
 * Debug File Logger
 *
 * Subscribes to the DebugEventBus and persists debug events to a log file.
 * Used to ensure DebugCenter I/O is captured even when the external
 * debugcenter package does not write to disk by default.
 */

import fs from 'fs';
import path from 'path';
import { homedir } from 'os';
import { DebugEventBus } from 'rcc-debugcenter';

interface DebugFileLoggerOptions {
  filePath: string;
  enabled?: boolean;
}

export class DebugFileLogger {
  private static initialized = false;
  private static stream: fs.WriteStream | null = null;
  private static currentPath: string | null = null;

  /**
   * Initialize the debug file logger.
   * Subsequent calls with the same path are ignored. If a different path is
   * provided, the existing stream is rotated to the new destination.
   */
  static initialize(options: DebugFileLoggerOptions): void {
    if (!options.enabled) {
      return;
    }

    const resolvedPath = this.resolvePath(options.filePath);

    // If the logger is already targeting the same file, no further action needed.
    if (this.initialized && this.currentPath === resolvedPath) {
      return;
    }

    // Ensure target directory exists
    const dir = path.dirname(resolvedPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Close any previous stream before opening a new one
    if (this.stream) {
      this.stream.end();
      this.stream = null;
    }

    this.stream = fs.createWriteStream(resolvedPath, { flags: 'a' });
    this.stream.on('error', (error) => {
      console.error('[DebugFileLogger] write error:', error);
    });

    this.currentPath = resolvedPath;

    if (!this.initialized) {
      const bus = DebugEventBus.getInstance();
      bus.subscribe('*', (event: any) => {
        this.writeEvent(event);
      });
      this.initialized = true;
    }
  }

  /**
   * Write event to the log stream as JSONL.
   */
  private static writeEvent(event: any): void {
    if (!this.stream) {
      return;
    }

    try {
      const payload = JSON.stringify({
        timestamp: new Date().toISOString(),
        ...event
      });
      this.stream.write(payload + '\n');
    } catch (error) {
      console.error('[DebugFileLogger] failed to serialize event:', error);
    }
  }

  /**
   * Resolve home-relative paths
   */
  private static resolvePath(filePath: string): string {
    if (!filePath) {
      return path.join(process.cwd(), 'debug-center.log');
    }

    if (filePath.startsWith('~')) {
      return path.join(homedir(), filePath.slice(1));
    }

    return path.isAbsolute(filePath)
      ? filePath
      : path.resolve(process.cwd(), filePath);
  }
}

export default DebugFileLogger;
