import type { RuntimeErrorSignal, ToolExecutionFailureSignal } from './snapshot-recorder-runtime.js';
import {
  classifyRuntimeErrorSignalFromTextNative,
  detectToolExecutionFailuresNative,
  shouldLogClientToolErrorToConsoleNative,
} from './native-exports.js';

type AnyRecord = Record<string, unknown>;

export function detectToolExecutionFailures(payload: AnyRecord): ToolExecutionFailureSignal[] {
  return detectToolExecutionFailuresNative(payload);
}

export function classifyRuntimeErrorSignalFromText(
  stage: string,
  message: string
): RuntimeErrorSignal | null {
  return classifyRuntimeErrorSignalFromTextNative(stage, message);
}

export function shouldLogClientToolErrorToConsole(failure: ToolExecutionFailureSignal): boolean {
  return shouldLogClientToolErrorToConsoleNative(failure);
}
