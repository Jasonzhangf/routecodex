import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const distDir = path.join(repoRoot, 'dist');
const tsBuildInfo = path.join(repoRoot, 'tsconfig.tsbuildinfo');

try {
  fs.rmSync(distDir, { recursive: true, force: true });
  console.log(`[clean-dist] removed ${distDir}`);
} catch (err) {
  console.log(`[clean-dist] skip (failed to remove ${distDir}): ${err?.message || String(err)}`);
}

try {
  fs.rmSync(tsBuildInfo, { force: true });
  console.log(`[clean-dist] removed ${tsBuildInfo}`);
} catch {
  // ignore
}
