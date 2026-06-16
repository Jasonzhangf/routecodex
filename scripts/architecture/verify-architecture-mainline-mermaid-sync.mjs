import fs from 'node:fs';
import path from 'node:path';
import {
  MAINLINE_WIKI_PATH,
  renderMainlineCallGraphMarkdown,
} from './mainline-call-map-lib.mjs';

const root = process.cwd();
const expected = renderMainlineCallGraphMarkdown(root);
const outputPath = path.join(root, MAINLINE_WIKI_PATH);

if (!fs.existsSync(outputPath)) {
  console.error('[verify:architecture-mainline-mermaid-sync] failed');
  console.error(`- missing render artifact: ${MAINLINE_WIKI_PATH}`);
  console.error('- run `npm run render:architecture-mainline-mermaid`');
  process.exit(1);
}

const current = fs.readFileSync(outputPath, 'utf8');

if (current !== expected) {
  console.error('[verify:architecture-mainline-mermaid-sync] failed');
  console.error(`- ${MAINLINE_WIKI_PATH} is out of sync with mainline-call-map.yml`);
  console.error('- run `npm run render:architecture-mainline-mermaid`');
  process.exit(1);
}

console.log('[verify:architecture-mainline-mermaid-sync] ok');
console.log(`- render artifact matches ${MAINLINE_WIKI_PATH}`);
