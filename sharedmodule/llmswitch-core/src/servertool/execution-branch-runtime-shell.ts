import { planServertoolExecutionBranchWithNative } from '../native/router-hotpath/native-servertool-core-semantics.js';

export function planServertoolExecutionBranchRuntimeAction(args: {
  executableToolCalls: Array<{
    id: string;
    name: string;
    executionMode?: string;
  }>;
  executedToolCallsLen: number;
}) {
  const executableToolCallInputs = args.executableToolCalls.map((toolCall) => ({
    id: toolCall.id,
    name: toolCall.name,
    executionMode: toolCall.executionMode
  }));
  return planServertoolExecutionBranchWithNative({
    executableToolCalls: executableToolCallInputs,
    executedToolCallsLen: args.executedToolCallsLen
  });
}
