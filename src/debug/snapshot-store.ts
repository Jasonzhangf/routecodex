import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { NodeSnapshot, SnapshotQuery, SnapshotStore } from './types.js';
import { redactSensitiveData } from '../utils/sensitive-redaction.js';

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function pathExists(filePath: string): boolean {
  return fs.existsSync(filePath);
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

  private sessionFile(sessionId: string, metadata?: Record<string, unknown>): string {
    const protocol = readSnapshotProtocol(metadata);
    const port = readSnapshotPort(metadata);
    if (protocol && port) {
      return path.join(this.baseDir, protocol, 'ports', String(port), `${sessionId}.jsonl`);
    }
    if (protocol) {
      return path.join(this.baseDir, protocol, `${sessionId}.jsonl`);
    }
    if (port) {
      return path.join(this.baseDir, 'ports', String(port), `${sessionId}.jsonl`);
    }
    return path.join(this.baseDir, `${sessionId}.jsonl`);
  }

  private findSessionFiles(sessionId: string): string[] {
    ensureDir(this.baseDir);
    const visited = new Set<string>();
    const matches: string[] = [];
    const stack = [this.baseDir];

    while (stack.length > 0) {
      const current = stack.pop();
      if (!current || visited.has(current)) {
        continue;
      }
      visited.add(current);
      const entries = fs.readdirSync(current, { withFileTypes: true });
      for (const entry of entries) {
        const next = path.join(current, entry.name);
        if (entry.isDirectory()) {
          stack.push(next);
          continue;
        }
        if (entry.isFile() && entry.name === `${sessionId}.jsonl`) {
          matches.push(next);
        }
      }
    }

    return matches.sort();
  }

  private readSnapshotsForSession(sessionId: string): NodeSnapshot[] {
    const files = this.findSessionFiles(sessionId);
    if (files.length === 0) {
      return [];
    }
    return files.flatMap((file) => {
      const content = fs.readFileSync(file, 'utf8');
      return parseLines(content);
    });
  }

  private listSessionFiles(): string[] {
    ensureDir(this.baseDir);
    const visited = new Set<string>();
    const sessions = new Set<string>();
    const stack = [this.baseDir];

    while (stack.length > 0) {
      const current = stack.pop();
      if (!current || visited.has(current)) {
        continue;
      }
      visited.add(current);
      const entries = fs.readdirSync(current, { withFileTypes: true });
      for (const entry of entries) {
        const next = path.join(current, entry.name);
        if (entry.isDirectory()) {
          stack.push(next);
          continue;
        }
        if (entry.isFile() && entry.name.endsWith('.jsonl')) {
          sessions.add(path.basename(entry.name, '.jsonl'));
        }
      }
    }

    return Array.from(sessions.values()).sort();
  }

  async save(snapshot: NodeSnapshot): Promise<void> {
    const file = this.sessionFile(snapshot.sessionId, snapshot.metadata);
    ensureDir(path.dirname(file));
    const payload = JSON.stringify(redactSensitiveData(snapshot));
    await fsp.appendFile(file, `${payload}\n`, 'utf8');
  }

  async fetch(sessionId: string, query?: SnapshotQuery): Promise<NodeSnapshot[]> {
    let snapshots = this.readSnapshotsForSession(sessionId);
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
  }

  async clear(sessionId: string): Promise<void> {
    const files = this.findSessionFiles(sessionId);
    for (const file of files) {
      if (!pathExists(file)) {
        continue;
      }
      try {
        await fsp.rm(file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error;
        }
      }
    }
  }

  async listSessions(): Promise<string[]> {
    return this.listSessionFiles();
  }
}

function readSnapshotProtocol(metadata: Record<string, unknown> | undefined): string | undefined {
  if (!metadata || typeof metadata !== 'object') {
    return undefined;
  }
  const value = metadata.entryProtocol;
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function readSnapshotPort(metadata: Record<string, unknown> | undefined): number | undefined {
  if (!metadata || typeof metadata !== 'object') {
    return undefined;
  }
  const portContext = metadata.portContext && typeof metadata.portContext === 'object'
    ? metadata.portContext as Record<string, unknown>
    : undefined;
  const candidates = [
    metadata.entryPort,
    metadata.matchedPort,
    metadata.localPort,
    portContext?.matchedPort,
    portContext?.localPort
  ];
  for (const value of candidates) {
    const numeric = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
    if (Number.isFinite(numeric) && numeric > 0) {
      return Math.floor(numeric);
    }
  }
  return undefined;
}
