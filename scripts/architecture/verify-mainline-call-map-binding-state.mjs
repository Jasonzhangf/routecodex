/**
 * verify-mainline-call-map-binding-state
 *
 * Checks:
 * 1. Every shared_multi_reference_functions entry has a binding_status field.
 * 2. binding_status values are one of: confirmed | pending | partial
 * 3. The number of "pending" entries does not exceed MAX_PENDING threshold (default 3).
 *    Entries above threshold are listed; if exactly at threshold, a warning is printed.
 */
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

const root = process.cwd();
const mainlinePath = path.join(root, 'docs/architecture/mainline-call-map.yml');
const MAX_PENDING = 3;

const mainline = YAML.parse(fs.readFileSync(mainlinePath, 'utf8'));
const sharedFns = mainline?.shared_multi_reference_functions ?? [];

const failures = [];
const warnings = [];

const VALID_STATUSES = new Set(['confirmed', 'pending', 'partial']);
let pendingCount = 0;

for (const fn of sharedFns) {
  const fnId = fn?.function_id ?? '(anonymous)';
  const status = fn?.binding_status;

  if (status === undefined || status === null) {
    failures.push(`shared function '${fnId}': missing binding_status field (add binding_status: confirmed|pending|partial)`);
    continue;
  }
  if (!VALID_STATUSES.has(status)) {
    failures.push(`shared function '${fnId}': invalid binding_status '${status}' (must be confirmed|pending|partial)`);
    continue;
  }
  if (status === 'pending') pendingCount++;
}

if (pendingCount > MAX_PENDING) {
  failures.push(`shared function pending count ${pendingCount} exceeds threshold ${MAX_PENDING}`);
} else if (pendingCount === MAX_PENDING) {
  warnings.push(`shared function pending count is at threshold ${MAX_PENDING}; review binding pending entries soon`);
} else if (pendingCount > 0) {
  warnings.push(`shared function pending count: ${pendingCount} (threshold ${MAX_PENDING})`);
}

// Also check split_bindings have binding_status
const splitBindings = mainline?.split_bindings ?? [];
for (const sb of splitBindings) {
  const bid = sb?.binding_id ?? '(anonymous)';
  const status = sb?.binding_status;
  if (status === undefined || status === null) {
    failures.push(`split_binding '${bid}': missing binding_status field`);
    continue;
  }
  if (!VALID_STATUSES.has(status)) {
    failures.push(`split_binding '${bid}': invalid binding_status '${status}'`);
  }
  if (status === 'pending') pendingCount++;
}

if (pendingCount > MAX_PENDING) {
  failures.push(`total binding pending count (shared + split) ${pendingCount} exceeds threshold ${MAX_PENDING}`);
}

if (failures.length > 0) {
  console.error('[verify-mainline-call-map-binding-state] failed');
  for (const f of failures) console.error(`- ${f}`);
  process.exit(1);
}

if (warnings.length > 0) {
  console.warn('[verify-mainline-call-map-binding-state] ok with warnings');
  for (const w of warnings) console.warn(`- ${w}`);
} else {
  console.log('[verify-mainline-call-map-binding-state] ok');
}
console.log(`- ${sharedFns.length} shared functions + ${splitBindings.length} split_bindings checked`);
console.log(`- pending count: ${pendingCount} / threshold: ${MAX_PENDING}`);
