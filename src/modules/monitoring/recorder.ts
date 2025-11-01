import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { MonitorMeta, MonitorRequestRecord, StreamEventRecord } from './types.js';

export class Recorder {
  private root: string;

  constructor(rootPath?: string) {
    this.root = rootPath || path.join(os.homedir(), '.routecodex', 'monitor', 'sessions');
  }

  private dayDir(ts: number): string {
    const d = new Date(ts);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${yyyy}${mm}${dd}`;
  }

  private entryDir(meta: MonitorMeta): string {
    const day = this.dayDir(meta.timestamp || Date.now());
    const protocol = meta.protocol || 'unknown';
    return path.join(this.root, day, String(protocol), meta.reqId);
  }

  async start(reqId: string, payload: MonitorRequestRecord): Promise<string> {
    const dir = this.entryDir(payload.meta);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'meta.json'), JSON.stringify(payload.meta, null, 2));
    await fs.writeFile(path.join(dir, 'request.json'), JSON.stringify(payload.request, null, 2));
    if (payload.summary) {
      await fs.writeFile(path.join(dir, 'request.summary.json'), JSON.stringify(payload.summary, null, 2));
    }
    return dir;
  }

  async writeDecision(meta: MonitorMeta, decision: unknown): Promise<void> {
    const dir = this.entryDir(meta);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'decision.json'), JSON.stringify(decision, null, 2));
  }

  async appendStream(meta: MonitorMeta, event: StreamEventRecord): Promise<void> {
    const dir = this.entryDir(meta);
    await fs.mkdir(dir, { recursive: true });
    const line = `${JSON.stringify({ ...event, at: event.at || Date.now() })  }\n`;
    await fs.appendFile(path.join(dir, 'stream-events.jsonl'), line);
  }

  async writeResponse(meta: MonitorMeta, response: unknown): Promise<void> {
    const dir = this.entryDir(meta);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'response.json'), JSON.stringify(response, null, 2));
  }

  async finalize(meta: MonitorMeta, summary?: Record<string, unknown>): Promise<void> {
    const dir = this.entryDir(meta);
    const file = path.join(dir, 'meta.json');
    try {
      const j = JSON.parse(await fs.readFile(file, 'utf8')) as MonitorMeta;
      const next = { ...j, storage: { ...(j.storage || {}), hasStream: true } } as MonitorMeta;
      await fs.writeFile(file, JSON.stringify(next, null, 2));
      if (summary) {
        await fs.writeFile(path.join(dir, 'summary.json'), JSON.stringify(summary, null, 2));
      }
    } catch {
      // ignore finalize failures
    }
  }
}

