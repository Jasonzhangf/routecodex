#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { verifyV3RootThinDispatch } from './v3-root-thin-dispatch-contract.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const requireFromV3 = createRequire(resolve(repoRoot, 'v3', 'package.json'));
const YAML = requireFromV3('yaml');
const outputRoot = resolve(
  repoRoot,
  'v3',
  'build-contracts',
  'architecture-admission',
);
const providerCompatCanonicalPath =
  'v3/crates/routecodex-v3-config/src/v2_provider_compatibility_defaults.json';
const providerCompatLegacyMirrorPath =
  'sharedmodule/llmswitch-core/src/conversion/compat/provider-resolution-config.json';
const sourceRoots = [
  '.agents/skills/rcc-dev-skills/references/95-v3-stopless-sop.md',
  '.agents/skills/rcc-dev-skills/references/96-v3-selected-provider-model-binding-sop.md',
  '.github/workflows/release.yml',
  '.github/workflows/test.yml',
  'v3/config/v3-file-size-policy.json',
  'docs/architecture',
  'docs/design',
  'docs/goals',
  'docs/schemas',
  'scripts/architecture/architecture-wiki-lib.mjs',
  'scripts/architecture/mainline-call-map-lib.mjs',
  'scripts/architecture/v3-root-thin-dispatch-contract.mjs',
  'scripts/architecture/wiki-html-lib.mjs',
  'scripts/install-global.sh',
  'scripts/install-release.sh',
];

function sourceFilesBelow(relativePath) {
  const absolutePath = resolve(repoRoot, relativePath);
  if (!existsSync(absolutePath)) {
    throw new Error(`architecture admission source missing: ${relativePath}`);
  }
  if (!statSync(absolutePath).isDirectory()) return [relativePath];
  return readdirSync(absolutePath)
    .sort()
    .flatMap((entry) => sourceFilesBelow(`${relativePath}/${entry}`));
}

function sourcePaths() {
  return sourceRoots.flatMap(sourceFilesBelow).sort();
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function sourceCommit(path) {
  const pathCommit = execFileSync(
    'git',
    ['log', '-1', '--format=%H', '--', path],
    { cwd: repoRoot, encoding: 'utf8' },
  ).trim();
  if (pathCommit) return pathCommit;
  return execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: repoRoot,
    encoding: 'utf8',
  }).trim();
}

function canonicalJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function lockstepManifest(value) {
  const { manifest_digest: _manifestDigest, ...manifest } = value;
  return {
    ...manifest,
    files: Array.isArray(manifest.files)
      ? manifest.files.map(({ source_commit: _sourceCommit, ...file }) => file)
      : [],
  };
}

function verifyProviderCompatLegacyMirror() {
  const canonical = JSON.parse(
    readFileSync(resolve(repoRoot, providerCompatCanonicalPath), 'utf8'),
  );
  const legacyMirror = JSON.parse(
    readFileSync(resolve(repoRoot, providerCompatLegacyMirrorPath), 'utf8'),
  );
  if (!Array.isArray(canonical.compatibilityProfileBlocks)) {
    throw new Error(
      `${providerCompatCanonicalPath} must declare compatibilityProfileBlocks`,
    );
  }
  if (
    canonicalJson(canonical.compatibilityProfileBlocks)
    !== canonicalJson(legacyMirror.compatibilityProfileBlocks)
  ) {
    throw new Error(
      `legacy provider compatibility mirror drift: ${providerCompatLegacyMirrorPath}`,
    );
  }
}

function readSource(path) {
  const absolutePath = resolve(repoRoot, path);
  if (!existsSync(absolutePath)) {
    throw new Error(`architecture admission source missing: ${path}`);
  }
  const source = readFileSync(absolutePath, 'utf8');
  if (/\.ya?ml$/u.test(path)) {
    const parsed = YAML.parse(source);
    if (!parsed || typeof parsed !== 'object') {
      throw new Error(`architecture admission YAML must parse as an object: ${path}`);
    }
  }
  return source;
}

function expectedAdmission() {
  const files = [];
  for (const sourcePath of sourcePaths()) {
    const source = readSource(sourcePath);
    const outputPath = `repo/${sourcePath}`;
    files.push({
      output_path: outputPath,
      source_path: sourcePath,
      source_commit: sourceCommit(sourcePath),
      sha256: sha256(source),
    });
  }

  const payload = {
    schema_version: 1,
    generator: 'scripts/architecture/compile-v3-build-admission.mjs',
    output_root: relative(repoRoot, outputRoot),
    files,
  };
  const manifest = {
    ...payload,
    manifest_digest: sha256(canonicalJson(payload)),
  };
  return { files, manifest };
}

function compileAdmission() {
  verifyProviderCompatLegacyMirror();
  const expected = expectedAdmission();
  rmSync(resolve(outputRoot, 'repo'), { recursive: true, force: true });
  for (const entry of expected.files) {
    const source = readFileSync(resolve(repoRoot, entry.source_path), 'utf8');
    const absoluteOutput = resolve(outputRoot, entry.output_path);
    mkdirSync(dirname(absoluteOutput), { recursive: true });
    writeFileSync(absoluteOutput, source);
  }
  const { manifest } = expected;
  writeFileSync(resolve(outputRoot, 'manifest.json'), canonicalJson(manifest));
  return manifest;
}

function verifyAdmissionLockstep() {
  verifyProviderCompatLegacyMirror();
  const expected = expectedAdmission();
  const failures = [];
  for (const entry of expected.files) {
    const output = resolve(outputRoot, entry.output_path);
    if (!existsSync(output)) {
      failures.push(`missing generated admission file: ${entry.output_path}`);
      continue;
    }
    if (sha256(readFileSync(output, 'utf8')) !== entry.sha256) {
      failures.push(`stale generated admission file: ${entry.output_path}`);
    }
  }
  const expectedOutputs = new Set(expected.files.map((entry) => entry.output_path));
  const actualOutputs = existsSync(resolve(outputRoot, 'repo'))
    ? sourceFilesBelow(relative(repoRoot, resolve(outputRoot, 'repo')))
      .map((entry) => relative(outputRoot, resolve(repoRoot, entry)))
    : [];
  for (const output of actualOutputs) {
    if (!expectedOutputs.has(output)) failures.push(`unexpected generated admission file: ${output}`);
  }
  const manifestPath = resolve(outputRoot, 'manifest.json');
  if (!existsSync(manifestPath)) {
    failures.push('missing generated admission manifest: manifest.json');
  } else {
    const actualManifestText = readFileSync(manifestPath, 'utf8');
    let actualManifest;
    try {
      actualManifest = JSON.parse(actualManifestText);
    } catch {
      actualManifest = null;
    }
    if (
      actualManifestText !== canonicalJson(expected.manifest)
      && canonicalJson(lockstepManifest(actualManifest ?? {}))
        !== canonicalJson(lockstepManifest(expected.manifest))
    ) {
      const differences = actualManifest?.files && Array.isArray(actualManifest.files)
        ? expected.manifest.files
          .map((entry, index) => {
            const actual = actualManifest.files[index];
            return JSON.stringify(actual) === JSON.stringify(entry)
              ? null
              : `${entry.output_path}: expected=${JSON.stringify(entry)} actual=${JSON.stringify(actual)}`;
          })
          .filter(Boolean)
          .slice(0, 5)
        : [];
      failures.push(`stale generated admission manifest: manifest.json${differences.length > 0 ? `; differences=${differences.join(' | ')}` : ''}`);
    }
  }
  if (failures.length > 0) throw new Error(failures.join('; '));
  return expected.manifest;
}

try {
  const rootFailures = verifyV3RootThinDispatch({ repoRoot });
  if (rootFailures.length > 0) throw new Error(rootFailures.join('; '));
  const checkOnly = process.argv.includes('--check');
  const manifest = checkOnly ? verifyAdmissionLockstep() : compileAdmission();
  process.stdout.write(
    `[${checkOnly ? 'verify' : 'compile'}:v3-build-admission-lockstep] PASS files=${manifest.files.length} digest=${manifest.manifest_digest}\n`,
  );
} catch (error) {
  process.stderr.write(
    `[compile:v3-build-admission] FAIL ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
