import fs from 'node:fs';
import path from 'node:path';
import {
  MAINLINE_WIKI_PATH,
  renderMainlineCallGraphMarkdown,
} from './mainline-call-map-lib.mjs';

const root = process.cwd();
const output = renderMainlineCallGraphMarkdown(root);
const outputPath = path.join(root, MAINLINE_WIKI_PATH);

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, output, 'utf8');

console.log('[render:architecture-mainline-mermaid] ok');
console.log(`- wrote ${MAINLINE_WIKI_PATH}`);
