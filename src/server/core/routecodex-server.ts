import express from 'express';
import type { Express } from 'express';
import { attachCommonMiddleware, attachHealthEndpoints } from './middleware.js';
import { attachRoutes } from './router.js';
import type { HandlerContext } from '../handlers/types.js';
import { selectRouteName } from './pipeline-dispatch.js';

export interface UnifiedServerConfig {
  server: { host: string; port: number };
  logging?: { level?: string; enableConsole?: boolean };
  v2Config?: { enableHooks?: boolean };
}

export class RouteCodexServer {
  private app: Express;
  private server: any;
  private readonly config: UnifiedServerConfig;
  private pipelineManager: any = null;
  private routePools: Record<string, string[]> = {};
  private routeMeta: Record<string, { providerId: string; modelId: string; keyId: string }> = {} as any;
  private _initialized = false;
  private _running = false;

  constructor(config: UnifiedServerConfig) {
    this.config = config;
    this.app = express();
    attachCommonMiddleware(this.app);
    attachRoutes(this.app, () => this.makeHandlerContext());
    attachHealthEndpoints(this.app, () => this.getStatus(), async () => { await this.stop(); });
  }
  async initialize(): Promise<void> {
    this._initialized = true;
  }

  private makeHandlerContext(): HandlerContext {
    return {
      pipelineManager: this.pipelineManager,
      routePools: this.routePools,
      selectRouteName: async (payload: any, entryEndpoint: string) => {
        return await selectRouteName(payload, entryEndpoint, { routePools: this.routePools });
      }
    };
  }

  public attachPipelineManager(manager: unknown): void {
    this.pipelineManager = manager;
  }

  public attachRoutePools(routePools: Record<string, string[]>): void {
    this.routePools = routePools || {};
  }

  public attachRouteMeta(routeMeta: Record<string, { providerId: string; modelId: string; keyId: string }>): void {
    this.routeMeta = routeMeta || ({} as any);
  }

  public getStatus(): any {
    try {
      const pm = this.pipelineManager && typeof this.pipelineManager?.getStatus === 'function' ? this.pipelineManager.getStatus() : undefined;
      return { status: 'running', manager: pm };
    } catch {
      return { status: 'running' };
    }
  }

  // For compatibility with previous V2 server wiring
  public async initializeWithMergedConfig(_mergedConfig: any): Promise<void> {
    // Snapshots toggles are handled at process start; nothing else required here.
    return;
  }

  async start(): Promise<void> {
    const { host, port } = this.config.server;
    await new Promise<void>((resolve) => {
      this.server = this.app.listen(port, host, () => resolve());
    });
    console.log(`[RouteCodexServer] started on http://${host}:${port}`);
    this._running = true;
  }

  async stop(): Promise<void> {
    try {
      if (this.server) {
        await new Promise<void>((resolve) => this.server.close(() => resolve()));
      }
    } catch {}
    console.log('[RouteCodexServer] stopped');
    this._running = false;
  }

  isInitialized(): boolean { return this._initialized; }
  isRunning(): boolean { return this._running; }
}
