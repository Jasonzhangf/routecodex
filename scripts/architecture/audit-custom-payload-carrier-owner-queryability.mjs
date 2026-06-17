import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

const repoRoot = process.cwd();

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

const patternGroups = [
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

function readYaml(relPath) {
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

const functionMap = readYaml('docs/architecture/function-map.yml');
const verificationMap = readYaml('docs/architecture/verification-map.yml');

const functionOwners = toArray(functionMap.owners).map((owner) => ({
  featureId: owner.feature_id,
  ownerModule: normalizeRel(owner.owner_module),
  allowedPaths: toArray(owner.allowed_paths).map(normalizeRel).filter(Boolean),
}));

const verificationOwners = toArray(verificationMap.verification).map((feature) => ({
  featureId: feature.feature_id,
  paths: [
    ...toArray(feature.unit),
    ...toArray(feature.contract),
    ...toArray(feature.integration),
  ].map(normalizeRel).filter(Boolean),
}));

const states = new Map(patternGroups.map((group) => [group.id, []]));

for (const scanRoot of runtimeScanRoots) {
  for (const file of walk(path.join(repoRoot, scanRoot))) {
    const rel = normalizeRel(path.relative(repoRoot, file));
    const text = fs.readFileSync(file, 'utf8');
    const lines = text.split(/\r?\n/);
    for (const group of patternGroups) {
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
      states.get(group.id)?.push({
        file: rel,
        samples: fileMatches,
      });
    }
  }
}

function describeFunctionMatches(relFile) {
  const ownerMatches = [];
  const collaboratorMatches = [];
  for (const owner of functionOwners) {
    const ownerReasons = [];
    const collaboratorReasons = [];
    if (owner.ownerModule && pathMatch(owner.ownerModule, relFile)) {
      ownerReasons.push(`owner_module:${owner.ownerModule}`);
    }
    for (const allowedPath of owner.allowedPaths) {
      if (pathMatch(allowedPath, relFile)) {
        collaboratorReasons.push(`allowed:${allowedPath}`);
      }
    }
    if (ownerReasons.length > 0) {
      ownerMatches.push({
        featureId: owner.featureId,
        reasons: [...new Set(ownerReasons)],
      });
      continue;
    }
    if (collaboratorReasons.length > 0) {
      collaboratorMatches.push({
        featureId: owner.featureId,
        reasons: [...new Set(collaboratorReasons)],
      });
    }
  }
  return {
    ownerMatches,
    collaboratorMatches,
  };
}

function describeVerificationMatches(relFile) {
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

console.log('[audit-custom-payload-carrier-owner-queryability] report');

for (const group of patternGroups) {
  const files = states.get(group.id) ?? [];
  console.log(`\n## ${group.title}`);
  console.log(`runtime files=${files.length}`);
  let uniqueOwnerCount = 0;
  let ambiguousOwnerCount = 0;
  let missingOwnerCount = 0;
  let missingVerificationCount = 0;

  for (const entry of files) {
    const { ownerMatches, collaboratorMatches } = describeFunctionMatches(entry.file);
    const verificationMatches = describeVerificationMatches(entry.file);
    const ownerState =
      ownerMatches.length === 0
        ? 'missing-owner'
        : ownerMatches.length === 1
          ? 'unique-owner'
          : 'ambiguous-owner';
    if (ownerState === 'unique-owner') {
      uniqueOwnerCount += 1;
    } else if (ownerState === 'ambiguous-owner') {
      ambiguousOwnerCount += 1;
    } else {
      missingOwnerCount += 1;
    }
    if (verificationMatches.length === 0) {
      missingVerificationCount += 1;
    }

    const sampleSummary = entry.samples
      .map((sample) => `L${sample.line}:${sample.matches.join(',')}`)
      .join(' | ');
    console.log(`- ${entry.file} [${ownerState}]`);
    console.log(`  samples: ${sampleSummary}`);
    if (ownerMatches.length === 0) {
      console.log('  function-map owner: none');
    } else {
      const summary = ownerMatches
        .map((match) => `${match.featureId} (${match.reasons.join('; ')})`)
        .join(' | ');
      console.log(`  function-map owner: ${summary}`);
    }
    if (collaboratorMatches.length === 0) {
      console.log('  function-map collaborators: none');
    } else {
      const summary = collaboratorMatches
        .map((match) => `${match.featureId} (${match.reasons.join('; ')})`)
        .join(' | ');
      console.log(`  function-map collaborators: ${summary}`);
    }
    if (verificationMatches.length === 0) {
      console.log('  verification-map: none');
    } else {
      const summary = verificationMatches
        .map((match) => `${match.featureId} (${match.reasons.join('; ')})`)
        .join(' | ');
      console.log(`  verification-map: ${summary}`);
    }
  }

  console.log(
    `summary unique-owner=${uniqueOwnerCount} ambiguous-owner=${ambiguousOwnerCount} missing-owner=${missingOwnerCount} missing-verification=${missingVerificationCount}`
  );
}
