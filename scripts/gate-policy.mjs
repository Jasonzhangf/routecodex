export const GATE_SEVERITY = Object.freeze({
  BLOCK: 'BLOCK',
  WARN: 'WARN',
});

const VALID_SEVERITIES = new Set(Object.values(GATE_SEVERITY));

export function severityForGate(entry = {}) {
  if (entry.severity === undefined) {
    throw new TypeError('gate severity must be explicitly declared as BLOCK or WARN');
  }
  const severity = entry.severity;
  if (!VALID_SEVERITIES.has(severity)) {
    throw new TypeError(`invalid gate severity: ${severity}`);
  }
  return severity;
}
