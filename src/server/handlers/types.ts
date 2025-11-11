import type { Request, Response } from 'express';

export interface HandlerContext {
  pipelineManager: any;
  routePools: Record<string, string[]>;
  selectPipelineId: (payload: any, entryEndpoint: string) => Promise<string>;
}

export type EndpointHandler = (req: Request, res: Response, ctx: HandlerContext) => Promise<void>;
