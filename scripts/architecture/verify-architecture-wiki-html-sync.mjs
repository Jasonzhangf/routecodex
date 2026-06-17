import fs from 'node:fs';
import path from 'node:path';
import { renderArchitectureWikiHtmlPages } from './wiki-html-lib.mjs';

const root = process.cwd();
const expected = renderArchitectureWikiHtmlPages(root);
const failures = [];

for (const [relPath, content] of expected.entries()) {
  const absPath = path.join(root, relPath);
  if (!fs.existsSync(absPath)) {
    failures.push(`missing render artifact: ${relPath}`);
    continue;
  }
  const current = fs.readFileSync(absPath, 'utf8');
  if (current !== content) {
    failures.push(`${relPath} is out of sync with wiki markdown`);
  }
}

if (failures.length > 0) {
  console.error('[verify:architecture-wiki-html-sync] failed');
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  console.error('- run `npm run render:architecture-wiki-html`');
  process.exit(1);
}

console.log('[verify:architecture-wiki-html-sync] ok');
console.log(`- render artifacts match ${path.join('docs/architecture/wiki/html')}`);
