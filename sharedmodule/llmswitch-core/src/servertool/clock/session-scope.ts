import { resolveClockSessionScopeWithNative } from '../../router/virtual-router/engine-selection/native-chat-process-clock-reminder-semantics.js';

export function buildClockSessionScopeFromDaemonId(_daemonId: string): string {
  return '';
}

export function extractClockDaemonIdFromSessionScope(_sessionScope: string): string | null {
  return null;
}

export function resolveClockSessionScope(
  primary?: Record<string, unknown> | null,
  fallback?: Record<string, unknown> | null
): string | null {
  return resolveClockSessionScopeWithNative(primary, fallback);
}
