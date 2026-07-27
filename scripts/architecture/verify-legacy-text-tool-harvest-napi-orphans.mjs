#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const gateName = 'verify:legacy-text-tool-harvest-napi-orphans';
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const architectureCi = packageJson.scripts?.['verify:architecture-ci'] ?? '';
const architectureCiLongtail = packageJson.scripts?.['verify:architecture-ci-longtail'] ?? '';
const nativeBuild = packageJson.scripts?.['build:native-hotpath'] ?? '';

if (!architectureCi.includes('npm run verify:architecture-ci-longtail')) {
  console.error(`[${gateName}] verify:architecture-ci must invoke verify:architecture-ci-longtail`);
  process.exit(1);
}
if (!architectureCiLongtail.includes(`npm run ${gateName}`)) {
  console.error(`[${gateName}] verify:architecture-ci-longtail must invoke this gate`);
  process.exit(1);
}
if (!architectureCiLongtail.includes('npm run test:legacy-text-tool-harvest-napi-orphans-red-fixtures')) {
  console.error(`[${gateName}] verify:architecture-ci-longtail must invoke the red fixture`);
  process.exit(1);
}
if (!nativeBuild.includes('npm run verify:legacy-text-tool-harvest-napi-binding')) {
  console.error(`[${gateName}] build:native-hotpath must verify the compiled NAPI binding`);
  process.exit(1);
}

const deletedRustPaths = [
  'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/tool_harvester.rs',
  'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/tool_harvester',
  'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/streaming_tool_extractor.rs',
  'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/streaming_tool_extractor',
];

for (const relativePath of deletedRustPaths) {
  if (fs.existsSync(path.join(root, relativePath))) {
    console.error(`[${gateName}] deleted Rust NAPI surface exists: ${relativePath}`);
    process.exit(1);
  }
}

const crateSourceRoot = path.join(
  root,
  'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src',
);
const forbiddenRustBindings = [
  'mod tool_harvester;',
  'mod streaming_tool_extractor;',
  'harvest_tools_json',
  'extract_streaming_tool_calls_json',
  'create_streaming_tool_extractor_state_json',
  'reset_streaming_tool_extractor_state_json',
  'feed_streaming_tool_extractor_json',
  'harvestToolCallsFromTextJson',
  'harvestToolsJson',
  'extractStreamingToolCallsJson',
  'createStreamingToolExtractorStateJson',
  'resetStreamingToolExtractorStateJson',
  'feedStreamingToolExtractorJson',
];

function collectRustSources(directory, output = []) {
  if (!fs.existsSync(directory)) return output;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      collectRustSources(absolutePath, output);
    } else if (entry.isFile() && entry.name.endsWith('.rs')) {
      output.push(absolutePath);
    }
  }
  return output;
}

function collectTypeScriptSources(directory, output = []) {
  if (!fs.existsSync(directory)) return output;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      collectTypeScriptSources(absolutePath, output);
    } else if (entry.isFile() && /\.(?:ts|tsx|js|mjs|cjs)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      output.push(absolutePath);
    }
  }
  return output;
}

const rustSources = collectRustSources(crateSourceRoot);
const bindingHits = [];
const forbiddenDefaultNapiFunctions = ['harvest_tool_calls_from_text_json'];
for (const sourcePath of rustSources) {
  const source = fs.readFileSync(sourcePath, 'utf8');
  for (const binding of forbiddenRustBindings) {
    if (source.includes(binding)) {
      bindingHits.push(`${path.relative(root, sourcePath)}: ${binding}`);
    }
  }
  for (const functionName of forbiddenDefaultNapiFunctions) {
    const napiExportPattern = new RegExp(
      `#\\[(?:napi_derive::)?napi(?:\\([^\\]]*\\))?\\]\\s*pub\\s+fn\\s+${functionName}\\b`,
      's',
    );
    if (napiExportPattern.test(source)) {
      bindingHits.push(`${path.relative(root, sourcePath)}: #[napi] ${functionName}`);
    }
  }
}
if (bindingHits.length > 0) {
  console.error(`[${gateName}] deleted Rust NAPI bindings exist:`);
  for (const hit of bindingHits) console.error(`- ${hit}`);
  process.exit(1);
}

const forbiddenTypeScriptWrappers = [
  'harvestToolsWithNative',
  'extractStreamingToolCallsWithNative',
  'createStreamingToolExtractorStateWithNative',
  'resetStreamingToolExtractorStateWithNative',
  'feedStreamingToolExtractorWithNative',
];
const typeScriptRoots = [
  path.join(root, 'src'),
  path.join(root, 'sharedmodule/llmswitch-core/src'),
  path.join(root, 'tests/sharedmodule/helpers'),
];
const typeScriptSources = typeScriptRoots.flatMap((sourceRoot) => collectTypeScriptSources(sourceRoot));
const wrapperHits = [];
for (const sourcePath of typeScriptSources) {
  const source = fs.readFileSync(sourcePath, 'utf8');
  for (const wrapper of forbiddenTypeScriptWrappers) {
    if (source.includes(wrapper)) {
      wrapperHits.push(`${path.relative(root, sourcePath)}: ${wrapper}`);
    }
  }
}
if (wrapperHits.length > 0) {
  console.error(`[${gateName}] deleted TypeScript NAPI wrappers exist:`);
  for (const hit of wrapperHits) console.error(`- ${hit}`);
  process.exit(1);
}

const requiredExportsPath = path.join(
  root,
  'sharedmodule/llmswitch-core/native-hotpath-required-exports.json',
);
const requiredExports = JSON.parse(fs.readFileSync(requiredExportsPath, 'utf8'));
const deletedRequiredExports = [
  'harvestToolCallsFromTextJson',
  'harvestToolsJson',
  'extractStreamingToolCallsJson',
  'createStreamingToolExtractorStateJson',
  'resetStreamingToolExtractorStateJson',
  'feedStreamingToolExtractorJson',
];

for (const exportName of deletedRequiredExports) {
  if (requiredExports.includes(exportName)) {
    console.error(`[${gateName}] deleted NAPI export remains required: ${exportName}`);
    process.exit(1);
  }
}

console.log(`[${gateName}] ok`);
console.log(`- deleted Rust surfaces checked: ${deletedRustPaths.length}`);
console.log(`- Rust sources scanned: ${rustSources.length}`);
console.log(`- deleted Rust bindings checked per source: ${forbiddenRustBindings.length}`);
console.log(`- default napi-rs export functions checked per source: ${forbiddenDefaultNapiFunctions.length}`);
console.log(`- TypeScript sources scanned: ${typeScriptSources.length}`);
console.log(`- deleted TypeScript wrappers checked per source: ${forbiddenTypeScriptWrappers.length}`);
console.log(`- deleted required exports checked: ${deletedRequiredExports.length}`);
