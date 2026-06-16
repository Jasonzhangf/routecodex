import fs from 'node:fs';
import path from 'node:path';
import { renderGeneratedWikiPages } from './architecture-wiki-lib.mjs';

const root = process.cwd();
const outputs = renderGeneratedWikiPages(root);

for (const [relPath, content] of outputs.entries()) {
  const absPath = path.join(root, relPath);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, content, 'utf8');
}

console.log('[render:architecture-wiki-pages] ok');
for (const relPath of outputs.keys()) {
  console.log(`- wrote ${relPath}`);
}
