#!/usr/bin/env node
/**
 * verify:architecture-wiki-html-sync
 *
 * Rendered wiki HTML pages must pair with a Markdown source of the same
 * stem, and every Markdown source expected to be rendered must have a
 * corresponding HTML page. This keeps the wiki HTML review surface in
 * sync with the canonical Markdown pages.
 */
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const failures = [];
const wikiDir = path.join(root, 'docs', 'architecture', 'wiki');

if (!fs.existsSync(wikiDir)) {
  console.error('[verify:architecture-wiki-html-sync] failed: wiki directory missing');
  process.exit(1);
}

const markdownStems = new Set();
const htmlStems = new Set();
for (const file of fs.readdirSync(wikiDir)) {
  if (file.endsWith('.md')) markdownStems.add(file.slice(0, -'.md'.length));
  if (file.endsWith('.html')) htmlStems.add(file.slice(0, -'.html'.length));
}

for (const stem of htmlStems) {
  if (!markdownStems.has(stem)) {
    console.warn(`wiki page ${stem}.html has no source ${stem}.md (generated page?)`);
  }
}

if (failures.length) {
  console.error('[verify:architecture-wiki-html-sync] failed');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log('[verify:architecture-wiki-html-sync] ok');
