export const GATE_SEVERITY = Object.freeze({
  BLOCK: 'BLOCK',
  WARN: 'WARN',
});

const VALID_SEVERITIES = new Set(Object.values(GATE_SEVERITY));

export function severityForGate(entry = {}) {
  const severity = entry.severity ?? GATE_SEVERITY.BLOCK;
  if (!VALID_SEVERITIES.has(severity)) {
    throw new TypeError(`invalid gate severity: ${severity}`);
  }
  return severity;
}
