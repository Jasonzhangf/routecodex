import type { ServerToolHandler, ServerToolHandlerContext, ServerToolHandlerPlan } from '../types.js';
import { registerServerToolHandler } from '../registry.js';

const handler: ServerToolHandler = async (_ctx: ServerToolHandlerContext): Promise<ServerToolHandlerPlan | null> => {
  // exec_command is executed by the client. ServerTool must not fabricate tool outputs
  // or followups; client will run (or fail) and send the real tool_result in next request.
  //
  // Shape-only normalization is handled by tool-governor (validateToolCall + normalizedArgs)
  // before the client receives the tool call.
  return null;
};

registerServerToolHandler('exec_command', handler);

