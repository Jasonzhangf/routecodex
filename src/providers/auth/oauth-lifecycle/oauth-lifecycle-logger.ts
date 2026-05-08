import { keyFor, shouldThrottle, updateThrottle } from './throttle.js';
import { logOAuthDebug } from '../oauth-logger.js';

type ThrottleOpts = { throttleKey?: string; warn?: boolean };

function logOAuthLifecycleNonBlocking(
  stage: string,
  error: unknown,
  details?: Record<string, unknown>,
  opts?: ThrottleOpts & { repairIdentifier?: string }
): void {
  const message = error instanceof Error ? error.message : String(error ?? '');
  const throttleKey = opts?.throttleKey ?? keyFor('oauth-lifecycle-nonblocking', stage);
  if (shouldThrottle(throttleKey, 60_000)) {
    return;
  }
  updateThrottle(throttleKey);
  logOAuthDebug(
    `[OAuth] lifecycle non-blocking error: stage=${stage} message=${message} details=${JSON.stringify({ ...details, error: message })}`
  );
}

export { logOAuthLifecycleNonBlocking };
