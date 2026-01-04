export type ErrorContext = {
  error: unknown;
  source: string;
  severity: string;
  context?: Record<string, unknown>;
};

export type ErrorResponse = {
  success: boolean;
  message?: string;
  errorId?: string;
};

export class ErrorHandlingCenter {
  async initialize(): Promise<void> {
    // no-op mock
  }

  async handleError(_context: ErrorContext): Promise<ErrorResponse> {
    return { success: true };
  }
}
