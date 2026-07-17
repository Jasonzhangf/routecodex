#!/usr/bin/env node
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = process.cwd();
const verifier = resolve(repoRoot, 'scripts/architecture/verify-v3-openai-chat-codec-characterization.mjs');
const fixtures = [
  ['hook registration', 'v3/crates/routecodex-v3-runtime/src/hub_v1/openai_chat_codec.rs', 'use super::{', 'use super::{ compile_v3_hub_v1_static_registry,', /forbidden.*compile_v3_hub_v1_static_registry/],
  ['protocol branch', 'v3/crates/routecodex-v3-runtime/src/hub_v1/openai_chat_codec.rs', 'V3HubEntryProtocol::OpenAiChat', 'V3HubEntryProtocol::Responses', /missing V3HubEntryProtocol::OpenAiChat|forbidden.*Responses/],
  ['side channel', 'v3/crates/routecodex-v3-runtime/src/hub_v1/openai_chat_codec.rs', '"metadata_center"', '"removed_center"', /missing metadata_center/],
  ['tool identity governance revival', 'v3/crates/routecodex-v3-runtime/src/hub_v1/openai_chat_codec.rs', 'fn validate_request(payload: &Value) -> Result<(), V3OpenAiChatCodecError> {', 'fn validate_message_tool_identity() {}\nfn validate_request(payload: &Value) -> Result<(), V3OpenAiChatCodecError> {', /forbidden.*validate_message_tool_identity/],
  ['SSE coverage', 'v3/crates/routecodex-v3-runtime/tests/hub_openai_chat_codec_characterization.rs', 'V3HubTransportIntent::Sse', 'V3HubTransportIntent::Json', /missing V3HubTransportIntent::Sse/],
];
const failures = [];
for (const [name, relative, from, to, diagnostic] of fixtures) {
  const root = mkdtempSync(join(tmpdir(), 'routecodex-v3-openai-chat-codec-red-'));
  try {
    for (const item of ['v3', 'docs', 'scripts', 'package.json']) cpSync(resolve(repoRoot, item), join(root, item), { recursive: true, filter: source => !source.includes('/target/') });
    const target = join(root, relative);
    const source = readFileSync(target, 'utf8');
    if (!source.includes(from)) throw new Error(`${name}: fixture source missing`);
    writeFileSync(target, source.split(from).join(to));
    const result = spawnSync(process.execPath, [verifier], { cwd: root, encoding: 'utf8' });
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    if (result.status === 0) failures.push(`${name}: gate unexpectedly passed`);
    else if (!diagnostic.test(output)) failures.push(`${name}: wrong diagnostic: ${output.slice(-600)}`);
  } finally { rmSync(root, { recursive: true, force: true }); }
}
if (failures.length) {
  console.error('[test:v3-openai-chat-codec-characterization-red-fixtures] failed');
  failures.forEach(failure => console.error(`- ${failure}`));
  process.exit(1);
}
console.log(`[test:v3-openai-chat-codec-characterization-red-fixtures] ok (${fixtures.length} forbidden mutations rejected)`);
