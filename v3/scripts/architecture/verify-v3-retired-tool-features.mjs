#!/usr/bin/env node
// V3 retired-tool-feature guard.
//
// Locks two retired features out of the active V3 tree:
//   * the abandoned Toolreason client projection / observation feature
//   * the retired RCC-only servertool crate, CLI projection, and search state
//
// The guard checks four independent surfaces: active source/build, config,
// structured maps/manifests, and CI wiring. It matches precise retired
// identifiers, not words such as `reason`, `thinking`, or `web_search`, so
// ordinary tools, ToolThinking, native reasoning, and hosted search stay legal.
//
// Explicit rejection code, negative fixtures, and historical tombstones are
// allowed by exact path or by the narrow identifier boundary documented below.
// There is no directory-wide allowlist.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const v3Root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const sourceRoot = process.env.ROUTECODEX_V3_SOURCE_ROOT
  ? path.resolve(process.env.ROUTECODEX_V3_SOURCE_ROOT)
  : path.resolve(v3Root, '..');

const failures = [];

function rel(absPath) {
  return path.relative(sourceRoot, absPath).split(path.sep).join('/');
}

function fail(message) {
  failures.push(message);
}

// Exact files that legitimately contain the retired identifiers:
// the guard itself and its own negative fixtures. No other exception exists.
const sourceAllowlist = new Set([
  'v3/scripts/architecture/verify-v3-retired-tool-features.mjs',
  'v3/scripts/tests/v3-retired-tool-features-red-fixtures.mjs',
  // The removedRoots protection below is the one retained reference to the
  // retired ad-hoc config path; it is asserted positively in checkConfig().
  'scripts/ci/repo-sanity.mjs',
  // The CI umbrella must name the guard and its fixtures; that wiring is the
  // positive contract checked in checkCiWiring(), not residue.
  'v3/scripts/architecture/verify-v3-architecture-ci.mjs',
]);

// Toolreason was a distinct feature owned by `toolreason`-named symbols. The
// retained ToolThinking contract never needs that name, so any occurrence in
// active source is residue.
const forbiddenSourcePatterns = [
  { pattern: /toolreason/iu, label: 'toolreason identifier' },
  // Servertool was retired; these precise symbols were its crate, CLI
  // projection, search sidecar, cross-turn state, and control actions.
  // `servertool_search_backend` / `metadata_center_local_search` are kept as
  // explicit compile-time rejections and are deliberately not listed here.
  { pattern: /\bservertool-core\b/u, label: 'servertool crate' },
  { pattern: /\bservertool_followup\b/u, label: 'servertool followup state' },
  { pattern: /\bservertool_cli\b/iu, label: 'servertool CLI projection' },
  { pattern: /\bplan_servertool_outcome_json\b/u, label: 'servertool outcome planner' },
  {
    pattern: /\brun_servertool_response_stage_json\b/u,
    label: 'servertool response stage runner',
  },
  { pattern: /\bExecuteWebSearch\b/u, label: 'servertool control action' },
  { pattern: /\bweb_search_sidecar\b/u, label: 'servertool sidecar' },
  { pattern: /\bweb_search_hop\b/u, label: 'servertool hop' },
  { pattern: /\bweb_search_hook_request\b/u, label: 'servertool hook request' },
  { pattern: /\bdirect_web_search\b/u, label: 'servertool direct search' },
  {
    pattern: /\bplan_provider_response_servertool_retirement_effect_json\b/u,
    label: 'retired servertool retirement-effect binding',
  },
];

function listFiles(root, { skipDirs = new Set(['node_modules', 'target', 'dist']) } = {}) {
  const out = [];
  if (!fs.existsSync(root)) return out;
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const abs = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (skipDirs.has(entry.name)) continue;
        stack.push(abs);
      } else if (entry.isFile()) {
        out.push(abs);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 1. Active source / build
// ---------------------------------------------------------------------------

const sourceRoots = [
  path.join(sourceRoot, 'v3', 'crates'),
  path.join(sourceRoot, 'v3', 'scripts'),
  path.join(sourceRoot, 'scripts'),
  path.join(sourceRoot, '.github', 'workflows'),
];

const sourceExtensions = new Set(['.rs', '.mjs', '.js', '.cjs', '.toml', '.yml', '.yaml']);

function checkSource() {
  for (const root of sourceRoots) {
    for (const abs of listFiles(root)) {
      const ext = path.extname(abs).toLowerCase();
      if (!sourceExtensions.has(ext) && path.basename(abs) !== 'Cargo.toml' && path.basename(abs) !== 'package.json') {
        continue;
      }
      const relative = rel(abs);
      if (sourceAllowlist.has(relative)) continue;
      // The V3 tree is the active contract. V4 has its own governance and its
      // own retirement decisions, so it is never in these roots.
      if (relative.startsWith('v4/')) continue;
      let text;
      try {
        text = fs.readFileSync(abs, 'utf8');
      } catch (error) {
        fail(`${relative}: unreadable (${error.message})`);
        continue;
      }
      for (const { pattern, label } of forbiddenSourcePatterns) {
        const match = pattern.exec(text);
        if (match) {
          const line = text.slice(0, match.index).split('\n').length;
          fail(`${relative}:${line}: ${label} reintroduced (${match[0]})`);
        }
      }
    }
  }

  for (const relative of ['v3/Cargo.toml', 'v3/package.json']) {
    const abs = path.join(sourceRoot, relative);
    if (!fs.existsSync(abs)) continue;
    const text = fs.readFileSync(abs, 'utf8');
    for (const { pattern, label } of forbiddenSourcePatterns) {
      const match = pattern.exec(text);
      if (match) {
        const line = text.slice(0, match.index).split('\n').length;
        fail(`${relative}:${line}: ${label} reintroduced (${match[0]})`);
      }
    }
  }

  // Retired manifest must not exist as an active manifest again.
  const retiredManifest = path.join(
    sourceRoot,
    'docs',
    'architecture',
    'manifests',
    'v3.hub_relay.tool_servertool_multiturn_parity.mainline.yml',
  );
  if (fs.existsSync(retiredManifest)) {
    fail(
      'docs/architecture/manifests/v3.hub_relay.tool_servertool_multiturn_parity.mainline.yml: retired active manifest restored',
    );
  }
}

// ---------------------------------------------------------------------------
// 2. Config
// ---------------------------------------------------------------------------

function checkConfig() {
  const internalToml = path.join(
    sourceRoot,
    'v3',
    'crates',
    'routecodex-v3-config',
    'src',
    'internal.toml',
  );
  if (!fs.existsSync(internalToml)) {
    fail('v3/crates/routecodex-v3-config/src/internal.toml: missing');
  } else {
    const text = fs.readFileSync(internalToml, 'utf8');
    if (/toolreason/iu.test(text)) {
      fail('v3/crates/routecodex-v3-config/src/internal.toml: retired toolreason feature key restored');
    }
    // The bounded refill strategy remains the only chat-process continuation
    // config; its single source must stay in this file.
    if (!/\[chat_process\.refill\]\s*\nmax_consecutive_refills\s*=\s*1/u.test(text)) {
      fail('v3/crates/routecodex-v3-config/src/internal.toml: bounded refill config changed or removed');
    }
  }

  // `metadata_center_local_search` / `servertool_search_backend` must remain
  // explicit compile-time rejections rather than executable backends.
  const typesRs = path.join(
    sourceRoot,
    'v3',
    'crates',
    'routecodex-v3-config',
    'src',
    'types.rs',
  );
  if (!fs.existsSync(typesRs)) {
    fail('v3/crates/routecodex-v3-config/src/types.rs: missing');
  } else {
    const text = fs.readFileSync(typesRs, 'utf8');
    for (const retired of ['metadata_center_local_search', 'servertool_search_backend']) {
      if (!new RegExp(`"${retired}"`, 'u').test(text)) {
        fail(`v3/crates/routecodex-v3-config/src/types.rs: explicit rejection label ${retired} removed`);
      }
    }
  }

  // The retired ad-hoc Toolreason config file stays on the forbidden-root list.
  const repoSanity = path.join(sourceRoot, 'scripts', 'ci', 'repo-sanity.mjs');
  if (!fs.existsSync(repoSanity)) {
    fail('scripts/ci/repo-sanity.mjs: missing');
  } else if (!/['"]config\.toolreason-10000\.toml['"]/u.test(fs.readFileSync(repoSanity, 'utf8'))) {
    fail('scripts/ci/repo-sanity.mjs: removedRoots protection for config.toolreason-10000.toml removed');
  }
}

// ---------------------------------------------------------------------------
// 3. Structured maps / manifests
// ---------------------------------------------------------------------------

const structuredFiles = [
  'docs/architecture/v3-function-map.yml',
  'docs/architecture/v3-resource-operation-map.yml',
  'docs/architecture/v3-mainline-call-map.yml',
  'docs/architecture/v3-verification-map.yml',
  'docs/architecture/function-map.yml',
  'docs/architecture/resource-operation-map.yml',
  'docs/architecture/mainline-call-map.yml',
  'docs/architecture/verification-map.yml',
  'docs/architecture/v3-architecture-audit-locks.yml',
  'docs/architecture/mainline-binding-budget.yml',
  'docs/architecture/no-fallback-diff-rules.json',
];

const structuredTokens = [
  /toolreason/iu,
  /\bservertool_followup\b/u,
  /\bservertool\.followup\b/u,
  /\bservertool-core\b/u,
  /\bservertool_center\b/u,
  /\bv3\.servertool_hook_skeleton_lifecycle\b/u,
  /\bv3\.hub_relay\.tool_servertool_multiturn_parity\b/u,
  /\bplan_servertool_outcome_json\b/u,
  /\brun_servertool_response_stage_json\b/u,
  /\bplan_provider_response_servertool_retirement_effect_json\b/u,
  /\bweb_search_sidecar\b/u,
  /\bweb_search_hop\b/u,
  /\bweb_search_hook_request\b/u,
  /\bdirect_web_search\b/u,
  /\bExecuteWebSearch\b/u,
];

function walkStructured(value, location, visit) {
  if (typeof value === 'string') {
    visit(value, location);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((child, index) => walkStructured(child, `${location}[${index}]`, visit));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      visit(key, `${location}${location ? '.' : ''}${key}`);
      walkStructured(child, `${location}${location ? '.' : ''}${key}`, visit);
    }
  }
}

function parseStructured(absPath) {
  const text = fs.readFileSync(absPath, 'utf8');
  if (absPath.endsWith('.json')) return JSON.parse(text);
  return YAML.parse(text);
}

function checkStructured() {
  const allStructured = [...structuredFiles];
  const manifestDir = path.join(sourceRoot, 'docs', 'architecture', 'manifests');
  if (fs.existsSync(manifestDir)) {
    for (const entry of fs.readdirSync(manifestDir)) {
      if (entry.endsWith('.yml') || entry.endsWith('.yaml') || entry.endsWith('.json')) {
        allStructured.push(`docs/architecture/manifests/${entry}`);
      }
    }
  }
  for (const relative of allStructured) {
    const abs = path.join(sourceRoot, relative);
    if (!fs.existsSync(abs)) {
      if (structuredFiles.includes(relative)) fail(`${relative}: missing`);
      continue;
    }
    let document;
    try {
      document = parseStructured(abs);
    } catch (error) {
      fail(`${relative}: structured parse failed (${error.message})`);
      continue;
    }
    walkStructured(document, '', (text, location) => {
      for (const token of structuredTokens) {
        if (token.test(text)) {
          fail(`${relative}: retired feature active binding at ${location || '<root>'} (${text.slice(0, 120)})`);
          return;
        }
      }
    });
  }
}

// ---------------------------------------------------------------------------
// 4. CI wiring
// ---------------------------------------------------------------------------

function checkCiWiring() {
  const packageJsonPath = path.join(sourceRoot, 'v3', 'package.json');
  if (!fs.existsSync(packageJsonPath)) {
    fail('v3/package.json: missing');
    return;
  }
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  const scripts = packageJson.scripts ?? {};
  const expected = {
    'verify:v3-retired-tool-features':
      'node scripts/architecture/verify-v3-retired-tool-features.mjs',
    'test:v3-retired-tool-features-red-fixtures':
      'node scripts/tests/v3-retired-tool-features-red-fixtures.mjs',
  };
  for (const [name, command] of Object.entries(expected)) {
    if (scripts[name] !== command) {
      fail(`v3/package.json: script ${name} missing or changed (${scripts[name] ?? '<missing>'})`);
    }
  }

  const umbrellaPath = path.join(
    sourceRoot,
    'v3',
    'scripts',
    'architecture',
    'verify-v3-architecture-ci.mjs',
  );
  if (!fs.existsSync(umbrellaPath)) {
    fail('v3/scripts/architecture/verify-v3-architecture-ci.mjs: missing');
    return;
  }
  const umbrella = fs.readFileSync(umbrellaPath, 'utf8');
  for (const gate of ['verify:v3-retired-tool-features', 'test:v3-retired-tool-features-red-fixtures']) {
    if (!umbrella.includes(`'${gate}'`)) {
      fail(`v3/scripts/architecture/verify-v3-architecture-ci.mjs: ${gate} removed from umbrella`);
    }
  }

  // The guard scripts themselves must exist on disk.
  for (const script of Object.values(expected)) {
    const relative = script.replace(/^node\s+/u, '');
    if (!fs.existsSync(path.join(sourceRoot, 'v3', relative))) {
      fail(`v3/${relative}: guard script missing`);
    }
  }
}

checkSource();
checkConfig();
checkStructured();
checkCiWiring();

if (failures.length > 0) {
  console.error(`[verify:v3-retired-tool-features] failed (${failures.length} finding(s))`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('[verify:v3-retired-tool-features] ok');
