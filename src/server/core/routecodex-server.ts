import express from 'express';
import type { Express } from 'express';
import { attachCommonMiddleware, attachHealthEndpoints } from './middleware.js';
import { attachRoutes } from './router.js';
import { HooksIntegration } from './hooks-integration.js';
import type { HandlerContext } from '../handlers/types.js';
import { selectRouteName } from './pipeline-dispatch.js';
import { VirtualRouterModule } from '../../modules/virtual-router/virtual-router-module.js';

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
  private classifierConfig: any = null;
  private virtualRouter: VirtualRouterModule | null = null;
  private _initialized = false;
  private _running = false;
  private hooks?: HooksIntegration;

  constructor(config: UnifiedServerConfig) {
    this.config = config;
    this.app = express();
    attachCommonMiddleware(this.app);
    // 初始化轻量 Hook 集成（默认启用，可通过 v2Config 关闭）
    this.hooks = new HooksIntegration({ enabled: this.config?.v2Config?.enableHooks !== false });
    attachRoutes(this.app, () => this.makeHandlerContext(), this.hooks);
    attachHealthEndpoints(this.app, () => this.getStatus(), async () => { await this.stop(); });
  }
  async initialize(): Promise<void> {
    this._initialized = true;
  }

  private makeHandlerContext(): HandlerContext {
    return {
      pipelineManager: this.pipelineManager,
      routePools: this.routePools,
      selectRouting: async (payload: any, entryEndpoint: string) => {
        // 优先使用虚拟路由器（严格决策 route + pipelineId），无兜底
        if (this.virtualRouter) {
          const req = { request: payload, endpoint: entryEndpoint, protocol: (payload && (payload as any).protocol) || undefined } as any;
          const result = await this.virtualRouter.routeRequest(req as any, 'default');
          const routing = (result && (result as any).routing) ? (result as any).routing : {};
          const routeName = String(routing.route || 'default');
          const pipelineId = typeof routing.pipelineId === 'string' ? routing.pipelineId : undefined;
          return { routeName, pipelineId };
        }
        // 回退：仅用于开发期，没有 VR 时选择首个非空池（会在日志中提示）
        const routeName = await selectRouteName(payload, entryEndpoint, { routePools: this.routePools, routeMeta: this.routeMeta });
        return { routeName };
      }
    };
  }

  public attachPipelineManager(manager: unknown): void {
    this.pipelineManager = manager;
  }

  public attachRoutePools(routePools: Record<string, string[]>): void {
    this.routePools = routePools || {};
    // 若已有分类配置，则初始化虚拟路由器
    this.tryInitVirtualRouter();
  }

  public attachRouteMeta(routeMeta: Record<string, { providerId: string; modelId: string; keyId: string }>): void {
    this.routeMeta = routeMeta || ({} as any);
  }

  public attachRoutingClassifierConfig(config: unknown): void {
    this.classifierConfig = config || null;
    this.tryInitVirtualRouter();
  }

  private async tryInitVirtualRouter(): Promise<void> {
    try {
      if (!this.classifierConfig || !this.routePools || Object.keys(this.routePools).length === 0) {
        return; // 条件不足，暂不初始化
      }
      if (!this.virtualRouter) {
        this.virtualRouter = new VirtualRouterModule();
      }
      await this.virtualRouter.initialize({ classificationConfig: this.classifierConfig, routePools: this.routePools } as any);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.warn('[RouteCodexServer] Failed to initialize VirtualRouter:', error instanceof Error ? error.message : String(error));
    }
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
