#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = process.cwd();
const CORE_PREFIX = 'sharedmodule/llmswitch-core/';
const MANIFEST_PATH = path.join(ROOT, 'docs/loops/rustification/minimal-ts-surface.json');
const GENERATED_SEGMENTS = new Set(['dist', 'target', 'coverage', 'node_modules', '.mempalace', '.local-index']);
const TS_LIKE_RE = /\.(?:ts|tsx|mts|cts)$/u;
const EXTERNAL_REF_ROOTS = ['src', 'tests', 'scripts', 'helpers'];
const EXTERNAL_REF_FILES = ['jest.config.js', 'tsconfig.json', 'tsconfig.jest.json', 'package.json'];
const EXTERNAL_CODE_RE = /\.(?:js|mjs|cjs|ts|tsx|mts|cts)$/u;
const CORE_SRC_IMPORT_RE = /\b(?:import|export)\b[^'"\n]*(?:from\s*)?['"][^'"]*sharedmodule\/llmswitch-core\/src(?:\/|['"])/u;
const CORE_SRC_DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*['"][^'"]*sharedmodule\/llmswitch-core\/src(?:\/|['"])/u;
const CORE_SRC_REQUIRE_RE = /\brequire\s*\(\s*['"][^'"]*sharedmodule\/llmswitch-core\/src(?:\/|['"])/u;
const CORE_SRC_JEST_MOCK_RE = /\bjest\.(?:mock|unstable_mockModule)\s*\(\s*['"][^'"]*sharedmodule\/llmswitch-core\/src(?:\/|['"])/u;
const CORE_SRC_JEST_MAPPER_RE = /<rootDir>\/sharedmodule\/llmswitch-core\/src\//u;

function readGitTrackedFiles() {
  return execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'buffer' })
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .map((p) => p.split(path.sep).join('/'));
}

function walkFiles(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const dirent of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, dirent.name);
    const rel = path.relative(ROOT, fullPath).split(path.sep).join('/');
    if (isGeneratedOrIgnored(rel)) continue;
    if (dirent.isDirectory()) {
      walkFiles(fullPath, out);
    } else if (dirent.isFile()) {
      out.push(rel);
    }
  }
  return out;
}

function isGeneratedOrIgnored(rel) {
  const parts = rel.split('/');
  return parts.some((part) => GENERATED_SEGMENTS.has(part));
}

function isTrackedCoreTsLike(rel) {
  if (!rel.startsWith(CORE_PREFIX)) return false;
  if (isGeneratedOrIgnored(rel)) return false;
  if (rel.endsWith('.d.ts')) return true;
  return TS_LIKE_RE.test(rel);
}

function findExternalCoreSrcReferences(trackedFiles) {
  const candidates = [
    ...trackedFiles.filter((rel) => (
      !rel.startsWith(CORE_PREFIX)
      && EXTERNAL_REF_ROOTS.some((root) => rel.startsWith(`${root}/`))
      && EXTERNAL_CODE_RE.test(rel)
      && !isGeneratedOrIgnored(rel)
    )),
    ...EXTERNAL_REF_FILES.filter((rel) => trackedFiles.includes(rel)),
  ].filter((rel) => fs.existsSync(path.join(ROOT, rel)));
  const findings = [];
  for (const rel of candidates) {
    const source = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    const lines = source.split(/\r?\n/u);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (
        CORE_SRC_IMPORT_RE.test(line)
        || CORE_SRC_DYNAMIC_IMPORT_RE.test(line)
        || CORE_SRC_REQUIRE_RE.test(line)
        || CORE_SRC_JEST_MOCK_RE.test(line)
        || CORE_SRC_JEST_MAPPER_RE.test(line)
        || (EXTERNAL_REF_FILES.includes(rel) && line.includes('sharedmodule/llmswitch-core/src'))
      ) {
        findings.push(`${rel}:${index + 1}: ${line.trim()}`);
      }
    }
  }
  return findings;
}

function readManifestEntries() {
  if (!fs.existsSync(MANIFEST_PATH)) {
    throw new Error(`missing manifest: ${path.relative(ROOT, MANIFEST_PATH)}`);
  }
  const parsed = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  return Array.isArray(parsed.entries) ? parsed.entries : [];
}

function readRustificationAudit() {
  const raw = execFileSync(process.execPath, ['scripts/ci/llmswitch-rustification-audit.mjs', '--json'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  return JSON.parse(raw);
}

function main() {
  const errors = [];
  const trackedFiles = readGitTrackedFiles();
  const manifestEntries = readManifestEntries();
  const manifestPaths = new Set(manifestEntries.map((entry) => entry?.path).filter((p) => typeof p === 'string'));

  if (manifestEntries.length !== 0) {
    errors.push(`minimal TS surface manifest entries must be zero; current=${manifestEntries.length}`);
  }

  const currentCoreTsLike = trackedFiles
    .filter(isTrackedCoreTsLike)
    .filter((rel) => fs.existsSync(path.join(ROOT, rel)));
  if (currentCoreTsLike.length !== 0) {
    errors.push(`sharedmodule llmswitch-core tracked TS-like files must be zero; current=${currentCoreTsLike.length}`);
    for (const rel of currentCoreTsLike) errors.push(`remaining core TS-like file: ${rel}`);
  }

  const filesystemCoreTsLike = walkFiles(path.join(ROOT, CORE_PREFIX))
    .filter(isTrackedCoreTsLike);
  if (filesystemCoreTsLike.length !== 0) {
    errors.push(`sharedmodule llmswitch-core filesystem TS-like files must be zero; current=${filesystemCoreTsLike.length}`);
    for (const rel of filesystemCoreTsLike) errors.push(`remaining filesystem core TS-like file: ${rel}`);
  }

  for (const manifestPath of manifestPaths) {
    if (manifestPath.startsWith(CORE_PREFIX)) {
      errors.push(`minimal surface manifest must not list llmswitch-core TS surfaces: ${manifestPath}`);
    }
  }

  const externalCoreSrcReferences = findExternalCoreSrcReferences(trackedFiles);
  if (externalCoreSrcReferences.length !== 0) {
    errors.push(`external imports/mappers must not target sharedmodule/llmswitch-core/src; current=${externalCoreSrcReferences.length}`);
    for (const finding of externalCoreSrcReferences) errors.push(`external core src reference: ${finding}`);
  }

  const audit = readRustificationAudit();
  const metrics = audit.metrics ?? {};
  if (metrics.nonNativeFileCount !== 0) {
    errors.push(`rustification audit nonNativeFileCount must be zero; current=${metrics.nonNativeFileCount}`);
  }
  if (metrics.nonNativeLocTotal !== 0) {
    errors.push(`rustification audit nonNativeLocTotal must be zero; current=${metrics.nonNativeLocTotal}`);
  }

  if (errors.length > 0) {
    console.error('[verify-llmswitch-zero-ts-closeout] FAILED');
    for (const error of errors) console.error(`- ${error}`);
    process.exit(2);
  }

  console.log('[verify-llmswitch-zero-ts-closeout] ok');
  console.log('- entries: 0');
  console.log('- tracked llmswitch-core TS-like files: 0');
  console.log('- filesystem llmswitch-core TS-like files: 0');
  console.log('- external sharedmodule/llmswitch-core/src imports/mappers: 0');
  console.log('- nonNativeFileCount: 0');
  console.log('- nonNativeLocTotal: 0');
}

main();
