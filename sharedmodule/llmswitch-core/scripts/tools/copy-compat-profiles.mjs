import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const srcDir = path.join(repoRoot, 'src', 'conversion', 'compat', 'profiles');
const destDir = path.join(repoRoot, 'dist', 'conversion', 'compat', 'profiles');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function copyProfiles() {
  if (!fs.existsSync(srcDir)) {
    return;
  }
  ensureDir(destDir);
  const entries = fs.readdirSync(srcDir);
  let copied = 0;
  for (const entry of entries) {
    if (!entry.endsWith('.json')) {
      continue;
    }
    const from = path.join(srcDir, entry);
    const to = path.join(destDir, entry);
    fs.copyFileSync(from, to);
    copied += 1;
  }
  console.log(`[compat] Copied ${copied} profile(s) to ${destDir}`);
}

copyProfiles();
