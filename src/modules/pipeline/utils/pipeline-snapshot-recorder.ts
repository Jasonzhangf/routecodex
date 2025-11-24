import os from 'os';
import path from 'path';
import fsp from 'fs/promises';
import { writeSnapshotViaHooks } from '../../llmswitch/bridge.js';

const DEFAULT_STAGE = 'pipeline.aggregate';

export type PipelineSnapshotDirection = 'request' | 'response' | 'system';

export interface PipelineSnapshotRecorderOptions {
  requestId: string;
  pipelineId: string;
  entryEndpoint?: string;
  blueprint?: {
    id: string;
    phase: string;
    processMode: string;
  };
  route?: {
    providerId?: string;
    modelId?: string;
  };
  metadata?: Record<string, unknown>;
}

export interface PipelineSnapshotEvent {
  timestamp: number;
  stage: string;
  hookStage?: string;
  module: string;
  direction: PipelineSnapshotDirection;
  payload: unknown;
  metadata?: Record<string, unknown>;
}

export interface PipelineSnapshotFinalPayload {
  response?: unknown;
  error?: {
    message: string;
    stack?: string;
    stage?: string;
    details?: unknown;
  };
  timings?: Record<string, number>;
  extra?: Record<string, unknown>;
}

/**
 * Aggregates per-stage pipeline events and flushes a single snapshot file
 * per request through the llmswitch-core snapshot hook.
 */
export class PipelineSnapshotRecorder {
  private readonly events: PipelineSnapshotEvent[] = [];
  private readonly startedAt = Date.now();
  private flushed = false;

  constructor(private readonly options: PipelineSnapshotRecorderOptions) {}

  record(event: Omit<PipelineSnapshotEvent, 'timestamp'>): void {
    if (this.flushed) return;
    this.events.push({
      ...event,
      timestamp: Date.now()
    });
  }

  async flushSuccess(payload: Omit<PipelineSnapshotFinalPayload, 'error'> = {}): Promise<void> {
    await this.flush({ ...payload });
  }

  async flushError(stage: string | undefined, error: unknown): Promise<void> {
    const normalizedError = this.normalizeError(stage, error);
    await this.flush({ error: normalizedError });
  }

  private normalizeError(stage: string | undefined, error: unknown): PipelineSnapshotFinalPayload['error'] {
    if (error instanceof Error) {
      const errRecord = error as unknown as Record<string, unknown>;
      return {
        message: error.message,
        stage,
        stack: error.stack,
        details: errRecord?.details
      };
    }

    if (typeof error === 'object' && error !== null) {
      const errObj = error as Record<string, unknown>;
      const message = typeof errObj['message'] === 'string'
        ? errObj['message']
        : JSON.stringify(errObj);
      return {
        message,
        stage,
        details: errObj
      };
    }

    return {
      message: String(error),
      stage
    };
  }

  private async flush(finalPayload: PipelineSnapshotFinalPayload): Promise<void> {
    if (this.flushed) return;
    this.flushed = true;

    const snapshotDocument = {
      requestId: this.options.requestId,
      pipelineId: this.options.pipelineId,
      entryEndpoint: this.options.entryEndpoint || '/v1/chat/completions',
      route: {
        providerId: this.options.route?.providerId,
        modelId: this.options.route?.modelId
      },
      blueprint: this.options.blueprint,
      metadata: this.options.metadata || {},
      startedAt: this.startedAt,
      finishedAt: Date.now(),
      durationMs: Date.now() - this.startedAt,
      events: this.events,
      result: finalPayload
    };

    const endpoint = snapshotDocument.entryEndpoint;
    const safeDocument = sanitizeForSnapshot(snapshotDocument);
    await this.writeViaHooks(endpoint, safeDocument);
  }

  private async writeViaHooks(endpoint: string, document: unknown): Promise<void> {
    try {
      await writeSnapshotViaHooks('pipeline', {
        endpoint,
        stage: DEFAULT_STAGE,
        requestId: this.options.requestId,
        data: document,
        verbosity: 'verbose'
      });
    } catch {
      await this.writeFallback(endpoint, document);
    }
  }

  private async writeFallback(endpoint: string, document: unknown): Promise<void> {
    try {
      const baseDir = path.join(os.homedir(), '.routecodex', 'codex-samples');
      const folder = this.mapEndpointToFolder(endpoint);
      const dir = path.join(baseDir, folder);
      await fsp.mkdir(dir, { recursive: true });
      const safeStage = DEFAULT_STAGE.replace(/[^a-z0-9_.-]+/gi, '-');
      const file = path.join(dir, `${this.options.requestId}_${safeStage}.json`);
      await fsp.writeFile(file, JSON.stringify(document, null, 2), 'utf-8');
    } catch {
      // Non-blocking fallback
    }
  }

  private mapEndpointToFolder(entryEndpoint?: string): string {
    const ep = String(entryEndpoint || '').toLowerCase();
    if (ep.includes('/v1/responses')) return 'openai-responses';
    if (ep.includes('/v1/messages') || ep.includes('/anthropic')) return 'anthropic-messages';
    return 'openai-chat';
  }
}

function sanitizeForSnapshot(value: unknown, seen = new WeakSet()): unknown {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'bigint') {
      return value.toString();
    }
    if (typeof value === 'function') {
      return undefined;
    }
    return value;
  }

  if (seen.has(value as Record<string, unknown>)) {
    return '[Circular]';
  }
  seen.add(value as Record<string, unknown>);

  if (value instanceof Error) {
    const errObj: Record<string, unknown> = {
      name: value.name,
      message: value.message,
      stack: value.stack
    };
    for (const [key, val] of Object.entries(value)) {
      if (key === 'cause') continue;
      errObj[key] = sanitizeForSnapshot(val, seen);
    }
    return errObj;
  }

  if (Array.isArray(value)) {
    return value.map(item => sanitizeForSnapshot(item, seen));
  }

  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (typeof val === 'function') continue;
    out[key] = sanitizeForSnapshot(val, seen);
  }
  return out;
}
