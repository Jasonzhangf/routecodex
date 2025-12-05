import crypto from 'node:crypto';
import type { DebugSession, DebugSessionMode, NodeSnapshot, SnapshotQuery, SnapshotStore } from './types.js';

export interface StartSessionOptions {
  id?: string;
  mode?: DebugSessionMode;
  label?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

export class DebugSessionManager {
  private readonly sessions = new Map<string, DebugSession>();

  constructor(private readonly store: SnapshotStore) {}

  startSession(options: StartSessionOptions = {}): DebugSession {
    const id = options.id || `dbg-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
    const existing = this.sessions.get(id);
    if (existing) {
      return existing;
    }
    const session: DebugSession = {
      id,
      mode: options.mode ?? 'capture',
      label: options.label,
      createdAt: Date.now(),
      tags: options.tags,
      metadata: options.metadata
    };
    this.sessions.set(id, session);
    return session;
  }

  getSession(sessionId: string): DebugSession | undefined {
    return this.sessions.get(sessionId);
  }

  async recordSnapshot(sessionId: string, snapshot: Omit<NodeSnapshot, 'sessionId' | 'timestamp'> & { timestamp?: number }): Promise<void> {
    const session = this.sessions.get(sessionId) ?? this.startSession({ id: sessionId });
    if (!session) {
      throw new Error(`[debug-session] Session ${sessionId} not found`);
    }
    await this.store.save({
      sessionId,
      nodeId: snapshot.nodeId,
      direction: snapshot.direction,
      stage: snapshot.stage,
      payload: snapshot.payload,
      metadata: snapshot.metadata,
      timestamp: snapshot.timestamp ?? Date.now()
    });
  }

  async fetchSnapshots(sessionId: string, query?: SnapshotQuery): Promise<NodeSnapshot[]> {
    return await this.store.fetch(sessionId, query);
  }

  async listSessions(): Promise<string[]> {
    const ids = new Set(this.sessions.keys());
    for (const id of await this.store.listSessions()) {
      ids.add(id);
    }
    return Array.from(ids.values());
  }

  async clear(sessionId: string): Promise<void> {
    await this.store.clear(sessionId);
    this.sessions.delete(sessionId);
  }
}
