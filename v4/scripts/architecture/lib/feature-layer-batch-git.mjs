import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseCargoWorkspace } from './feature-layer-batch-cargo.mjs';

export const FULL_COMMIT_PATTERN = /^[0-9a-f]{40}$/;
export const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function sha256(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function run(command, args, cwd, { allowFailure = false, encoding = null } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding,
    env: { ...process.env, V4_LAYER_GATE_CHILD: '1' },
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (!allowFailure && result.status !== 0) {
    const detail = Buffer.isBuffer(result.stderr)
      ? result.stderr.toString('utf8')
      : String(result.stderr ?? '');
    throw new Error(`${command} ${args.join(' ')} exited ${result.status}: ${detail.trim()}`);
  }
  return result;
}

function normalizeRelative(relativePath) {
  if (typeof relativePath !== 'string'
      || relativePath.length === 0
      || relativePath.startsWith('/')
      || relativePath.split('/').includes('..')) {
    throw new Error(`unsafe V4 relative path: ${relativePath ?? '(missing)'}`);
  }
  return relativePath.replace(/\\/g, '/');
}

function repoPath(relativePath) {
  const normalized = normalizeRelative(relativePath);
  return normalized === 'v4' || normalized.startsWith('v4/')
    ? normalized
    : `v4/${normalized}`;
}

function scopeRoot(pattern) {
  const normalized = normalizeRelative(pattern);
  if (normalized.includes('*') && !normalized.endsWith('/**')) {
    throw new Error(`unsupported scope pattern: ${pattern}`);
  }
  return normalized.endsWith('/**') ? normalized.slice(0, -3) : normalized;
}

function matchesScope(relativePath, pattern) {
  const root = scopeRoot(pattern);
  return relativePath === root || (pattern.endsWith('/**') && relativePath.startsWith(`${root}/`));
}

function nulStrings(buffer) {
  return buffer.toString('utf8').split('\0').filter(Boolean);
}

function walkFiles(root, relativeRoot, out) {
  const absolute = path.join(root, relativeRoot);
  if (!fs.existsSync(absolute)) return;
  const metadata = fs.lstatSync(absolute);
  if (metadata.isSymbolicLink()) {
    throw new Error(`guarded surface contains symlink: ${relativeRoot}`);
  }
  if (metadata.isFile()) {
    out.push(relativeRoot.replace(/\\/g, '/'));
    return;
  }
  if (!metadata.isDirectory()) return;
  for (const entry of fs.readdirSync(absolute).sort()) {
    walkFiles(root, path.join(relativeRoot, entry), out);
  }
}

function filesystemBlobIdentity(v4Root, relativePath) {
  const normalized = normalizeRelative(relativePath);
  const absolute = path.join(v4Root, normalized);
  if (!fs.existsSync(absolute)) return null;
  const metadata = fs.lstatSync(absolute);
  if (!metadata.isFile() || metadata.isSymbolicLink()) return null;
  const bytes = fs.readFileSync(absolute);
  const gitHeader = Buffer.from(`blob ${bytes.length}\0`);
  return {
    path: normalized,
    mode: (metadata.mode & 0o111) === 0 ? '100644' : '100755',
    git_oid: crypto.createHash('sha1').update(gitHeader).update(bytes).digest('hex'),
    sha256: sha256(bytes),
  };
}

export function createGitTruth({ repoRoot, v4Root }) {
  const git = (args, options = {}) => run('git', args, repoRoot, options);
  // Red fixtures replay immutable Git facts many times. Cache read-only facts
  // within this truth view so the gate remains deterministic without spawning
  // the same Git subprocess for every mutation case.
  const factCache = new Map();
  const cachedFact = (key, producer) => {
    if (factCache.has(key)) return factCache.get(key);
    const value = producer();
    factCache.set(key, value);
    return value;
  };

  function resolveCommit(ref) {
    return cachedFact(`resolveCommit:${ref}`, () => {
      if (typeof ref !== 'string' || !/^[0-9a-f]{7,40}$/.test(ref)) return null;
      const result = git(['rev-parse', '--verify', `${ref}^{commit}`], {
        allowFailure: true,
        encoding: 'utf8',
      });
      if (result.status !== 0) return null;
      const resolved = result.stdout.trim();
      return FULL_COMMIT_PATTERN.test(resolved) ? resolved : null;
    });
  }

  function isAncestor(baseCommit, headCommit) {
    return cachedFact(`isAncestor:${baseCommit}:${headCommit}`, () => {
      if (!FULL_COMMIT_PATTERN.test(baseCommit) || !FULL_COMMIT_PATTERN.test(headCommit)) return false;
      return git(['merge-base', '--is-ancestor', baseCommit, headCommit], { allowFailure: true }).status === 0;
    });
  }

  function treeHash(commit) {
    return cachedFact(`treeHash:${commit}`, () => {
      if (!FULL_COMMIT_PATTERN.test(commit)) return null;
      const result = git(['rev-parse', '--verify', `${commit}^{tree}`], {
        allowFailure: true,
        encoding: 'utf8',
      });
      return result.status === 0 ? result.stdout.trim() : null;
    });
  }

  function changedPaths(baseCommit, headCommit) {
    return changedEntries(baseCommit, headCommit).map((entry) => entry.path).sort();
  }

  function changedEntries(baseCommit, headCommit) {
    const result = git([
      'diff', '--name-status', '--no-renames', '-z', baseCommit, headCommit, '--', 'v4',
    ]);
    const fields = nulStrings(result.stdout);
    if (fields.length % 2 !== 0) throw new Error('unexpected git diff --name-status output');
    const entries = [];
    for (let index = 0; index < fields.length; index += 2) {
      const status = fields[index];
      const changedPath = fields[index + 1];
      if (!/^[AMD]$/.test(status) || !changedPath.startsWith('v4/')) {
        throw new Error(`unsupported candidate diff entry ${status}:${changedPath}`);
      }
      entries.push({ status, path: changedPath });
    }
    return entries.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  }

  function changedPathsOutsideV4(baseCommit, headCommit) {
    const result = git([
      'diff', '--name-only', '--no-renames', '-z', baseCommit, headCommit, '--',
    ]);
    return nulStrings(result.stdout).filter((changedPath) => !changedPath.startsWith('v4/')).sort();
  }

  function diffHash(baseCommit, headCommit) {
    const result = git([
      'diff-tree', '--no-commit-id', '--raw', '-r', '-z', '--no-renames',
      baseCommit, headCommit, '--', 'v4',
    ]);
    return sha256(Buffer.concat([
      Buffer.from('v4-feature-layer-git-diff-v1'),
      Buffer.from([0]),
      result.stdout,
    ]));
  }

  function blob(commit, relativePath) {
    if (!FULL_COMMIT_PATTERN.test(commit)) return null;
    return cachedFact(`blob:${commit}:${relativePath}`, () => {
      const result = git(['show', `${commit}:${repoPath(relativePath)}`], { allowFailure: true });
      return result.status === 0 ? result.stdout : null;
    });
  }

  function blobHash(commit, relativePath) {
    const value = blob(commit, relativePath);
    return value === null ? null : sha256(value);
  }

  function trackedAt(commit, relativePath) {
    if (!FULL_COMMIT_PATTERN.test(commit)) return false;
    return cachedFact(`trackedAt:${commit}:${relativePath}`, () =>
      git(['cat-file', '-e', `${commit}:${repoPath(relativePath)}`], { allowFailure: true }).status === 0);
  }

  function blobIdentity(commit, relativePath) {
    if (!FULL_COMMIT_PATTERN.test(commit)) return null;
    return cachedFact(`blobIdentity:${commit}:${relativePath}`, () => {
      const expectedPath = repoPath(relativePath);
      const result = git([
        'ls-tree', '-z', '--full-tree', commit, '--', expectedPath,
      ], { allowFailure: true });
      if (result.status !== 0) return null;
      const entries = nulStrings(result.stdout);
      if (entries.length !== 1) return null;
      const [header, actualPath, ...extra] = entries[0].split(String.fromCharCode(9));
      const match = header.match(/^([0-9]{6}) (blob) ([0-9a-f]{40})$/);
      if (extra.length > 0 || !match || actualPath !== expectedPath
          || !['100644', '100755'].includes(match[1])) return null;
      const bytes = blob(commit, relativePath);
      if (bytes === null) return null;
      return {
        path: normalizeRelative(relativePath),
        mode: match[1],
        git_oid: match[3],
        sha256: sha256(bytes),
      };
    });
  }

  function ignored(relativePath) {
    return cachedFact(`ignored:${relativePath}`, () => {
      const result = git(['check-ignore', '--no-index', '--quiet', '--', repoPath(relativePath)], {
        allowFailure: true,
      });
      if (![0, 1].includes(result.status)) {
        throw new Error(`git check-ignore failed for ${relativePath}`);
      }
      return result.status === 0;
    });
  }

  function scopeFilesAt(commit, patterns) {
    return cachedFact(`scopeFilesAt:${commit}:${patterns.join('|')}`, () => {
      const roots = patterns.map((pattern) => repoPath(scopeRoot(pattern)));
      const result = git(['ls-tree', '-r', '-z', '--name-only', commit, '--', ...roots]);
      return nulStrings(result.stdout)
        .filter((candidate) => candidate.startsWith('v4/'))
        .map((candidate) => candidate.slice(3))
        .filter((candidate) => patterns.some((pattern) => matchesScope(candidate, pattern)))
        .sort();
    });
  }

  function currentScopeFiles(patterns) {
    return cachedFact(`currentScopeFiles:${patterns.join('|')}`, () => {
      const files = [];
      for (const pattern of patterns) {
        walkFiles(v4Root, scopeRoot(pattern), files);
      }
      return [...new Set(files)]
        .filter((candidate) => patterns.some((pattern) => matchesScope(candidate, pattern)))
        .sort();
    });
  }

  function scopeHashAt(commit, patterns) {
    const files = scopeFilesAt(commit, patterns);
    const entries = files.map((relativePath) => {
      const identity = blobIdentity(commit, relativePath);
      if (!identity) throw new Error(`${relativePath}: guarded commit entry is not a regular blob`);
      return identity;
    });
    return sha256(canonicalJson(entries));
  }

  function currentScopeHash(patterns) {
    const entries = currentScopeFiles(patterns).map((relativePath) => {
      const identity = filesystemBlobIdentity(v4Root, relativePath);
      if (!identity) throw new Error(`${relativePath}: guarded worktree entry is not a regular blob`);
      return identity;
    });
    return sha256(canonicalJson(entries));
  }

  function currentPathEqualsCommit(relativePath, commit) {
    const expected = blobIdentity(commit, relativePath);
    const current = filesystemBlobIdentity(v4Root, relativePath);
    return expected !== null && current !== null && canonicalJson(current) === canonicalJson(expected);
  }

  function currentBlobIdentity(relativePath) {
    return filesystemBlobIdentity(v4Root, relativePath);
  }

  function deriveCandidateIdentity({ baseCommit, headCommit, binding }) {
    const resolvedBase = resolveCommit(baseCommit);
    const resolvedHead = resolveCommit(headCommit);
    if (!resolvedBase || !resolvedHead) return null;
    const outsideV4 = changedPathsOutsideV4(resolvedBase, resolvedHead);
    if (outsideV4.length > 0) {
      throw new Error(`candidate commit contains non-V4 paths: ${outsideV4.join(',')}`);
    }
    const entries = changedEntries(resolvedBase, resolvedHead);
    const blobs = entries.map((entry) => {
      const relativePath = entry.path.slice(3);
      const identityCommit = entry.status === 'D' ? resolvedBase : resolvedHead;
      const file = blobIdentity(identityCommit, relativePath);
      if (!file) throw new Error(`candidate path is not a regular tracked blob: ${entry.path}`);
      return { status: entry.status, ...file };
    });
    const identity = {
      base_commit: resolvedBase,
      head_commit: resolvedHead,
      tree_hash: treeHash(resolvedHead),
      diff_hash: diffHash(resolvedBase, resolvedHead),
      changed_paths: entries.map((entry) => entry.path),
      blobs,
      binding,
    };
    return { ...identity, scope_hash: sha256(canonicalJson(identity)) };
  }

  function currentHead() {
    return cachedFact('currentHead', () => {
      const result = git(['rev-parse', '--verify', 'HEAD^{commit}'], { encoding: 'utf8' });
      const commit = result.stdout.trim();
      if (!FULL_COMMIT_PATTERN.test(commit)) throw new Error('current HEAD is not a full commit');
      return commit;
    });
  }

  function controlledScopeClean(patterns = ['v4/**']) {
    const roots = patterns.map((pattern) => repoPath(scopeRoot(pattern)));
    const result = git([
      'status', '--porcelain=v2', '-z', '--untracked-files=all', '--', ...roots,
    ]);
    return result.stdout.length === 0;
  }

  function cargoGraph(commit = null) {
    return cachedFact(`cargoGraph:${commit ?? 'worktree'}`, () => {
      const patterns = ['crates/**', 'cordis/**'];
      const files = commit === null ? currentScopeFiles(patterns) : scopeFilesAt(commit, patterns);
      const manifests = files.filter((relativePath) => relativePath.endsWith('/Cargo.toml'));
      const rootBytes = commit === null
        ? fs.readFileSync(path.join(v4Root, 'Cargo.toml'))
        : blob(commit, 'Cargo.toml');
      if (rootBytes === null) throw new Error('Cargo.toml cannot be read');
      const manifestSources = new Map();
      for (const manifest of manifests) {
        const bytes = commit === null
          ? fs.readFileSync(path.join(v4Root, manifest))
          : blob(commit, manifest);
        if (bytes === null) throw new Error(`${manifest}: tracked manifest cannot be read`);
        manifestSources.set(manifest, bytes.toString('utf8'));
      }
      return parseCargoWorkspace(rootBytes.toString('utf8'), manifestSources);
    });
  }

  function runGate(argv) {
    if (!Array.isArray(argv)
        || argv.length === 0
        || argv.some((part) => typeof part !== 'string' || part.length === 0 || /[\r\n\0]/.test(part))) {
      throw new Error('gate argv must be a non-empty string array');
    }
    const result = run(argv[0], argv.slice(1), v4Root, { allowFailure: true, encoding: 'utf8' });
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      receipt_hash: sha256(canonicalJson({ argv, status: result.status, stdout: result.stdout, stderr: result.stderr })),
    };
  }

  return {
    resolveCommit,
    isAncestor,
    treeHash,
    changedPaths,
    changedEntries,
    changedPathsOutsideV4,
    diffHash,
    blob,
    blobHash,
    blobIdentity,
    trackedAt,
    ignored,
    scopeFilesAt,
    currentScopeFiles,
    scopeHashAt,
    currentScopeHash,
    currentPathEqualsCommit,
    currentBlobIdentity,
    deriveCandidateIdentity,
    currentHead,
    controlledScopeClean,
    cargoGraph,
    runGate,
  };
}
