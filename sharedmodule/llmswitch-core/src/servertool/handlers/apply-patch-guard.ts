import type { ServerToolHandler, ServerToolHandlerContext, ServerToolHandlerPlan } from '../types.js';
import { registerServerToolHandler } from '../registry.js';

const handler: ServerToolHandler = async (ctx: ServerToolHandlerContext): Promise<ServerToolHandlerPlan | null> => {
  return null;
};

registerServerToolHandler('apply_patch', handler);
