export function runNonBlockingCredentialValidation(
  validateCredentials: () => Promise<unknown>
): void {
  const formatUnknownError = (error: unknown): string => {
    if (error instanceof Error) {
      return error.stack || `${error.name}: ${error.message}`;
    }
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  };

  void Promise.resolve()
    .then(async () => {
      try {
        await validateCredentials();
      } catch (error) {
        try {
          console.warn(
            `[provider-startup] runNonBlockingCredentialValidation failed (non-blocking): ${formatUnknownError(error)}`
          );
        } catch {
          // Never throw from non-blocking logging.
        }
      }
    });
}
