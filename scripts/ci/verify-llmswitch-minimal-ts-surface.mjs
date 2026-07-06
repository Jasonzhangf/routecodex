import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = process.cwd();
const MANIFEST_PATH = path.join(ROOT, 'docs/loops/rustification/minimal-ts-surface.json');
const SRC_PREFIX = 'sharedmodule/llmswitch-core/src/';
const GENERATED_DIR_NAMES = new Set([
  'dist',
  'target',
  'coverage',
  'node_modules',
  '.mempalace',
  '.local-index',
  'mempalace',
  '__snapshots__',
  'snapshots',
  'reports',
]);
const ALLOWED_CLASSIFICATIONS = new Set([
  'native_shell_ok',
  'type_shell_ok',
  'ts_io_shell_ok',
  'parser_io_ok',
  'diagnostic_io_ok',
]);

function readGitTrackedFiles() {
  return execFileSync('git', ['ls-files', '-z'], {
    cwd: ROOT,
    encoding: 'buffer',
  })
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .map((p) => p.split(path.sep).join('/'))
    .sort();
}

function isGeneratedOrLocalIndexPath(rel) {
  const parts = rel.split('/');
  if (parts.some((part) => GENERATED_DIR_NAMES.has(part))) return true;
  if (rel.endsWith('.html')) return true;
  if (/\.(bak|backup|orig|tmp)$/u.test(rel)) return true;
  if (rel.endsWith('~')) return true;
  if (/generated[-_/].*report|report[-_/].*generated/u.test(rel)) return true;
  return false;
}

function isProdTs(rel) {
  if (rel.endsWith('.d.ts')) return false;
  if (rel.endsWith('.spec.ts') || rel.endsWith('.test.ts')) return false;
  if (rel.includes('/tests/')) return false;
  if (rel.includes('/test/')) return false;
  if (rel.includes('/archive/')) return false;
  return true;
}

function isNativeLinked(content) {
  return [
    /native-router-hotpath/,
    /WithNative/,
    /loadNativeRouterHotpathBinding/,
    /router_hotpath_napi/,
  ].some((pattern) => pattern.test(content));
}

function listCurrentNonNativeProdTsFiles() {
  return readGitTrackedFiles()
    .filter((rel) => rel.startsWith(SRC_PREFIX))
    .filter((rel) => !isGeneratedOrLocalIndexPath(rel))
    .filter((rel) => rel.endsWith('.ts'))
    .filter((rel) => isProdTs(rel))
    .filter((rel) => fs.existsSync(path.join(ROOT, rel)))
    .filter((rel) => !isNativeLinked(fs.readFileSync(path.join(ROOT, rel), 'utf8')));
}

function isCurrentTrackedProdTsFile(rel) {
  if (typeof rel !== 'string') return false;
  if (!rel.startsWith(SRC_PREFIX)) return false;
  if (!rel.endsWith('.ts')) return false;
  if (isGeneratedOrLocalIndexPath(rel)) return false;
  if (!isProdTs(rel)) return false;
  return fs.existsSync(path.join(ROOT, rel));
}

function isCurrentNativeLinkedProdTsFile(rel) {
  if (!isCurrentTrackedProdTsFile(rel)) return false;
  return isNativeLinked(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
}

function readManifest() {
  if (!fs.existsSync(MANIFEST_PATH)) {
    throw new Error(`missing minimal TS manifest: ${path.relative(ROOT, MANIFEST_PATH)}`);
  }
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
}

function hasUsefulReason(value) {
  return typeof value === 'string' && value.trim().length >= 40;
}

function main() {
  const manifest = readManifest();
  const entries = Array.isArray(manifest.entries) ? manifest.entries : [];
  const errors = [];
  const current = new Set(listCurrentNonNativeProdTsFiles());
  const explicitNativeLinkedShells = new Set();
  const manifestPaths = new Set();

  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') {
      errors.push('manifest contains a non-object entry');
      continue;
    }
    const rel = entry.path;
    if (typeof rel !== 'string' || !rel.startsWith(SRC_PREFIX)) {
      errors.push(`invalid path entry: ${String(rel)}`);
      continue;
    }
    if (manifestPaths.has(rel)) {
      errors.push(`duplicate manifest path: ${rel}`);
    }
    manifestPaths.add(rel);
    const isExplicitNativeLinkedShell = isCurrentNativeLinkedProdTsFile(rel);
    if (isExplicitNativeLinkedShell) {
      explicitNativeLinkedShells.add(rel);
    }
    if (!current.has(rel) && !isExplicitNativeLinkedShell) {
      errors.push(`manifest path is neither current non-native prod TS nor explicit native-linked shell: ${rel}`);
    }
    if (!ALLOWED_CLASSIFICATIONS.has(entry.classification)) {
      errors.push(`invalid classification for ${rel}: ${String(entry.classification)}`);
    }
    if (!hasUsefulReason(entry.cannotShrinkFurtherBecause)) {
      errors.push(`missing hard cannotShrinkFurtherBecause for ${rel}`);
    }
    if (!hasUsefulReason(entry.minimumTsRole)) {
      errors.push(`missing minimumTsRole for ${rel}`);
    }
    if (typeof entry.ownerFeature !== 'string' || !entry.ownerFeature.trim()) {
      errors.push(`missing ownerFeature for ${rel}`);
    }
    if (!Array.isArray(entry.forbiddenSemantics) || entry.forbiddenSemantics.length === 0) {
      errors.push(`missing forbiddenSemantics for ${rel}`);
    }
  }

  for (const rel of current) {
    if (!manifestPaths.has(rel)) {
      errors.push(`current non-native prod TS file lacks minimal-surface classification: ${rel}`);
    }
  }

  if (errors.length > 0) {
    console.error('[verify-llmswitch-minimal-ts-surface] FAILED');
    for (const error of errors) console.error(`- ${error}`);
    process.exit(2);
  }

  console.log('[verify-llmswitch-minimal-ts-surface] ok');
  console.log(`- entries: ${entries.length}`);
  console.log(`- current non-native prod TS files: ${current.size}`);
  console.log(`- explicit native-linked TS shells: ${explicitNativeLinkedShells.size}`);
}

main();
