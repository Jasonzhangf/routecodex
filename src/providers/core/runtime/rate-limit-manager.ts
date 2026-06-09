export class RateLimitCooldownError extends Error {
  statusCode = 429;
  code = 'HTTP_429';
  retryable = true;

  constructor(message: string) {
    super(message);
  }
}
