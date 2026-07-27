#!/usr/bin/env node
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const bindingPath = path.resolve(
  process.cwd(),
  process.argv[2] ?? 'sharedmodule/llmswitch-core/dist/native/router_hotpath_napi.node',
);
const binding = require(bindingPath);
const retiredExports = [
  'harvestToolCallsFromTextJson',
  'harvestToolsJson',
  'extractStreamingToolCallsJson',
  'createStreamingToolExtractorStateJson',
  'resetStreamingToolExtractorStateJson',
  'feedStreamingToolExtractorJson',
];
const revived = retiredExports.filter((exportName) => exportName in binding);

if (revived.length > 0) {
  console.error('[verify:legacy-text-tool-harvest-napi-binding] retired exports exist:');
  for (const exportName of revived) console.error(`- ${exportName}`);
  process.exit(1);
}

console.log('[verify:legacy-text-tool-harvest-napi-binding] ok');
console.log(`- binding: ${path.relative(process.cwd(), bindingPath)}`);
console.log(`- retired exports checked: ${retiredExports.length}`);
