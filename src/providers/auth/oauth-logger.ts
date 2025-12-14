const truthy = new Set(['1', 'true', 'yes', 'on']);

function isOAuthDebugEnabled(): boolean {
  const raw = String(process.env.ROUTECODEX_OAUTH_DEBUG || '').trim().toLowerCase();
  if (!raw) {
    return false;
  }
  return truthy.has(raw);
}

const oauthDebugEnabled = isOAuthDebugEnabled();

export function logOAuthDebug(message: string): void {
  if (!oauthDebugEnabled) {
    return;
  }
  try {
    console.log(message);
  } catch {
    /* ignore logging errors */
  }
}
