import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { NodeSnapshot, SnapshotQuery, SnapshotStore } from './types.js';

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function parseLines(content: string): NodeSnapshot[] {
  const snapshots: NodeSnapshot[] = [];
  const lines = content.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      snapshots.push(JSON.parse(trimmed));
    } catch {
      // ignore broken lines
    }
  }
  return snapshots;
}

export class FileSnapshotStore implements SnapshotStore {
  private readonly baseDir: string;

  constructor(directory?: string) {
    const root = directory || process.env.ROUTECODEX_DEBUG_DIR || path.join(process.cwd(), 'logs', 'debug');
    this.baseDir = path.resolve(root);
  }

  private sessionFile(sessionId: string): string {
    return path.join(this.baseDir, `${sessionId}.jsonl`);
  }

  async save(snapshot: NodeSnapshot): Promise<void> {
    ensureDir(this.baseDir);
    const payload = JSON.stringify(snapshot);
    await fsp.appendFile(this.sessionFile(snapshot.sessionId), `${payload}\n`, 'utf8');
  }

  async fetch(sessionId: string, query?: SnapshotQuery): Promise<NodeSnapshot[]> {
    try {
      const content = await fsp.readFile(this.sessionFile(sessionId), 'utf8');
      let snapshots = parseLines(content);
      if (query?.nodeId) {
        snapshots = snapshots.filter((snap) => snap.nodeId === query.nodeId);
      }
      if (query?.direction) {
        snapshots = snapshots.filter((snap) => snap.direction === query.direction);
      }
      if (typeof query?.limit === 'number') {
        snapshots = snapshots.slice(-query.limit);
      }
      return snapshots;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }

  async clear(sessionId: string): Promise<void> {
    try {
      await fsp.rm(this.sessionFile(sessionId));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }

  async listSessions(): Promise<string[]> {
    ensureDir(this.baseDir);
    const files = await fsp.readdir(this.baseDir);
    return files.filter((file) => file.endsWith('.jsonl')).map((file) => path.basename(file, '.jsonl'));
  }
}
