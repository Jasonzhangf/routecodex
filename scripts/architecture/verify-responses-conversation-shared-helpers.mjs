import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';

// feature_id: hub.responses_conversation_shared_helpers

const root = process.cwd();
const scanRoot = process.env.ROUTECODEX_RESPONSES_HELPER_SCAN_ROOT
  ? path.resolve(root, process.env.ROUTECODEX_RESPONSES_HELPER_SCAN_ROOT)
  : root;
const functionMapPath =
  process.env.ROUTECODEX_FUNCTION_MAP_PATH ?? 'docs/architecture/function-map.yml';
const verificationMapPath =
  process.env.ROUTECODEX_VERIFICATION_MAP_PATH ?? 'docs/architecture/verification-map.yml';
const packageJsonPath = process.env.ROUTECODEX_PACKAGE_JSON_PATH ?? 'package.json';

const featureId = 'hub.responses_conversation_shared_helpers';
const responsesFile =
  'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/shared_responses_conversation_utils.rs';
const sharedJsonFile =
  'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/shared_json_utils.rs';
const execArgsFile =
  'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/resp_process_stage1_tool_governance_blocks/exec_command_args.rs';
const toolArgsFile =
  'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/resp_process_stage1_tool_governance_blocks/tool_args.rs';

const failures = [];

function readText(filePath) {
  return fs.readFileSync(path.resolve(root, filePath), 'utf8');
}

function relFromScanRoot(absPath) {
  return path.relative(scanRoot, absPath).split(path.sep).join('/');
}

function isGeneratedOrExternal(relPath) {
  return /(^|\/)(dist|target|coverage|node_modules|\.git|\.mempalace|\.local-index)\//u.test(relPath);
}

function listScanFiles() {
  if (scanRoot !== root) {
    const out = [];
    const stack = [scanRoot];
    while (stack.length > 0) {
      const current = stack.pop();
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const abs = path.join(current, entry.name);
        const rel = relFromScanRoot(abs);
        if (entry.isDirectory()) {
          if (!isGeneratedOrExternal(`${rel}/`)) stack.push(abs);
          continue;
        }
        if (/\.(rs|json|yml|yaml)$/u.test(entry.name) && !isGeneratedOrExternal(rel)) {
          out.push({ relPath: rel, absPath: abs });
        }
      }
    }
    return out;
  }

  const tracked = spawnSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' });
  const others = spawnSync('git', ['ls-files', '--others', '--exclude-standard'], {
    cwd: root,
    encoding: 'utf8',
  });
  if (tracked.status !== 0 || others.status !== 0) {
    failures.push(`git file discovery failed: ${tracked.stderr || others.stderr || tracked.stdout || others.stdout}`);
    return [];
  }
  return `${tracked.stdout}\n${others.stdout}`
    .split('\n')
    .filter(Boolean)
    .filter((relPath, index, rows) => rows.indexOf(relPath) === index)
    .filter((relPath) => !isGeneratedOrExternal(relPath))
    .filter((relPath) => /\.(rs|json|yml|yaml)$/u.test(relPath))
    .map((relPath) => ({ relPath, absPath: path.join(root, relPath) }));
}

function validateMaps() {
  const functionMap = YAML.parse(readText(functionMapPath));
  const verificationMap = YAML.parse(readText(verificationMapPath));
  const packageJson = JSON.parse(readText(packageJsonPath));
  const scripts = packageJson.scripts ?? {};

  const owner = (functionMap?.owners ?? []).find((row) => row?.feature_id === featureId);
  if (!owner) {
    failures.push(`function-map missing feature_id: ${featureId}`);
  } else {
    if (owner.owner_module !== sharedJsonFile) {
      failures.push(`function-map ${featureId}: owner_module must be ${sharedJsonFile}`);
    }
    for (const requiredPath of [responsesFile, sharedJsonFile, execArgsFile, toolArgsFile]) {
      if (!Array.isArray(owner.allowed_paths) || !owner.allowed_paths.includes(requiredPath)) {
        failures.push(`function-map ${featureId}: missing allowed path ${requiredPath}`);
      }
    }
  }

  const verification = (verificationMap?.verification ?? []).find((row) => row?.feature_id === featureId);
  if (!verification) {
    failures.push(`verification-map missing feature_id: ${featureId}`);
  }

  for (const scriptName of [
    'verify:responses-conversation-shared-helpers',
    'test:responses-conversation-shared-helpers-red-fixtures',
  ]) {
    if (!Object.hasOwn(scripts, scriptName)) {
      failures.push(`package.json missing script: ${scriptName}`);
    }
  }

  const longtail = scripts['verify:architecture-ci-longtail'] ?? '';
  for (const gate of [
    'npm run test:responses-conversation-shared-helpers-red-fixtures',
    'npm run verify:responses-conversation-shared-helpers',
  ]) {
    if (!longtail.includes(gate)) {
      failures.push(`verify:architecture-ci-longtail missing ${gate}`);
    }
  }
}

function hasLocalNestedKeyHelper(source) {
  return new RegExp('^fn\\s+args_contain_direct_or_nested_key\\s*\\(', 'mu').test(source)
    || new RegExp('^pub\\(crate\\)\\s+fn\\s+args_contain_direct_or_nested_key\\s*\\(', 'mu').test(source);
}

function validateSource() {
  const files = new Map(listScanFiles().map((row) => [row.relPath, row]));
  for (const requiredFile of [responsesFile, sharedJsonFile, execArgsFile, toolArgsFile]) {
    if (!files.has(requiredFile)) {
      failures.push(`${requiredFile}: missing required source file`);
    }
  }
  if (failures.length > 0) return;

  const responsesSource = fs.readFileSync(files.get(responsesFile).absPath, 'utf8');
  const sharedJsonSource = fs.readFileSync(files.get(sharedJsonFile).absPath, 'utf8');
  const execArgsSource = fs.readFileSync(files.get(execArgsFile).absPath, 'utf8');
  const toolArgsSource = fs.readFileSync(files.get(toolArgsFile).absPath, 'utf8');

  if (!hasLocalNestedKeyHelper(sharedJsonSource)) {
    failures.push(`${sharedJsonFile}: missing shared args_contain_direct_or_nested_key helper`);
  }
  for (const [filePath, source] of [
    [responsesFile, responsesSource],
    [execArgsFile, execArgsSource],
  ]) {
    if (hasLocalNestedKeyHelper(source)) {
      failures.push(`${filePath}: reintroduced local duplicate args_contain_direct_or_nested_key helper`);
    }
  }
  if (!responsesSource.includes('shared_json_utils') || !responsesSource.includes('args_contain_direct_or_nested_key')) {
    failures.push(`${responsesFile}: must import args_contain_direct_or_nested_key from shared_json_utils`);
  }
  if (!toolArgsSource.includes('shared_json_utils') || !toolArgsSource.includes('args_contain_direct_or_nested_key')) {
    failures.push(`${toolArgsFile}: must import args_contain_direct_or_nested_key from shared_json_utils`);
  }
}

validateMaps();
validateSource();

if (failures.length > 0) {
  console.error('[verify:responses-conversation-shared-helpers] failed');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('[verify:responses-conversation-shared-helpers] ok');
console.log('- Responses conversation and exec_command blocks share nested argument key detection through shared_json_utils');
