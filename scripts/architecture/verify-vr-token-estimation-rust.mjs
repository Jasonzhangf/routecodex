#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const crateRoot = path.join(root, 'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi');
const featureFile = path.join(crateRoot, 'src/virtual_router_engine/features.rs');
const cargoFile = path.join(crateRoot, 'Cargo.toml');
const middlewareFile = path.join(root, 'src/server/runtime/http-server/middleware.ts');
const formatFiles = [
  'hub_req_inbound_format_parse.rs',
  'hub_req_outbound_format_build.rs',
  'hub_resp_inbound_format_parse.rs',
].map((file) => path.join(crateRoot, 'src', file));
const retiredVrRootParts = ['sharedmodule/llmswitch-core', 'src', 'router'];
const retiredVrRoot = [...retiredVrRootParts, 'virtual-router'].join('/');
const retiredTsFiles = [
  [retiredVrRoot, 'token-counter.ts'].join('/'),
  [retiredVrRoot, 'token-estimator.ts'].join('/'),
  ['sharedmodule/llmswitch-core/src/native/router-hotpath', 'native-virtual-router-runtime.ts'].join('/'),
];

// canonical builders: estimate_request_tokens, legacy_tiktoken_encoding_name, count_content_tokens

const failures = [];
const read = (file) => fs.readFileSync(file, 'utf8');
const featureSource = read(featureFile);
const cargoSource = read(cargoFile);

if (!cargoSource.includes('tiktoken-rs = ')) {
  failures.push('router-hotpath-napi must depend on Rust tiktoken-rs');
}
if (!featureSource.includes('use tiktoken_rs::')) {
  failures.push('features.rs must use Rust tiktoken-rs');
}
const legacyEncodingFnPattern = new RegExp(`fn\\s+${['legacy', 'tiktoken', 'encoding', 'name'].join('_')}`);
if (!legacyEncodingFnPattern.test(featureSource)) {
  failures.push('features.rs must pin the retired JS tiktoken model table behavior');
}
if (featureSource.includes('get_bpe_from_model') || featureSource.includes('bpe_for_model(')) {
  failures.push('features.rs must not use prefix-based tiktoken-rs model matching for provider aliases');
}
if (/as f64\s*\/\s*(?:3\.2|4\.0|3\.0)/.test(featureSource)) {
  failures.push('features.rs revived character-ratio token estimation');
}
if (/estimate_(?:structured|message).*_chars|structured_chars|total_chars/.test(featureSource)) {
  failures.push('features.rs revived char-count token estimator helpers');
}
if (!featureSource.includes('count_content_object_tokens') || !featureSource.includes('detect_media_kind(map).is_some()')) {
  failures.push('features.rs must omit image/video payload bytes from token counting');
}
if (!/fn\s+count_responses_context_tokens[\s\S]*request\s*\.\s*get\(\s*["']input["']\s*\)/.test(featureSource)) {
  failures.push('features.rs must count top-level Responses input with Rust token estimation');
}
if (!featureSource.includes('estimate_tokens_accounts_for_large_top_level_responses_input_without_metadata_hint')) {
  failures.push('features.rs must lock top-level Responses input token counting');
}
if (/read_finite_floor_i64\s*\(\s*metadata\.get\(\s*["\']estimated(?:InputTokens|Tokens|_tokens)["\']/.test(featureSource)) {
  failures.push('features.rs must not let client metadata token estimates override Rust request token counting');
}
if (/let\s+estimated_tokens\s*=\s*read_finite_floor_i64\s*\(/.test(featureSource)) {
  failures.push('VR route estimated_tokens must come from estimate_request_tokens(request), not metadata hints');
}
if (!featureSource.includes('estimate_tokens_ignores_client_metadata_when_media_payload_is_present')) {
  failures.push('features.rs must lock metadata-estimate override with a media payload regression test');
}
for (const retired of retiredTsFiles) {
  if (fs.existsSync(path.join(root, retired))) {
    failures.push(`${retired} must remain physically removed`);
  }
}

for (const file of formatFiles) {
  const source = read(file);
  if (source.includes('MAX_PAYLOAD_SIZE_BYTES')) {
    failures.push(`${path.relative(root, file)} still owns a fixed Hub payload byte cap`);
  }
  if (/fn\s+validate_payload_size\b|validate_payload_size\(/.test(source)) {
    failures.push(`${path.relative(root, file)} still validates payload bytes inside Hub semantics`);
  }
  if (source.includes('serialized_json_size')) {
    failures.push(`${path.relative(root, file)} still counts serialized size in Hub semantics`);
  }
}
const sharedSource = read(path.join(crateRoot, 'src/shared_json_utils.rs'));
if (/CountingWriter|serialized_json_size/.test(sharedSource)) {
  failures.push('shared_json_utils.rs must not retain dead serialized-size validation helpers');
}
const middlewareSource = read(middlewareFile);
if (!middlewareSource.includes('express.json({ limit: bodyLimit })')) {
  failures.push('HTTP parser bodyLimit must remain the request body allocation guard');
}

if (failures.length) {
  console.error('[verify:vr-token-estimation-rust] failed');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('[verify:vr-token-estimation-rust] ok');
