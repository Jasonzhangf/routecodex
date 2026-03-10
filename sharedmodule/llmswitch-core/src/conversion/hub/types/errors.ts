export class ConversionError extends Error {
  public readonly nodeId?: string;
  public readonly stage?: string;

  constructor(message: string, nodeId?: string, stage?: string, cause?: Error) {
    super(message);
    this.name = 'ConversionError';
    this.nodeId = nodeId;
    this.stage = stage;
    if (cause) {
      this.cause = cause;
    }
  }
}
