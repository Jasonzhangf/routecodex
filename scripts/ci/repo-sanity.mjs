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

function listRootEntries() {
  const cwd = process.cwd();
  return fs
    .readdirSync(cwd, { withFileTypes: true })
    .filter((d) => d.name !== '.git')
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
    '.eslintrc.cjs',
    '.eslintrc.json',
    '.github',
    '.gitignore',
    '.npmignore',
    '.nvmrc',
    '.prettierignore',
    '.prettierrc.json',
    'AGENTS.md',
    'README.md',
    'bin',
    'config',
    'configsamples',
    'dist',
    'docs',
    'exporters',
    'interpreter',
    'jest.config.js',
    'node_modules',
    'package',
    'package-lock.json',
    'package.json',
    'rcc',
    'replay',
    'samples',
    'scripts',
    'servertool',
    'sharedmodule',
    'src',
    'task.md',
    'tests',
    'tmp',
    'tools',
    'tsconfig.json',
    'vendor',
    'verified-configs',
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

console.log('[repo-sanity] ok');
