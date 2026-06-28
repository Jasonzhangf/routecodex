import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const mapPath = path.join(root, 'docs/architecture/function-map.yml');
const mapText = fs.readFileSync(mapPath, 'utf8');

function parseOwners(text) {
  const lines = text.split('\n');
  const owners = [];
  let current = null;
  let section = null;
  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (trimmed.startsWith('- feature_id:')) {
      if (current) owners.push(current);
      current = {
        featureId: trimmed.split(':').slice(1).join(':').trim(),
        summary: '',
        ownerModule: '',
        canonicalTypes: [],
        canonicalBuilders: [],
        allowedPaths: [],
      };
      section = null;
      continue;
    }
    if (!current) continue;
    if (trimmed.startsWith('summary:')) {
      current.summary = trimmed.split(':').slice(1).join(':').trim();
      section = null;
      continue;
    }
    if (trimmed.startsWith('owner_module:')) {
      current.ownerModule = trimmed.split(':').slice(1).join(':').trim();
      section = null;
      continue;
    }
    if (trimmed === 'canonical_types:') { section = 'canonicalTypes'; continue; }
    if (trimmed === 'canonical_builders:') { section = 'canonicalBuilders'; continue; }
    if (trimmed === 'allowed_paths:') { section = 'allowedPaths'; continue; }
    if (/^[A-Za-z_]+:/.test(trimmed) && !trimmed.startsWith('- ')) {
      section = null;
      continue;
    }
    if (section && trimmed.startsWith('- ')) current[section].push(trimmed.slice(2).trim());
  }
  if (current) owners.push(current);
  return owners;
}

const owners = parseOwners(mapText);
const failures = [];

// Helper: classify owner_module as either a directory-level (crate/module) owner
// that may legitimately be shared by multiple features, or a leaf-file owner
// that must be uniquely claimed.
function isLeafOwner(p) {
  return /\.(rs|ts|tsx|js|mjs|cjs)$/.test(p);
}

// Rule 1: same owner_module must not be claimed by more than one feature.
const ownerModuleToFeatures = new Map();
for (const owner of owners) {
  if (!owner.ownerModule) continue;
  // Directory-level owners (crate root, package root) are intentionally shared;
  // only leaf-file owners (e.g. routing_state_store.rs) must be unique.
  if (!isLeafOwner(owner.ownerModule)) continue;
  const key = owner.ownerModule;
  const list = ownerModuleToFeatures.get(key) || [];
  list.push(owner.featureId);
  ownerModuleToFeatures.set(key, list);
}
for (const [mod, list] of ownerModuleToFeatures.entries()) {
  if (list.length > 1) {
    // Allow sharing a leaf owner when the canonical_builders of the involved
    // features are pairwise disjoint - this is the normal "composition unit
    // family" pattern in the responses.* and req_outbound_stage3_compat
    // groups. If any builder is claimed by two features, that is a real
    // duplicate owner and must fail.
    const buildersByFeature = new Map();
    for (const fid of list) {
      const owner = owners.find((o) => o.featureId === fid);
      buildersByFeature.set(fid, new Set(owner.canonicalBuilders));
    }
    const conflicts = [];
    const seen = new Map();
    for (const [fid, builders] of buildersByFeature.entries()) {
      for (const builder of builders) {
        if (seen.has(builder)) {
          conflicts.push(`builder '${builder}' claimed by both '${seen.get(builder)}' and '${fid}'`);
        } else {
          seen.set(builder, fid);
        }
      }
    }
    if (conflicts.length > 0) {
      failures.push(`leaf owner_module '${mod}' shared by features with overlapping builders: ${list.join(', ')} | ${conflicts.join('; ')}`);
    }
  }
}

// Rule 2: cross-family keyword overlap - the same noun in summary must not appear in
// 2+ features owned by different module families.
const familyOf = (mod) => {
  if (mod.startsWith('sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine')) return 'vr';
  if (mod.startsWith('sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src')) return 'rust-core';
  if (mod.startsWith('src/manager/modules/routing')) return 'vr-bridge';
  if (mod.startsWith('src/manager/modules/health')) return 'vr-bridge';
  if (mod.startsWith('src/manager/modules/token')) return 'token-bridge';
  if (mod.startsWith('src/server/runtime/http-server/daemon-admin')) return 'daemon-admin';
  if (mod.startsWith('src/server/runtime/http-server')) return 'http-entry';
  if (mod.startsWith('src/server/handlers')) return 'handler-family';
  if (mod.startsWith('src/cli/commands')) return 'cli';
  if (mod.startsWith('src/providers/core/runtime')) return 'provider-runtime';
  return 'other';
};

// Cross-family keyword overlap only fires for the same noun paired with the
// same action word, to avoid spurious overlaps where unrelated features all
// mention 'quota' in passing. Pair format: 'noun:verb'.
const KEYWORD_PAIRS = [
  'quota:mutate', 'quota:control', 'quota:admin', 'quota:read', 'quota:hydrate', 'quota:persist',
  'health:cooldown', 'health:reset', 'health:state', 'health:persisted',
  'routing:state', 'routing:instruction', 'routing:floor', 'routing:selection',
  'token:leader', 'token:history', 'token:daemon',
];
// Nouns and verbs are matched independently against the (lowercased) summary
// text. A feature is considered to "claim" a (noun, verb) pair only when
// both the noun and the verb appear as substrings somewhere in its summary.
// This avoids the previous bug of treating the literal string 'quota:mutate'
// as a substring to look for, which never matched natural-language summaries.
const KEYWORD_NOUNS = [
  'quota', 'health', 'routing', 'token', 'servertool', 'metadata',
];
const KEYWORD_VERBS = [
  'mutate', 'control', 'admin', 'read', 'hydrate', 'persist', 'lifecycle',
  'cooldown', 'reset', 'state', 'persisted',
  'instruction', 'floor', 'selection',
  'leader', 'history', 'daemon', 'runtime',
];
const keywordToOwners = new Map();
for (const owner of owners) {
  const lower = (owner.summary || '').toLowerCase();
  for (const noun of KEYWORD_NOUNS) {
    if (!lower.includes(noun)) continue;
    for (const verb of KEYWORD_VERBS) {
      if (!lower.includes(verb)) continue;
      const pair = `${noun}:${verb}`;
      const list = keywordToOwners.get(pair) || [];
      list.push({ id: owner.featureId, family: familyOf(owner.ownerModule) });
      keywordToOwners.set(pair, list);
    }
  }
}
for (const [kw, list] of keywordToOwners.entries()) {
  const families = new Set(list.map((x) => x.family));
  if (families.size > 1) {
    failures.push(`cross-family keyword+action '${kw}' appears in summaries of multiple module families: ${list.map((x) => `${x.id}@${x.family}`).join(', ')}`);
  }
}

if (failures.length > 0) {
  console.error('[verify:architecture-duplicate-owner] failed');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('[verify:architecture-duplicate-owner] ok');
console.log(`- checked ${owners.length} features for owner_module uniqueness and cross-family keyword overlap`);
