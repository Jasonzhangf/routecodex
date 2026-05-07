export function buildFollowupRequestId(baseRequestId: string, suffix?: string): string {
  const trimmedBase = typeof baseRequestId === 'string' && baseRequestId.trim() ? baseRequestId.trim() : 'servertool';
  const trimmedSuffix = typeof suffix === 'string' && suffix.trim() ? suffix.trim() : ':followup';
  return `${trimmedBase}${trimmedSuffix}`;
}
