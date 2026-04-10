import { captureRegressionSample } from '../regression-capture.js';

export interface ExecCommandRegressionCapture {
  errorType?: string;
  originalArgs?: unknown;
  normalizedArgs?: unknown;
  validationError?: string;
  source?: string;
  meta?: Record<string, unknown>;
}

export function captureExecCommandRegression(payload: ExecCommandRegressionCapture): void {
  captureRegressionSample('exec-command-regression', 'exec_command_validation', {
    tool: 'exec_command',
    ...(payload ?? {})
  });
}
