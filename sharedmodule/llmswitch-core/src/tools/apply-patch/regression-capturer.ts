import { captureRegressionSample } from '../regression-capture.js';

export interface ApplyPatchRegressionCapture {
  errorType?: string;
  originalArgs?: unknown;
  normalizedArgs?: unknown;
  validationError?: string;
  source?: string;
  meta?: Record<string, unknown>;
}

export function captureApplyPatchRegression(payload: ApplyPatchRegressionCapture): void {
  captureRegressionSample('apply-patch-regression', 'apply_patch_validation', {
    tool: 'apply_patch',
    ...(payload ?? {})
  });
}
