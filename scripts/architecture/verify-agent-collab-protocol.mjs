import fs from 'node:fs';
import path from 'node:path';

// feature_id: architecture.agent_collab_protocol
const args = process.argv.slice(2);
const rootArgIndex = args.indexOf('--root');
const root = rootArgIndex === -1 ? process.cwd() : path.resolve(args[rootArgIndex + 1] || '');
const collabDir = path.join(root, '.agent-collab');

const schemaRequiredFields = {
  'actor.schema.json': ['run_id', 'cwd', 'git_worktree', 'created_at'],
  'heartbeat.schema.json': ['run_id', 'status', 'updated_at'],
  'owner.schema.json': ['semantic_id', 'run_id', 'status', 'created_at', 'ttl_seconds', 'allowed_paths', 'required_gates'],
  'event.schema.json': ['run_id', 'event_type', 'timestamp'],
  'evidence.schema.json': ['run_id', 'claim', 'command_or_check', 'result', 'timestamp'],
};

const exampleChecks = [
  { file: 'actor.json', schema: 'actor.schema.json', jsonl: false },
  { file: 'owner.json', schema: 'owner.schema.json', jsonl: false },
  { file: 'heartbeat.json', schema: 'heartbeat.schema.json', jsonl: false },
  { file: 'events.jsonl', schema: 'event.schema.json', jsonl: true },
  { file: 'evidence.jsonl', schema: 'evidence.schema.json', jsonl: true },
];

const failures = [];

function readText(relativePath) {
  const fullPath = path.join(root, relativePath);
  if (!fs.existsSync(fullPath)) {
    failures.push(`${relativePath} is missing`);
    return null;
  }
  return fs.readFileSync(fullPath, 'utf8');
}

function readJson(relativePath) {
  const text = readText(relativePath);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch (error) {
    failures.push(`${relativePath} is not parseable JSON: ${error.message}`);
    return null;
  }
}

function assertIncludes(haystack, needle, message) {
  if (!haystack.includes(needle)) failures.push(message);
}

function assertRegex(haystack, regex, message) {
  if (!regex.test(haystack)) failures.push(message);
}

function assertRequiredFields(subject, requiredFields, label) {
  if (!subject || typeof subject !== 'object' || Array.isArray(subject)) {
    failures.push(`${label} must be a JSON object`);
    return;
  }
  for (const field of requiredFields) {
    if (!Object.hasOwn(subject, field)) {
      failures.push(`${label} missing required field: ${field}`);
    }
  }
}

function assertSchemaRequired(schemaFile, schema) {
  const requiredFields = schemaRequiredFields[schemaFile];
  const label = `.agent-collab/schema/${schemaFile}`;
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    failures.push(`${label} must be a JSON object`);
    return;
  }
  if (schema.type !== 'object') failures.push(`${label} must declare type: object`);
  if (!Array.isArray(schema.required)) {
    failures.push(`${label} must declare required fields`);
    return;
  }
  for (const field of requiredFields) {
    if (!schema.required.includes(field)) {
      failures.push(`${label} must require ${field}`);
    }
  }
}

function parseJsonl(relativePath) {
  const text = readText(relativePath);
  if (text === null) return [];
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length === 0) {
    failures.push(`${relativePath} must contain at least one JSONL record`);
    return [];
  }
  return lines.map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      failures.push(`${relativePath}:${index + 1} is not parseable JSON: ${error.message}`);
      return null;
    }
  }).filter(Boolean);
}

const protocol = readText('.agent-collab/PROTOCOL.md');
if (protocol !== null) {
  assertRegex(protocol, /black-box multi-worker/i, 'protocol must state the worker black-box assumption');
  assertIncludes(protocol, 'run_id', 'protocol must require run_id');
  assertRegex(protocol, /worker_id[^.\n]+optional|optional[^.\n]+worker_id/i, 'protocol must state worker_id is optional');
  assertRegex(protocol, /semantic claims|Claims bind semantic ownership/i, 'protocol must require semantic claims');
  assertRegex(protocol, /not raw file paths|not ownership identity/i, 'protocol must reject file-path-only claims');
  assertIncludes(protocol, 'mkdir .agent-collab/claims/<semantic_id>', 'protocol must specify atomic claim acquisition with mkdir .agent-collab/claims/<semantic_id>');
  assertIncludes(protocol, 'feature_id', 'protocol must prefer feature_id semantic claims');
  assertIncludes(protocol, 'resource_id', 'protocol must prefer resource_id semantic claims');
  assertIncludes(protocol, 'mainline_node_id', 'protocol must prefer mainline_node_id semantic claims');
  assertIncludes(protocol, 'gate_id', 'protocol must prefer gate_id semantic claims');
  assertRegex(protocol, /stale heartbeat[^.\n]+not automatic takeover permission|stale heartbeat[^.\n]+does not authorize/i, 'protocol must forbid stale heartbeat automatic takeover');
  assertIncludes(protocol, 'evidence.jsonl', 'protocol must require evidence.jsonl for completion');
  assertRegex(protocol, /completion claim is invalid without `?evidence\.jsonl`?/i, 'protocol must say completion requires evidence.jsonl');
  assertRegex(protocol, /handoff\/|merge-queue\//, 'protocol must mention handoff/ or merge-queue/');
  assertRegex(protocol, /defaults to `?handoff\/`? or `?merge-queue\/`?|defaults to `?merge-queue\/`? or `?handoff\/`?/i, 'protocol must say merge/handoff defaults to merge-queue/ or handoff/');
  assertRegex(protocol, /Do not use broad process-kill|broad process-kill/i, 'protocol must forbid broad kill commands');
  assertRegex(protocol, /Do not use destructive git|destructive git/i, 'protocol must forbid destructive git cleanup');
  assertRegex(protocol, /Do not treat fallback|silent success/i, 'protocol must forbid fallback or silent success evidence');
}

const schemas = {};
for (const schemaFile of Object.keys(schemaRequiredFields)) {
  const schema = readJson(path.join('.agent-collab/schema', schemaFile));
  schemas[schemaFile] = schema;
  assertSchemaRequired(schemaFile, schema);
}

for (const check of exampleChecks) {
  const relativePath = path.join('.agent-collab/examples', check.file);
  const requiredFields = schemaRequiredFields[check.schema];
  if (check.jsonl) {
    const records = parseJsonl(relativePath);
    for (const [index, record] of records.entries()) {
      assertRequiredFields(record, requiredFields, `${relativePath}:${index + 1}`);
    }
  } else {
    const example = readJson(relativePath);
    assertRequiredFields(example, requiredFields, relativePath);
  }
}

const handoff = readJson('.agent-collab/examples/handoff.json');
if (handoff) {
  assertRequiredFields(handoff, ['run_id', 'claim', 'target', 'changed_scope', 'required_gates', 'evidence', 'created_at'], '.agent-collab/examples/handoff.json');
  if (!['handoff', 'merge-queue'].includes(handoff.target)) {
    failures.push('.agent-collab/examples/handoff.json target must be handoff or merge-queue');
  }
}

if (!fs.existsSync(collabDir)) {
  failures.push('.agent-collab directory is missing');
}

if (failures.length > 0) {
  console.error('[verify:agent-collab-protocol] failed');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('[verify:agent-collab-protocol] ok');
console.log('- protocol required terms checked');
console.log(`- schemas checked: ${Object.keys(schemaRequiredFields).length}`);
console.log(`- examples checked: ${exampleChecks.length + 1}`);
