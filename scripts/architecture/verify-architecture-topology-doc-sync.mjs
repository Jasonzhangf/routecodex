// Topology doc-sync gate.
// Source of truth = docs/design/pipeline-type-topology-and-module-boundaries.md
// For every <Module><Phase><NN><Node> node declared in that doc, the node id
// must appear in at least one of: docs/architecture/mainline-call-map.yml,
// docs/architecture/metadata-center-manifest.yml, or docs/architecture/wiki/*.
// This locks the topology document against drift from the call map / manifest /
// wiki review surface without depending on code type declarations (which use
// host-native names, not the topology node ids). Current known gaps are locked
// in docs/architecture/topology-sync-manifest.yml; any growth or stale debt
// entry now fails fast.
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

const root = process.cwd();
const docPath = path.join(root, 'docs/design/pipeline-type-topology-and-module-boundaries.md');
const mainlinePath = path.join(root, 'docs/architecture/mainline-call-map.yml');
const manifestPath = path.join(root, 'docs/architecture/metadata-center-manifest.yml');
const debtManifestPath = path.join(root, 'docs/architecture/topology-sync-manifest.yml');
const wikiDir = path.join(root, 'docs/architecture/wiki');

const docText = fs.readFileSync(docPath, 'utf8');
const NODE_PATTERNS = [
  /\bServer(?:ReqInbound|RespOutbound)\d{2}[A-Z][A-Za-z0-9]*/g,
  /\bHub(?:ReqInbound|ReqChatProcess|ReqOutbound|RespInbound|RespChatProcess|RespOutbound)\d{2}[A-Z][A-Za-z0-9]*/g,
  /\bVr(?:Route)\d{2}[A-Z][A-Za-z0-9]*/g,
  /\bProvider(?:ReqOutbound|RespInbound)\d{2}[A-Z][A-Za-z0-9]*/g,
  /\bError(?:Err)\d{2}[A-Z][A-Za-z0-9]*/g,
  /\bMeta(?:Req|Resp|Meta|Route)\d{2}[A-Z][A-Za-z0-9]*/g,
];

const declared = new Set();
for (const pat of NODE_PATTERNS) {
  for (const m of docText.matchAll(pat)) declared.add(m[0]);
}

const sources = [];
for (const rel of [mainlinePath, manifestPath, ...fs.readdirSync(wikiDir).map((f) => path.join(wikiDir, f))]) {
  if (!fs.existsSync(rel)) continue;
  const stat = fs.statSync(rel);
  if (stat.isFile()) sources.push({ path: rel, text: fs.readFileSync(rel, 'utf8') });
}

const missing = [];
let seen = 0;
for (const nodeId of declared) {
  let hit = null;
  for (const src of sources) {
    if (src.text.includes(nodeId)) { hit = path.relative(root, src.path); break; }
  }
  if (hit) {
    seen += 1;
  } else {
    missing.push(nodeId);
  }
}

if (!fs.existsSync(debtManifestPath)) {
  console.error('[verify:architecture-topology-doc-sync] failed');
  console.error(`- missing debt manifest: ${path.relative(root, debtManifestPath)}`);
  process.exit(1);
}

let debtManifest;
try {
  debtManifest = YAML.parse(fs.readFileSync(debtManifestPath, 'utf8'));
} catch (err) {
  console.error('[verify:architecture-topology-doc-sync] failed');
  console.error(`- invalid YAML in ${path.relative(root, debtManifestPath)}: ${err.message}`);
  process.exit(1);
}

const expectedDeclared = Number(debtManifest?.declared_node_count);
const expectedReferenced = Number(debtManifest?.referenced_node_count);
const allowedMissing = new Set(
  Array.isArray(debtManifest?.allowed_unreferenced_nodes)
    ? debtManifest.allowed_unreferenced_nodes.filter((entry) => typeof entry === 'string' && entry.trim())
    : []
);

const failures = [];
if (Number.isFinite(expectedDeclared) && declared.size !== expectedDeclared) {
  failures.push(`declared node count ${declared.size} != manifest ${expectedDeclared}`);
}
if (Number.isFinite(expectedReferenced) && seen !== expectedReferenced) {
  failures.push(`referenced node count ${seen} != manifest ${expectedReferenced}`);
}

for (const nodeId of missing) {
  if (!allowedMissing.has(nodeId)) {
    failures.push(`new unreferenced topology node not budgeted: ${nodeId}`);
  }
}
for (const nodeId of allowedMissing) {
  if (!declared.has(nodeId)) {
    failures.push(`manifest allowlist entry no longer declared in topology doc: ${nodeId}`);
    continue;
  }
  if (!missing.includes(nodeId)) {
    failures.push(`manifest allowlist entry is now referenced and must be removed: ${nodeId}`);
  }
}

if (failures.length > 0) {
  console.error('[verify:architecture-topology-doc-sync] failed');
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  console.error(`- debt manifest: ${path.relative(root, debtManifestPath)}`);
  process.exit(1);
}

console.log('[verify:architecture-topology-doc-sync] ok');
console.log(`- debt manifest: ${path.relative(root, debtManifestPath)}`);
console.log(`- topology doc declared: ${declared.size} nodes`);
console.log(`- referenced by call-map / manifest / wiki: ${seen}`);
console.log(`- declared but unreferenced (locked debt): ${missing.length}`);
for (const nodeId of missing) {
  console.log(`  - ${nodeId}`);
}
