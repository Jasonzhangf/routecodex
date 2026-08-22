import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

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
  '.c',
  '.h',
  '.js',
  '.mjs',
  '.rs',
  '.ts',
  '.tsx',
]);

export const customPayloadCarrierPatternGroups = [
  {
    id: 'routecodex_prefix',
    title: '__routecodex* runtime owner queryability',
    regex: /__routecodex[A-Za-z0-9_]*/g,
  },
  {
    id: 'sse_prefix',
    title: '__sse_* runtime owner queryability',
    regex: /__sse_[A-Za-z0-9_]*/g,
  },
  {
    id: 'response_metadata',
    title: 'response.metadata runtime owner queryability',
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

function readYaml(repoRoot, relPath) {
  return YAML.parse(fs.readFileSync(path.join(repoRoot, relPath), 'utf8'));
}

function normalizeRel(input) {
  if (!input || typeof input !== 'string') {
    return null;
  }
  return input.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

function pathMatch(candidate, target) {
  const normalizedCandidate = normalizeRel(candidate);
  const normalizedTarget = normalizeRel(target);
  if (!normalizedCandidate || !normalizedTarget) {
    return false;
  }
  return normalizedTarget === normalizedCandidate || normalizedTarget.startsWith(`${normalizedCandidate}/`);
}

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function resolveOwnerModuleMatches(relFile, functionOwners) {
  const matches = functionOwners
    .filter((owner) => owner.ownerModule && pathMatch(owner.ownerModule, relFile))
    .map((owner) => ({
      featureId: owner.featureId,
      ownerModule: owner.ownerModule,
      matchLength: owner.ownerModule.length,
    }));
  if (matches.length === 0) {
    return {
      primary: [],
      broader: [],
    };
  }
  const maxLength = Math.max(...matches.map((match) => match.matchLength));
  return {
    primary: matches.filter((match) => match.matchLength === maxLength),
    broader: matches.filter((match) => match.matchLength < maxLength),
  };
}

function loadFunctionOwners(repoRoot) {
  const functionMap = readYaml(repoRoot, 'docs/architecture/function-map.yml');
  return toArray(functionMap.owners).map((owner) => ({
    featureId: owner.feature_id,
    ownerModule: normalizeRel(owner.owner_module),
    allowedPaths: toArray(owner.allowed_paths).map(normalizeRel).filter(Boolean),
  }));
}

function loadVerificationOwners(repoRoot) {
  const verificationMap = readYaml(repoRoot, 'docs/architecture/verification-map.yml');
  return toArray(verificationMap.verification).map((feature) => ({
    featureId: feature.feature_id,
    paths: [
      ...toArray(feature.unit),
      ...toArray(feature.contract),
      ...toArray(feature.integration),
    ].map(normalizeRel).filter(Boolean),
  }));
}

function loadManifestOwners(repoRoot) {
  const manifestPath = path.join(repoRoot, 'docs/architecture/custom-payload-carrier-runtime-manifest.yml');
  if (!fs.existsSync(manifestPath)) {
    return new Map();
  }
  const manifest = YAML.parse(fs.readFileSync(manifestPath, 'utf8'));
  const owners = new Map();
  for (const group of toArray(manifest?.carrier_runtime_surfaces)) {
    const groupId = String(group?.carrier_id || '');
    if (!groupId) {
      continue;
    }
    const byPath = new Map();
    for (const entry of toArray(group?.files)) {
      const rel = normalizeRel(entry?.path);
      const ownerFeatureId = typeof entry?.owner_feature_id === 'string' ? entry.owner_feature_id.trim() : '';
      if (rel && ownerFeatureId) {
        byPath.set(rel, ownerFeatureId);
      }
    }
    owners.set(groupId, byPath);
  }
  return owners;
}

function describeFunctionMatches(relFile, functionOwners) {
  const ownerMatches = [];
  const collaboratorMatches = [];
  const ownerModuleMatches = resolveOwnerModuleMatches(relFile, functionOwners);
  for (const owner of functionOwners) {
    const collaboratorReasons = [];
    for (const allowedPath of owner.allowedPaths) {
      if (pathMatch(allowedPath, relFile)) {
        collaboratorReasons.push(`allowed:${allowedPath}`);
      }
    }
    if (collaboratorReasons.length > 0) {
      collaboratorMatches.push({
        featureId: owner.featureId,
        reasons: [...new Set(collaboratorReasons)],
      });
    }
  }
  for (const owner of ownerModuleMatches.primary) {
    ownerMatches.push({
      featureId: owner.featureId,
      reasons: [`owner_module:${owner.ownerModule}`],
    });
  }
  for (const owner of ownerModuleMatches.broader) {
    collaboratorMatches.push({
      featureId: owner.featureId,
      reasons: [`broader_owner_module:${owner.ownerModule}`],
    });
  }
  return {
    ownerMatches,
    collaboratorMatches,
  };
}

function describeVerificationMatches(relFile, verificationOwners) {
  const matches = [];
  for (const feature of verificationOwners) {
    const reasons = feature.paths.filter((candidate) => pathMatch(candidate, relFile));
    if (reasons.length === 0) {
      continue;
    }
    matches.push({
      featureId: feature.featureId,
      reasons: [...new Set(reasons.map((reason) => `verification:${reason}`))],
    });
  }
  return matches;
}

function describeVerificationMatchesForFeature(relFile, ownerFeatureId, verificationOwners) {
  const feature = verificationOwners.find((candidate) => candidate.featureId === ownerFeatureId);
  if (!feature) {
    return [];
  }
  const reasons = feature.paths.filter((candidate) => pathMatch(candidate, relFile));
  if (reasons.length === 0) {
    return [];
  }
  return [
    {
      featureId: feature.featureId,
      reasons: [...new Set(reasons.map((reason) => `verification:${reason}`))],
    },
  ];
}

export function collectCustomPayloadCarrierOwnerQueryability(repoRoot = process.cwd()) {
  const functionOwners = loadFunctionOwners(repoRoot);
  const verificationOwners = loadVerificationOwners(repoRoot);
  const manifestOwners = loadManifestOwners(repoRoot);
  const states = new Map(customPayloadCarrierPatternGroups.map((group) => [group.id, []]));

  for (const scanRoot of runtimeScanRoots) {
    for (const file of walk(path.join(repoRoot, scanRoot))) {
      const rel = normalizeRel(path.relative(repoRoot, file));
      const text = fs.readFileSync(file, 'utf8');
      const lines = text.split(/\r?\n/);
      for (const group of customPayloadCarrierPatternGroups) {
        const fileMatches = [];
        lines.forEach((line, index) => {
          const matches = [...line.matchAll(group.regex)];
          if (matches.length === 0) {
            return;
          }
          if (fileMatches.length >= 5) {
            return;
          }
          fileMatches.push({
            line: index + 1,
            matches: matches.map((match) => match[0]),
          });
        });
        if (fileMatches.length === 0) {
          continue;
        }
        const manifestOwnerFeatureId = manifestOwners.get(group.id)?.get(rel) ?? null;
        const { ownerMatches, collaboratorMatches } = describeFunctionMatches(rel, functionOwners);
        const manifestOwnerMatches = manifestOwnerFeatureId
          ? [{ featureId: manifestOwnerFeatureId, reasons: ['manifest:custom-payload-carrier-runtime-manifest.yml'] }]
          : [];
        const resolvedOwnerMatches = manifestOwnerMatches.length > 0 ? manifestOwnerMatches : ownerMatches;
        const verificationMatches = manifestOwnerFeatureId
          ? describeVerificationMatchesForFeature(rel, manifestOwnerFeatureId, verificationOwners)
          : describeVerificationMatches(rel, verificationOwners);
        const ownerState =
          resolvedOwnerMatches.length === 0
            ? 'missing-owner'
            : resolvedOwnerMatches.length === 1
              ? 'unique-owner'
              : 'ambiguous-owner';
        states.get(group.id)?.push({
          file: rel,
          samples: fileMatches,
          ownerState,
          ownerMatches: resolvedOwnerMatches,
          collaboratorMatches,
          verificationMatches,
        });
      }
    }
  }

  return customPayloadCarrierPatternGroups.map((group) => {
    const files = states.get(group.id) ?? [];
    let uniqueOwnerCount = 0;
    let ambiguousOwnerCount = 0;
    let missingOwnerCount = 0;
    let missingVerificationCount = 0;

    for (const entry of files) {
      if (entry.ownerState === 'unique-owner') {
        uniqueOwnerCount += 1;
      } else if (entry.ownerState === 'ambiguous-owner') {
        ambiguousOwnerCount += 1;
      } else {
        missingOwnerCount += 1;
      }
      if (entry.verificationMatches.length === 0) {
        missingVerificationCount += 1;
      }
    }

    return {
      ...group,
      files,
      summary: {
        uniqueOwnerCount,
        ambiguousOwnerCount,
        missingOwnerCount,
        missingVerificationCount,
      },
    };
  });
}
