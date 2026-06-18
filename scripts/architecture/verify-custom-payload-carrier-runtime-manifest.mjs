import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

const repoRoot = process.cwd();

const manifestPath = 'docs/architecture/custom-payload-carrier-runtime-manifest.yml';
const runtimeScanRoots = [
  'src',
  'sharedmodule/llmswitch-core/src',
  'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src',
];

const skipDirNames = new Set([
  '.git',
  'coverage',
  'dist',
  'node_modules',
  'target',
]);

const allowedExtensions = new Set([
  '.js',
  '.mjs',
  '.rs',
  '.ts',
  '.tsx',
]);

const groups = [
  {
    id: 'routecodex_prefix',
    title: '__routecodex* runtime manifest',
    regex: /__routecodex[A-Za-z0-9_]*/g,
  },
  {
    id: 'response_metadata',
    title: 'response.metadata runtime manifest',
    regex: /\bresponse\.metadata\b/g,
  },
];

function walk(dir, files = []) {
  if (!fs.existsSync(dir)) {
    return files;
  }
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (skipDirNames.has(entry.name)) {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, files);
      continue;
    }
    if (entry.isFile() && allowedExtensions.has(path.extname(entry.name))) {
      files.push(full);
    }
  }
  return files;
}

function normalizeRel(input) {
  return String(input || '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

const manifest = YAML.parse(fs.readFileSync(path.join(repoRoot, manifestPath), 'utf8'));
const allowedCategories = new Set(Array.isArray(manifest.allowed_categories) ? manifest.allowed_categories : []);
const allowedResolutionTracks = new Set(
  Array.isArray(manifest.allowed_resolution_tracks) ? manifest.allowed_resolution_tracks : []
);
const allowedSemanticFamilies = new Set(
  Array.isArray(manifest.allowed_semantic_families) ? manifest.allowed_semantic_families : []
);
const categoryResolutionTracks = new Map(
  Object.entries(manifest.category_resolution_tracks && typeof manifest.category_resolution_tracks === 'object'
    ? manifest.category_resolution_tracks
    : {})
);
const allowedOwnerQueryability = new Set(Array.isArray(manifest.allowed_owner_queryability) ? manifest.allowed_owner_queryability : []);
const allowedVerificationState = new Set(Array.isArray(manifest.allowed_verification_state) ? manifest.allowed_verification_state : []);
const manifestGroups = new Map(
  (Array.isArray(manifest.carrier_runtime_surfaces) ? manifest.carrier_runtime_surfaces : []).map((group) => [group.carrier_id, group])
);

const functionMap = YAML.parse(fs.readFileSync(path.join(repoRoot, 'docs/architecture/function-map.yml'), 'utf8'));
const verificationMap = YAML.parse(fs.readFileSync(path.join(repoRoot, 'docs/architecture/verification-map.yml'), 'utf8'));

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function resolvePrimaryOwnerMatches(relFile, owners) {
  const matches = owners.filter((owner) => owner.ownerModule && pathMatch(owner.ownerModule, relFile));
  if (matches.length === 0) {
    return [];
  }
  const maxLength = Math.max(...matches.map((owner) => owner.ownerModule.length));
  return matches.filter((owner) => owner.ownerModule.length === maxLength);
}

function pathMatch(candidate, target) {
  const normalizedCandidate = normalizeRel(candidate);
  const normalizedTarget = normalizeRel(target);
  if (!normalizedCandidate || !normalizedTarget) {
    return false;
  }
  return normalizedTarget === normalizedCandidate || normalizedTarget.startsWith(`${normalizedCandidate}/`);
}

const functionOwners = toArray(functionMap.owners).map((owner) => ({
  featureId: owner.feature_id,
  ownerModule: normalizeRel(owner.owner_module),
}));
const functionOwnerIds = new Set(functionOwners.map((owner) => owner.featureId));

const verificationOwners = toArray(verificationMap.verification).map((feature) => ({
  featureId: feature.feature_id,
  paths: [
    ...toArray(feature.unit),
    ...toArray(feature.contract),
    ...toArray(feature.integration),
  ].map(normalizeRel).filter(Boolean),
}));

function ownerStateFor(relFile) {
  const matches = resolvePrimaryOwnerMatches(relFile, functionOwners);
  if (matches.length === 0) {
    return 'missing-owner';
  }
  if (matches.length === 1) {
    return 'unique-owner';
  }
  return 'ambiguous-owner';
}

function verificationStateFor(relFile) {
  for (const feature of verificationOwners) {
    if (feature.paths.some((candidate) => pathMatch(candidate, relFile))) {
      return 'present';
    }
  }
  return 'missing';
}

function verificationStateForOwnerFeature(relFile, ownerFeatureId) {
  if (!ownerFeatureId) {
    return 'missing';
  }
  const feature = verificationOwners.find((candidate) => candidate.featureId === ownerFeatureId);
  if (!feature) {
    return 'missing';
  }
  return feature.paths.some((candidate) => pathMatch(candidate, relFile)) ? 'present' : 'missing';
}

const failures = [];
const results = new Map();

for (const category of allowedCategories) {
  const resolutionTrack = categoryResolutionTracks.get(category);
  if (!resolutionTrack) {
    failures.push(`manifest missing category_resolution_tracks entry for category: ${category}`);
    continue;
  }
  if (!allowedResolutionTracks.has(resolutionTrack)) {
    failures.push(
      `manifest category_resolution_tracks for ${category} uses unknown resolution track: ${resolutionTrack}`
    );
  }
}

for (const group of groups) {
  const manifestGroup = manifestGroups.get(group.id);
  if (!manifestGroup) {
    failures.push(`manifest missing carrier group: ${group.id}`);
    continue;
  }
  const manifestFiles = new Map();
  const categoryCounts = new Map();
  const resolutionCounts = new Map();
  const semanticFamilyCounts = new Map();
  for (const entry of Array.isArray(manifestGroup.files) ? manifestGroup.files : []) {
    const rel = normalizeRel(entry.path);
    if (!rel) {
      failures.push(`${group.id} has empty path entry in manifest`);
      continue;
    }
    if (manifestFiles.has(rel)) {
      failures.push(`${group.id} manifest duplicates file entry: ${rel}`);
      continue;
    }
    if (!allowedCategories.has(entry.category)) {
      failures.push(`${group.id} manifest file ${rel} uses unknown category: ${entry.category}`);
    }
    if (!allowedOwnerQueryability.has(entry.owner_queryability)) {
      failures.push(`${group.id} manifest file ${rel} uses unknown owner_queryability: ${entry.owner_queryability}`);
    }
    if (!allowedVerificationState.has(entry.verification_state)) {
      failures.push(`${group.id} manifest file ${rel} uses unknown verification_state: ${entry.verification_state}`);
    }
    if (!allowedSemanticFamilies.has(entry.semantic_family)) {
      failures.push(`${group.id} manifest file ${rel} uses unknown semantic_family: ${entry.semantic_family}`);
    }
    const ownerFeatureId = typeof entry.owner_feature_id === 'string' ? entry.owner_feature_id.trim() : '';
    if (!ownerFeatureId) {
      failures.push(`${group.id} manifest file ${rel} missing owner_feature_id`);
    } else if (!functionOwnerIds.has(ownerFeatureId)) {
      failures.push(`${group.id} manifest file ${rel} owner_feature_id not found in function-map: ${ownerFeatureId}`);
    }
    const resolutionTrack = categoryResolutionTracks.get(entry.category);
    if (!resolutionTrack) {
      failures.push(`${group.id} manifest file ${rel} category ${entry.category} has no resolution track mapping`);
    } else if (!allowedResolutionTracks.has(resolutionTrack)) {
      failures.push(
        `${group.id} manifest file ${rel} category ${entry.category} maps to unknown resolution track: ${resolutionTrack}`
      );
    }
    manifestFiles.set(rel, entry);
    categoryCounts.set(entry.category, (categoryCounts.get(entry.category) ?? 0) + 1);
    semanticFamilyCounts.set(entry.semantic_family, (semanticFamilyCounts.get(entry.semantic_family) ?? 0) + 1);
    if (resolutionTrack) {
      resolutionCounts.set(resolutionTrack, (resolutionCounts.get(resolutionTrack) ?? 0) + 1);
    }
  }

  const actualFiles = new Set();
  for (const scanRoot of runtimeScanRoots) {
    for (const absFile of walk(path.join(repoRoot, scanRoot))) {
      const rel = normalizeRel(path.relative(repoRoot, absFile));
      const text = fs.readFileSync(absFile, 'utf8');
      if (group.regex.test(text)) {
        actualFiles.add(rel);
      }
      group.regex.lastIndex = 0;
    }
  }

  for (const rel of [...actualFiles].sort()) {
    if (!manifestFiles.has(rel)) {
      failures.push(`${group.id} runtime hit missing from manifest: ${rel}`);
    }
  }
  for (const rel of [...manifestFiles.keys()].sort()) {
    if (!actualFiles.has(rel)) {
      failures.push(`${group.id} manifest entry no longer has runtime hit: ${rel}`);
    }
  }

  for (const [rel, entry] of manifestFiles.entries()) {
    const actualOwnerState = entry.owner_feature_id ? 'unique-owner' : ownerStateFor(rel);
    if (entry.owner_queryability !== actualOwnerState) {
      failures.push(
        `${group.id} manifest owner_queryability mismatch for ${rel}: expected ${entry.owner_queryability}, got ${actualOwnerState}`
      );
    }
    const actualVerificationState = entry.owner_feature_id
      ? verificationStateForOwnerFeature(rel, entry.owner_feature_id)
      : verificationStateFor(rel);
    if (entry.verification_state !== actualVerificationState) {
      failures.push(
        `${group.id} manifest verification_state mismatch for ${rel}: expected ${entry.verification_state}, got ${actualVerificationState}`
      );
    }
  }

  results.set(group.id, {
    title: group.title,
    fileCount: actualFiles.size,
    categoryCounts,
    resolutionCounts,
    semanticFamilyCounts,
  });
}

if (failures.length > 0) {
  console.error('[verify:custom-payload-carrier-runtime-manifest] failed');
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log('[verify:custom-payload-carrier-runtime-manifest] ok');
for (const group of groups) {
  const result = results.get(group.id);
  if (!result) {
    continue;
  }
  console.log(`- ${group.id}: files=${result.fileCount}`);
  for (const category of [...result.categoryCounts.keys()].sort()) {
    console.log(`  - ${category}: ${result.categoryCounts.get(category)}`);
  }
  for (const semanticFamily of [...result.semanticFamilyCounts.keys()].sort()) {
    console.log(`  - semantic.${semanticFamily}: ${result.semanticFamilyCounts.get(semanticFamily)}`);
  }
  for (const resolutionTrack of [...result.resolutionCounts.keys()].sort()) {
    console.log(`  - resolution.${resolutionTrack}: ${result.resolutionCounts.get(resolutionTrack)}`);
  }
}
