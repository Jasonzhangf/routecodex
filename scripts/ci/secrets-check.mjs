import { spawnSync } from 'node:child_process';

const patterns = [
  { label: 'openai_sk', mode: 'E', pattern: String.raw`sk-[A-Za-z0-9]{20,}` },
  { label: 'openrouter_sk', mode: 'E', pattern: String.raw`sk-or-v1-[A-Za-z0-9]{32,}` },
  { label: 'google_api_key', mode: 'E', pattern: String.raw`AIza[0-9A-Za-z\-_]{20,}` },
  { label: 'github_pat', mode: 'E', pattern: String.raw`ghp_[A-Za-z0-9]{30,}` },
  { label: 'private_key', mode: 'F', pattern: '-----BEGIN PRIVATE KEY-----' },
  { label: 'rsa_private_key', mode: 'F', pattern: '-----BEGIN RSA PRIVATE KEY-----' },
  { label: 'ec_private_key', mode: 'F', pattern: '-----BEGIN EC PRIVATE KEY-----' }
];

function runGitGrep(entry) {
  const args =
    entry.mode === 'F'
      ? ['grep', '-nF', '-e', entry.pattern, '--', '.', ':(exclude)scripts/ci/repo-sanity.mjs', ':(exclude)scripts/ci/secrets-check.mjs']
      : ['grep', '-nE', '-e', entry.pattern, '--', '.', ':(exclude)scripts/ci/repo-sanity.mjs', ':(exclude)scripts/ci/secrets-check.mjs'];
  const out = spawnSync('git', args, { encoding: 'utf8' });
  if ((out.status ?? 0) > 1) {
    throw new Error(`git grep failed for ${entry.label}: ${out.stderr || out.stdout}`);
  }
  if (out.status !== 0) {
    return [];
  }
  return String(out.stdout || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => `[${entry.label}] ${line}`);
}

const hits = [];
for (const entry of patterns) {
  hits.push(...runGitGrep(entry));
}

if (hits.length) {
  console.error('[secrets-check] potential secrets detected in tracked files:');
  for (const line of hits.slice(0, 200)) {
    console.error(`- ${line}`);
  }
  if (hits.length > 200) {
    console.error(`- ... (${hits.length - 200} more)`);
  }
  process.exit(2);
}

console.log('[secrets-check] ok');
