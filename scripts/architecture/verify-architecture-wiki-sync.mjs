import fs from 'node:fs';
import path from 'node:path';
import {
  GENERATED_WIKI_PAGES,
  MANUAL_WIKI_PAGES,
  renderGeneratedWikiPages,
  verifyManualWikiPages,
} from './architecture-wiki-lib.mjs';

const root = process.cwd();
const outputs = renderGeneratedWikiPages(root);
const failures = [];

for (const page of GENERATED_WIKI_PAGES) {
  const expected = outputs.get(page.path);
  const absPath = path.join(root, page.path);
  if (!fs.existsSync(absPath)) {
    failures.push(`missing render artifact: ${page.path}`);
    continue;
  }
  const current = fs.readFileSync(absPath, 'utf8');
  if (current !== expected) {
    failures.push(`${page.path} is out of sync`);
  }
}

failures.push(...verifyManualWikiPages(root));

if (failures.length > 0) {
  console.error('[verify:architecture-wiki-sync] failed');
  for (const failure of failures) console.error(`- ${failure}`);
  console.error('- run `node scripts/architecture/render-architecture-wiki-pages.mjs`');
  process.exit(1);
}

console.log('[verify:architecture-wiki-sync] ok');
console.log(`- checked ${GENERATED_WIKI_PAGES.length} generated wiki pages`);
console.log(`- checked ${MANUAL_WIKI_PAGES.length} manual wiki pages`);
