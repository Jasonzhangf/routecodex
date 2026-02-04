export function isPermanentOAuthRefreshErrorMessage(message: string): boolean {
  const normalized = (message || '').toLowerCase();
  if (!normalized) {
    return false;
  }

  // Most providers return: "OAuth error: <code> - <description>"
  // Treat only clearly-permanent refresh credential errors as non-retryable.
  if (normalized.includes('oauth error: invalid_grant')) {
    return true;
  }
  if (normalized.includes('oauth error: invalid_client')) {
    return true;
  }
  if (normalized.includes('oauth error: unauthorized_client')) {
    return true;
  }
  if (normalized.includes('oauth error: invalid_request')) {
    if (
      normalized.includes('refresh token') ||
      normalized.includes('refresh_token') ||
      normalized.includes('client_id')
    ) {
      return true;
    }
  }
  return false;
}

