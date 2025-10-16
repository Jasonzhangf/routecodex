// Passive monitoring module skeleton — not wired into runtime by default.
// Provides type-safe hooks for future enablement without affecting existing code.

import type { MonitorMeta } from './types.js';
import { Recorder } from './recorder.js';

export class MonitorModule {
  private recorder: Recorder;
  private enabled: boolean;

  constructor(options?: { rootPath?: string; enabled?: boolean }) {
    this.recorder = new Recorder(options?.rootPath);
    this.enabled = !!options?.enabled;
  }

  async initialize(): Promise<void> {
    // no-op; kept for symmetry with other modules
  }

  async onIncoming(_req: unknown, _ctx: { meta: MonitorMeta; summary?: Record<string, unknown> }): Promise<void> {
    if (!this.enabled) return;
    const { meta, summary } = _ctx;
    await this.recorder.start(meta.reqId, { meta, request: _req, summary });
  }

  async onRouteDecision(_reqId: string, _decision: unknown, _ctx?: { meta: MonitorMeta }): Promise<void> {
    if (!this.enabled) return;
    if (!_ctx?.meta) return;
    await this.recorder.writeDecision(_ctx.meta, _decision);
  }

  async onOutgoing(_response: unknown, _ctx: { meta: MonitorMeta }): Promise<void> {
    if (!this.enabled) return;
    await this.recorder.writeResponse(_ctx.meta, _response);
  }

  async onStreamChunk(_chunk: unknown, _ctx: { meta: MonitorMeta; type?: string }): Promise<void> {
    if (!this.enabled) return;
    await this.recorder.appendStream(_ctx.meta, { type: _ctx.type || 'chunk', data: _chunk, at: Date.now() });
  }

  async finalize(_ctx: { meta: MonitorMeta; summary?: Record<string, unknown> }): Promise<void> {
    if (!this.enabled) return;
    await this.recorder.finalize(_ctx.meta, _ctx.summary);
  }
}

