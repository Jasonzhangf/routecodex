import type { AnyRecord } from './module-loader.js';
import type { RuntimeErrorSignal, ToolExecutionFailureSignal } from './snapshot-recorder-types.js';
export declare function classifyApplyPatchVerificationFailure(content: string): {
    errorType: string;
    matchedText: string;
};
export declare function detectToolExecutionFailures(payload: AnyRecord): ToolExecutionFailureSignal[];
export declare function classifyRuntimeErrorSignalFromText(stage: string, message: string): RuntimeErrorSignal | null;
export declare function shouldLogClientToolErrorToConsole(failure: ToolExecutionFailureSignal): boolean;
