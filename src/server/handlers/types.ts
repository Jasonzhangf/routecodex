import type { Request, Response } from 'express';

export interface HandlerContext {
  pipelineManager: any;
  routePools: Record<string, string[]>;
  pickPipelineId: () => string | null;
}

export type EndpointHandler = (req: Request, res: Response, ctx: HandlerContext) => Promise<void>;

