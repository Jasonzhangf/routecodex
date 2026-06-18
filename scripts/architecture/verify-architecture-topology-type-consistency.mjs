/**
 * verify-architecture-topology-type-consistency
 *
 * Checks that formally defined mainline pipeline node types are consistent
 * between topology doc and call map.
 *
 * Recognizes:
 * - H3 section header nodes (must be in call map or marked topology-only)
 * - Table cell nodes (auto-registered)
 * - shared_multi_reference_functions symbols (auto-registered)
 * - Source type declarations must be registered somewhere.
 */
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

const root = process.cwd();

// ── 1. Extract registered topology nodes from doc ────────────────────────────────
const topologyPath = path.join(root, 'docs/design/pipeline-type-topology-and-module-boundaries.md');
const topologyText = fs.existsSync(topologyPath) ? fs.readFileSync(topologyPath, 'utf8') : '';
const topoLines = topologyText.split('\n');

const registeredTopologyNodes = new Set();
const topologyOnlyNodes = new Set();

const sectionHeaderPattern = /^### \d+\.\d+\s+([A-Z][a-z]+(?:[A-Z][a-z0-9]*)*\d{2}[A-Z][a-z]+(?:[A-Z][a-z0-9]*)*)/;

for (let i = 0; i < topoLines.length; i++) {
  const line = topoLines[i];
  const hdrMatch = line.match(sectionHeaderPattern);
  if (hdrMatch) {
    registeredTopologyNodes.add(hdrMatch[1]);
    for (let j = i + 1; j <= Math.min(i + 5, topoLines.length - 1); j++) {
      if (topoLines[j].includes('topology-only')) {
        topologyOnlyNodes.add(hdrMatch[1]);
        break;
      }
    }
  }
  const tableMatch = line.match(/`([A-Z][a-z]+(?:[A-Z][a-z]*)*\d{2}[A-Z][a-z]+(?:[A-Z][a-z0-9]*)*)`/);
  if (tableMatch) registeredTopologyNodes.add(tableMatch[1]);
}

// ── 2. Extract call-map nodes + shared function symbols ──────────────────────
const mainlinePath = path.join(root, 'docs/architecture/mainline-call-map.yml');
const mainline = YAML.parse(fs.readFileSync(mainlinePath, 'utf8'));

const callMapNodes = new Set();
for (const chain of (mainline?.chains ?? [])) {
  for (const edge of (chain?.edges ?? [])) {
    if (edge?.from_node) callMapNodes.add(edge.from_node);
    if (edge?.to_node) callMapNodes.add(edge.to_node);
  }
}

const callMapSymbols = new Set(); // symbol names from edges + shared functions + split bindings
for (const chain of (mainline?.chains ?? [])) {
  for (const edge of (chain?.edges ?? [])) {
    if (edge?.caller_symbol) callMapSymbols.add(edge.caller_symbol);
    if (edge?.callee_symbol) callMapSymbols.add(edge.callee_symbol);
  }
}
for (const sf of (mainline?.shared_multi_reference_functions ?? [])) {
  if (sf?.symbol) callMapSymbols.add(sf.symbol);
  if (sf?.file) callMapSymbols.add(sf.file);
  // Also add the function_id as a registered name
  if (sf?.function_id) registeredTopologyNodes.add(sf.function_id);
}
for (const sb of (mainline?.split_bindings ?? [])) {
  for (const rs of (sb?.runtime_symbols ?? [])) {
    if (rs?.symbol) callMapSymbols.add(rs.symbol);
  }
  for (const ts of (sb?.typed_symbols ?? [])) {
    if (ts?.symbol) callMapSymbols.add(ts.symbol);
  }
}

// ── 3. Check: H3 section nodes must be in call map ───────────────────────────
const failures = [];

for (const nodeName of registeredTopologyNodes) {
  if (topologyOnlyNodes.has(nodeName)) continue;
  const isSectionHeader = topoLines.some(l => {
    const m = l.match(sectionHeaderPattern);
    return m && m[1] === nodeName;
  });
  if (isSectionHeader && !callMapNodes.has(nodeName)) {
    failures.push(`topology section '${nodeName}' not in mainline-call-map.yml`);
  }
}

// ── 4. Scan source for unregistered pipeline types ────────────────────────────
const typePattern = /\b(?:type|interface)\s+([A-Z][a-z]+(?:[A-Z][a-z0-9]*)*\d{2}[A-Z][a-z]+(?:[A-Z][a-z0-9]*)*)\b/g;
const srcDirs = ['src', 'sharedmodule/llmswitch-core/src'];
const unregisteredTypes = [];

const walk = (dir) => {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory() && !/^(\.|node_modules|dist|target|coverage|test-result)/.test(entry.name)) {
        walk(full);
      } else if (entry.isFile() && /\.(ts|js|mjs)$/.test(entry.name)) {
        const content = fs.readFileSync(full, 'utf8');
        let n;
        while ((n = typePattern.exec(content)) !== null) {
          const tname = n[1];
          if (!registeredTopologyNodes.has(tname) &&
              !callMapNodes.has(tname) &&
              !callMapSymbols.has(tname) &&
              !topologyOnlyNodes.has(tname) &&
              !/^(native\.|error\.|runtime\.)/.test(tname)) {
            unregisteredTypes.push(`${path.relative(root, full)}: ${tname}`);
          }
        }
      }
    }
  } catch (_) {}
};

for (const srcDir of srcDirs) {
  const absSrcDir = path.join(root, srcDir);
  if (fs.existsSync(absSrcDir)) walk(absSrcDir);
}

for (const u of unregisteredTypes) {
  failures.push(`unregistered pipeline type in source: ${u}`);
}

if (failures.length > 0) {
  console.error('[verify:architecture-topology-type-consistency] failed');
  for (const f of failures) console.error(`- ${f}`);
  process.exit(1);
}

console.log('[verify:architecture-topology-type-consistency] ok');
console.log(`- ${registeredTopologyNodes.size} registered topology nodes`);
console.log(`- ${topologyOnlyNodes.size} marked topology-only`);
console.log(`- ${callMapNodes.size} call map nodes + ${callMapSymbols.size} registered symbols`);
