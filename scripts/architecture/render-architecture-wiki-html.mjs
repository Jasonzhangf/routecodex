import fs from 'node:fs';
import path from 'node:path';
import { renderArchitectureWikiHtmlPages } from './wiki-html-lib.mjs';

const root = process.cwd();
const outputs = renderArchitectureWikiHtmlPages(root);

for (const [relPath, content] of outputs.entries()) {
  const absPath = path.join(root, relPath);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, content, 'utf8');
}

console.log('[render:architecture-wiki-html] ok');
for (const relPath of outputs.keys()) {
  console.log(`- wrote ${relPath}`);
}
