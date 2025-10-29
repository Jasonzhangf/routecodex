/**
 * Debug File Logger (moved under modules/debug)
 * Subscribes to the DebugEventBus and persists debug events to a log file.
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

  static initialize(options: DebugFileLoggerOptions): void {
    if (!options.enabled) return;
    const resolvedPath = this.resolvePath(options.filePath);
    if (this.initialized && this.currentPath === resolvedPath) return;

    const dir = path.dirname(resolvedPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    if (this.stream) { this.stream.end(); this.stream = null; }

    this.stream = fs.createWriteStream(resolvedPath, { flags: 'a' });
    this.stream.on('error', (error) => { console.error('[DebugFileLogger] write error:', error); });
    this.currentPath = resolvedPath;

    if (!this.initialized) {
      const bus = DebugEventBus.getInstance();
      // @ts-ignore subscribe exists in runtime
      bus.subscribe?.('*', (event: unknown) => { this.writeEvent(event); });
      this.initialized = true;
    }
  }

  private static writeEvent(event: unknown): void {
    if (!this.stream) return;
    try {
      const payload = JSON.stringify({ timestamp: new Date().toISOString(), ...(event && typeof event === 'object' ? event : {}) });
      this.stream.write(`${payload}\n`);
    } catch (error) {
      console.error('[DebugFileLogger] failed to serialize event:', error);
    }
  }

  private static resolvePath(filePath: string): string {
    if (!filePath) return path.join(process.cwd(), 'debug-center.log');
    if (filePath.startsWith('~')) return path.join(homedir(), filePath.slice(1));
    return path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
  }
}

export default DebugFileLogger;

