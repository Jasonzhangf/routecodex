type ErrorResponse = {
  success: boolean;
  message: string;
  actionTaken?: string;
  timestamp: number;
  errorId?: string;
};

export class ErrorHandlingCenter {
  async initialize(): Promise<void> {
    // no-op
  }

  async handleError(): Promise<ErrorResponse> {
    return {
      success: true,
      message: 'mock handled',
      timestamp: Date.now()
    };
  }

  handleErrorAsync(): void {
    // no-op
  }

  async handleBatchErrors(errors: unknown[]): Promise<ErrorResponse[]> {
    return errors.map(() => ({
      success: true,
      message: 'mock handled',
      timestamp: Date.now()
    }));
  }

  async destroy(): Promise<void> {
    // no-op
  }

  getHealth(): Record<string, unknown> {
    return { status: 'ok' };
  }

  getStats(): Record<string, unknown> {
    return {};
  }

  resetErrorCount(): void {
    // no-op
  }
}
