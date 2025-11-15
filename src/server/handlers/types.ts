import type { Request, Response } from 'express';

export interface HandlerContext {
  pipelineManager: any;
  routePools: Record<string, string[]>;
  // 虚拟路由器决策的“路由池名称”（例如 default/coding/websearch 等）
  selectRouteName: (payload: any, entryEndpoint: string) => Promise<string>;
}

export type EndpointHandler = (req: Request, res: Response, ctx: HandlerContext) => Promise<void>;
