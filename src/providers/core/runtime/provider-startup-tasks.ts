export function runNonBlockingCredentialValidation(
  validateCredentials: () => Promise<unknown>
): void {
  void Promise.resolve()
    .then(async () => {
      try {
        await validateCredentials();
      } catch {
        // ignore validation errors on startup
      }
    });
}
