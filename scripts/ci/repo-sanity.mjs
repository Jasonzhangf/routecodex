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

function listRootEntries({ includeIgnored = false } = {}) {
  const cwd = process.cwd();
  return fs
    .readdirSync(cwd, { withFileTypes: true })
    .filter((d) => d.name !== '.git')
    .filter((d) => includeIgnored || !isIgnoredByGit(d.name))
    .map((d) => d.name)
    .sort();
}

function isForbiddenRootFile(p) {
  const base = path.posix.basename(p);
  const allow = new Set(['AGENTS.md', 'README.md', 'MEMORY.md', 'HEARTBEAT.md', 'DELIVERY.md', 'task.md', 'note.md']);
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
  if (/(^|\/)[^/]+\.bak\d*$/i.test(p)) return true;
  return false;
}

function checkRootLayout() {
  // Fixed top-level layout. Adding new root entries requires an explicit policy change.
  const sourceRoots = new Set([
    '.agents',
    '.beads',
    '.github',
    '.gitattributes',
    '.gitignore',
    'AGENTS.md',
    'DELIVERY.md',
    'HEARTBEAT.md',
    'MEMORY.md',
    'README.md',
    'config',
    'configsamples',
    'docs',
    'eslint.config.js',
    'jest.config.js',
    'memory',
    'note.md',
    'package-lock.json',
    'package.json',
    'samples',
    'scripts',
    'sharedmodule',
    'src',
    'task.md',
    'tests',
    'tsconfig.jest.json',
    'tsconfig.json',
    'vendor',
    'webui',
  ]);
  const generatedRoots = new Set([
    'artifacts',
    'coverage',
    'dist',
    'logs',
    'node_modules',
    'tmp',
    'test-results',
  ]);
  const localStateRoots = new Set([
    '.agent-state',
    '.cache',
    '.local-index',
    'CACHE.md',
  ]);
  const temporaryLegacyRoots = new Set([]);
  const allowed = new Set([
    ...sourceRoots,
    ...generatedRoots,
    ...localStateRoots,
    ...temporaryLegacyRoots,
  ]);

  const rootEntries = listRootEntries({ includeIgnored: true });
  const unexpected = rootEntries.filter((name) => !allowed.has(name));
  if (unexpected.length) {
    console.error('[repo-sanity] unexpected root entries (top-level is fixed):');
    for (const name of unexpected) console.error(`- ${name}`);
    process.exit(2);
  }
}

function listDirectoryChildren(rootName) {
  if (!fs.existsSync(rootName)) return [];
  const stat = fs.lstatSync(rootName);
  if (!stat.isDirectory()) return [];
  return fs
    .readdirSync(rootName, { withFileTypes: true })
    .map((entry) => entry.name)
    .sort();
}

function checkApprovedGeneratedSubroots() {
  const scopedRoots = [
    {
      root: 'artifacts',
      allowedChildren: new Set(['pack']),
      message: 'artifacts/ may only contain approved generated subroot artifacts/pack',
    },
    {
      root: '.cache',
      allowedChildren: new Set(['model-cache']),
      message: '.cache/ may only contain approved local cache subroot .cache/model-cache',
    },
  ];
  const violations = [];
  for (const scopedRoot of scopedRoots) {
    for (const child of listDirectoryChildren(scopedRoot.root)) {
      if (!scopedRoot.allowedChildren.has(child)) {
        violations.push(`${scopedRoot.message}: ${scopedRoot.root}/${child}`);
      }
    }
  }
  if (violations.length) {
    console.error('[repo-sanity] unexpected generated/local subroot detected:');
    for (const violation of violations) console.error(`- ${violation}`);
    process.exit(2);
  }
}

function checkRootGeneratedResidue() {
  const forbidden = [];
  const rootEntries = listRootEntries({ includeIgnored: true });
  for (const name of rootEntries) {
    const lower = name.toLowerCase();
    if (lower.endsWith('.tgz')) forbidden.push(name);
    if (lower.endsWith('.log')) forbidden.push(name);
    if (name === 'bin' || name === 'lib') forbidden.push(name);
    if (name === '.install-pack') forbidden.push(name);
    if (name === 'clock.md') forbidden.push(name);
    if (name === 'entities.json') forbidden.push(name);
    if (name === 'mempalace.yaml') forbidden.push(name);
    if (name === 'hypatia') forbidden.push(name);
    if (name === '.hypatia' || name === '.hypatia_data') forbidden.push(name);
    if (name === '.codex-work' || name === '.drudge' || name === '.reasonix') forbidden.push(name);
    if (name === 'models') forbidden.push(name);
    if (name === 'package') forbidden.push(name);
    if (name === 'rcc') forbidden.push(name);
  }
  if (forbidden.length) {
    console.error('[repo-sanity] forbidden root generated/local/legacy residue detected:');
    for (const name of Array.from(new Set(forbidden)).sort()) console.error(`- ${name}`);
    process.exit(2);
  }
}

function checkRootWriteSources() {
  const checks = [
    {
      path: 'scripts/pack-mode.mjs',
      forbidden: /spawnSync\('npm',\s*\['pack'\]\)/,
      message: 'scripts/pack-mode.mjs must use --pack-destination under artifacts/pack',
    },
    {
      path: 'scripts/pack-rcc.mjs',
      forbidden: /path\.join\(PROJECT_ROOT,\s*tarballName\)/,
      message: 'scripts/pack-rcc.mjs must read tarballs from artifacts/pack',
    },
    {
      path: 'scripts/install-global.sh',
      forbidden: /\$INSTALL_BUILD_ROOT\/\.install-pack/,
      message: 'scripts/install-global.sh must not use root .install-pack for in-place builds',
    },
    {
      path: 'scripts/tool-classification-report.ts',
      forbidden: /path\.join\(process\.cwd\(\),\s*['"]reports['"]/,
      message: 'scripts/tool-classification-report.ts must write reports under docs/reports',
    },
    {
      path: 'scripts/analyze-tools-fileops.mjs',
      forbidden: /path\.join\(process\.cwd\(\),\s*['"]reports['"]/,
      message: 'scripts/analyze-tools-fileops.mjs must write reports under docs/reports',
    },
  ];
  const hits = [];
  for (const check of checks) {
    if (!fs.existsSync(check.path)) continue;
    const content = fs.readFileSync(check.path, 'utf8');
    if (check.forbidden.test(content)) hits.push(check.message);
  }
  if (hits.length) {
    console.error('[repo-sanity] forbidden root write source detected:');
    for (const hit of hits) console.error(`- ${hit}`);
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
    // OpenRouter API keys.
    { label: 'openrouter_sk', mode: 'E', pattern: String.raw`sk-or-v1-[A-Za-z0-9]{32,}` },
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
        ? [
          'grep',
          '-nF',
          '-e',
          entry.pattern,
          '--',
          '.',
          ':(exclude)scripts/ci/repo-sanity.mjs',
          ':(exclude)scripts/ci/secrets-check.mjs'
        ]
        : [
          'grep',
          '-nE',
          '-e',
          entry.pattern,
          '--',
          '.',
          ':(exclude)scripts/ci/repo-sanity.mjs',
          ':(exclude)scripts/ci/secrets-check.mjs'
        ],
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

function checkLlmswitchRustificationAudit() {
  const out = spawnSync('node', ['scripts/ci/llmswitch-rustification-audit.mjs'], {
    encoding: 'utf8',
  });
  if (out.status !== 0) {
    console.error('[repo-sanity] llmswitch rustification audit failed');
    const stdout = String(out.stdout || '').trim();
    const stderr = String(out.stderr || '').trim();
    if (stdout) console.error(stdout);
    if (stderr) console.error(stderr);
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
checkApprovedGeneratedSubroots();
checkRootGeneratedResidue();
checkRootWriteSources();
checkUntrackedNotIgnored();
checkTrackedSecrets();
checkLlmswitchRustificationAudit();

console.log('[repo-sanity] ok');
