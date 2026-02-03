import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

function runGit(args) {
  const out = spawnSync('git', args, { encoding: 'utf8' });
  if (out.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${out.stderr || out.stdout}`);
  }
  return String(out.stdout || '');
}

function isIgnoredByGit(p) {
  const out = spawnSync('git', ['check-ignore', '-q', p], { encoding: 'utf8' });
  return out.status === 0;
}

function listRootEntries() {
  const cwd = process.cwd();
  return fs
    .readdirSync(cwd, { withFileTypes: true })
    .filter((d) => d.name !== '.git')
    .filter((d) => !isIgnoredByGit(d.name))
    .map((d) => d.name)
    .sort();
}

function isForbiddenRootFile(p) {
  const base = path.posix.basename(p);
  const allow = new Set(['AGENTS.md', 'README.md', 'task.md']);
  if (allow.has(base)) return false;
  if (/^test-.*\.(mjs|js|ts|py)$/i.test(base)) return true;
  if (/^debug-.*\.(mjs|js|ts)$/i.test(base)) return true;
  if (/\.pid$/i.test(base)) return true;
  if (/\.tgz$/i.test(base)) return true;
  if (base === 'plan.md') return true;
  if (base === 'task-fallback.md') return true;
  if (base === 'task.archive.md') return true;
  if (base === 'WARP.md') return true;
  if (base === 'CLAUDE.md') return true;
  if (/(_SUMMARY|_FIX)_/i.test(base) && base.toLowerCase().endsWith('.md')) return true;
  // Disallow ad-hoc root markdown by default (docs belong under docs/).
  if (base.toLowerCase().endsWith('.md')) return true;
  return false;
}

function isForbiddenTrackedPath(p) {
  // Keep the rules narrow and explicit: this is an audit guard, not a policy engine.
  if (p.startsWith('docs/archive/')) return true;
  if (p.startsWith('scripts/dev/')) return true;
  if (p.startsWith('scripts/test-') && p.endsWith('.mjs')) return true;
  if (p.startsWith('tools/')) return true;
  if (p.startsWith('replay/')) return true;
  if (p.startsWith('servertool/')) return true;
  if (p.startsWith('verified-configs/')) return true;
  if (p.startsWith('interpreter/')) return true;
  if (p.startsWith('exporters/')) return true;
  if (p.startsWith('bin/')) return true;
  if (p.startsWith('.npm-cache-local/')) return true;
  if (p.startsWith('.claude/')) return true;
  if (p.startsWith('.iflow/')) return true;
  if (p === '.secrets.baseline') return true;
  if (p.endsWith('/.DS_Store') || p === '.DS_Store') return true;
  return false;
}

function checkRootLayout() {
  // Fixed top-level layout. Adding new root entries requires an explicit policy change.
  const allowed = new Set([
    'eslint.config.js',
    '.beads',
    '.github',
    '.gitattributes',
    '.gitignore',
    'AGENTS.md',
    'README.md',
    'config',
    'configsamples',
    'dist',
    'docs',
    'jest.config.js',
    'node_modules',
    'package',
    'package-lock.json',
    'package.json',
    'rcc',
    'samples',
    'scripts',
    'sharedmodule',
    'src',
    'task.md',
    'tests',
    'tmp',
    'tsconfig.json',
    'vendor',
  ]);

  const rootEntries = listRootEntries();
  const unexpected = rootEntries.filter((name) => !allowed.has(name));
  if (unexpected.length) {
    console.error('[repo-sanity] unexpected root entries (top-level is fixed):');
    for (const name of unexpected) console.error(`- ${name}`);
    process.exit(2);
  }
}

function checkUntrackedNotIgnored() {
  // Fail fast if anything new appears outside gitignore (anywhere in repo).
  const out = runGit(['ls-files', '--others', '--exclude-standard']);
  const paths = out
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  if (paths.length) {
    console.error('[repo-sanity] untracked files not ignored (add them to git or gitignore):');
    for (const p of paths.slice(0, 200)) console.error(`- ${p}`);
    if (paths.length > 200) console.error(`- ... (${paths.length - 200} more)`);
    process.exit(2);
  }
}

function checkTrackedSecrets() {
  // Lightweight secret scanner: prevent accidental commits of raw tokens/keys.
  // Keep patterns tight to avoid false positives.
  const patterns = [
    // OpenAI-style API keys.
    { label: 'openai_sk', mode: 'E', pattern: String.raw`sk-[A-Za-z0-9]{20,}` },
    // Google API keys.
    { label: 'google_api_key', mode: 'E', pattern: String.raw`AIza[0-9A-Za-z\-_]{20,}` },
    // GitHub classic personal access tokens.
    { label: 'github_pat', mode: 'E', pattern: String.raw`ghp_[A-Za-z0-9]{30,}` },
    // PEM private keys (fixed strings to avoid regex engine differences).
    { label: 'private_key', mode: 'F', pattern: '-----BEGIN PRIVATE KEY-----' },
    { label: 'rsa_private_key', mode: 'F', pattern: '-----BEGIN RSA PRIVATE KEY-----' },
    { label: 'ec_private_key', mode: 'F', pattern: '-----BEGIN EC PRIVATE KEY-----' }
  ];

  const hits = [];
  for (const entry of patterns) {
    const out = spawnSync(
      'git',
      entry.mode === 'F'
        ? ['grep', '-nF', '-e', entry.pattern, '--', '.', ':(exclude)scripts/ci/repo-sanity.mjs']
        : ['grep', '-nE', '-e', entry.pattern, '--', '.', ':(exclude)scripts/ci/repo-sanity.mjs'],
      { encoding: 'utf8' }
    );
    // git grep exits with 1 when no matches; 0 when matches; >1 for errors.
    if (out.status === 0) {
      const lines = String(out.stdout || '')
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);
      for (const line of lines) {
        hits.push(`[${entry.label}] ${line}`);
      }
    } else if ((out.status ?? 0) > 1) {
      throw new Error(`git grep failed for ${entry.label}: ${out.stderr || out.stdout}`);
    }
  }

  if (hits.length) {
    console.error('[repo-sanity] potential secrets detected in tracked files:');
    for (const line of hits.slice(0, 200)) {
      console.error(`- ${line}`);
    }
    if (hits.length > 200) console.error(`- ... (${hits.length - 200} more)`);
    process.exit(2);
  }
}

const files = runGit(['ls-files']).split('\n').map((s) => s.trim()).filter(Boolean);
const forbidden = [];
for (const p of files) {
  if (isForbiddenTrackedPath(p)) forbidden.push(p);
  if (!p.includes('/') && isForbiddenRootFile(p)) forbidden.push(p);
}

if (forbidden.length) {
  console.error('[repo-sanity] forbidden tracked files detected:');
  for (const p of Array.from(new Set(forbidden)).sort()) {
    console.error(`- ${p}`);
  }
  process.exit(2);
}

checkRootLayout();
checkUntrackedNotIgnored();
checkTrackedSecrets();

console.log('[repo-sanity] ok');
