import type { AnyRecord } from './module-loader.js';

export type SnapshotRecorder = unknown;

export type SnapshotRecorderModule = {
  createSnapshotRecorder?: (context: AnyRecord, endpoint: string) => SnapshotRecorder;
};

export type RuntimeErrorGroup = 'parse-error' | 'exec-error';

export interface RuntimeErrorSignal {
  group: RuntimeErrorGroup;
  errorType: string;
  matchedText: string;
}

export interface ToolExecutionFailureSignal {
  toolName: 'exec_command' | 'apply_patch' | 'shell_command';
  errorType: string;
  matchedText: string;
  toolCallId?: string;
  callId?: string;
}

export interface StageTraceEntry {
  at: string;
  stage: string;
  payload: unknown;
}

export interface ClientToolTraceSummaryEntry {
  at: string;
  stage: string;
}

export const MAX_STAGE_TRACE_ENTRIES = 40;
export const MAX_STAGE_TRACE_PAYLOAD_CHARS = 120_000;
export const MAX_CLIENT_TOOL_ERROR_TRACE_ENTRIES = 6;
