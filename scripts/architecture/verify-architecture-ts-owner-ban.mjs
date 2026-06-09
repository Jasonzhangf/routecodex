import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const mapPath = path.join(root, 'docs/architecture/function-map.yml');
const mapText = fs.readFileSync(mapPath, 'utf8');

// Whitelist of feature_ids whose owner_module is allowed to be a TS shell or TS-only
// module family. Everything else whose owner_module lives in `src/` (TypeScript)
// must be considered a high-risk owner drift and fail-fast.
const TS_OWNER_WHITELIST = new Set([
  'snapshot.stage_contract', // src/utils is the only allowed TS owner for snapshot stage selector
  'error.provider_failure_policy', // provider runtime catalog/classification truth, with policy applied in Rust VR
  'error.backoff_action_queue', // host-side blocking wait executor; fixed policy is mapped and migration target remains Rust
  'daemon_admin.command_handlers', // HTTP handler projection shell
  'server.http_runtime_entry', // HTTP entry shell
  'server.responses_handler_family', // handler family projection shell
  'cli.command_surface', // CLI dispatch shell
  'manager.token_runtime', // token-daemon is the unique owner; no Rust twin
  'quota.unified_control_surface', // control surface bridge over Rust host
  'manager.quota_lifecycle', // lifecycle bridge over TS provider-quota-center
]);

function parseOwners(text) {
  const lines = text.split('\n');
  const owners = [];
  let current = null;
  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (trimmed.startsWith('- feature_id:')) {
      if (current) owners.push(current);
      current = {
        featureId: trimmed.split(':').slice(1).join(':').trim(),
        ownerModule: '',
      };
      continue;
    }
    if (!current) continue;
    if (trimmed.startsWith('owner_module:')) {
      current.ownerModule = trimmed.split(':').slice(1).join(':').trim();
    }
  }
  if (current) owners.push(current);
  return owners;
}

const owners = parseOwners(mapText);
const failures = [];

for (const owner of owners) {
  if (!owner.ownerModule.startsWith('src/')) continue;
  if (TS_OWNER_WHITELIST.has(owner.featureId)) continue;
  failures.push(`${owner.featureId}: owner_module '${owner.ownerModule}' lives in TypeScript; only whitelisted TS shells are allowed.`);
}

if (failures.length > 0) {
  console.error('[verify:architecture-ts-owner-ban] failed');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('[verify:architecture-ts-owner-ban] ok');
console.log(`- checked ${owners.length} features; ${TS_OWNER_WHITELIST.size} TS owners explicitly whitelisted`);
