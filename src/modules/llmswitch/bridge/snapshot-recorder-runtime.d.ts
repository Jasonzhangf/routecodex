import type { AnyRecord } from './module-loader.js';
import type { ClientToolTraceSummaryEntry, RuntimeErrorSignal, StageTraceEntry, ToolExecutionFailureSignal } from './snapshot-recorder-types.js';
export declare function resetSnapshotRecorderErrorsampleStateForTests(): void;
export declare function clipText(input: string, max?: number): string;
export declare function writeBridgeErrorsample(args: {
    group: string;
    kind: string;
    sampleKind: string;
    endpoint: string;
    stage: string;
    context: AnyRecord;
    observation: unknown;
    extras?: Record<string, unknown>;
}): void;
export declare function logClientToolError(args: {
    requestId?: string;
    stage: string;
    toolName: string;
    errorType: string;
    matchedText: string;
    condensed?: boolean;
}): void;
export declare function logRuntimeErrorSignal(args: {
    requestId?: string;
    stage: string;
    group: 'parse-error' | 'exec-error';
    errorType: string;
    matchedText: string;
}): void;
export declare function shouldLogRuntimeErrorSignalToConsole(signal: RuntimeErrorSignal): boolean;
export declare function shouldInspectRuntimeError(stage: string, payload: AnyRecord): boolean;
export declare function classifyRuntimeErrorSignal(stage: string, payload: AnyRecord): RuntimeErrorSignal | null;
export declare function appendStageTrace(trace: StageTraceEntry[], stage: string, payload: AnyRecord): void;
export declare function cloneStageTraceSummary(trace: StageTraceEntry[], limit?: number): ClientToolTraceSummaryEntry[];
export declare function isRecordableApplyPatchErrorType(errorType: string): boolean;
export declare function shouldWriteClientToolErrorsample(args: {
    endpoint: string;
    stage: string;
    failure: ToolExecutionFailureSignal;
}): boolean;
export declare function summarizeClientToolObservation(payload: AnyRecord, failures: ToolExecutionFailureSignal[]): Record<string, unknown>;
