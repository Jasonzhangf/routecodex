#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import YAML from 'yaml';

const MANIFEST = 'docs/architecture/manifests/v3.stage_protocol_shape_contract.yml';
const DESIGN = 'docs/design/v3-stage-protocol-shape-contract.md';
const PACKAGE = 'package.json';
const UMBRELLA = 'scripts/architecture/verify-v3-architecture-ci.mjs';
const MAINLINE = 'docs/architecture/v3-mainline-call-map.yml';
const SERVER_OUTCOME = 'v3/crates/routecodex-v3-server/src/responses_direct_server_outcome.rs';
const DIRECT_RUNTIME_SOURCE_ROOTS = [
  'v3/crates/routecodex-v3-runtime/src/kernel.rs',
  'v3/crates/routecodex-v3-runtime/src/kernel',
  'v3/crates/routecodex-v3-runtime/src/hooks.rs',
];

const REQUIRED_CHAINS = new Map([
  ['v3.relay.request.stage_shapes', [
    ['V3HubReqInbound01ClientRaw', 'source_request_wire', 'source_request_wire'],
    ['V3HubReqInbound02Normalized', 'source_request_wire', 'canonical_chat_request'],
    ['V3HubReqContinuation03Classified', 'canonical_chat_request', 'canonical_chat_request'],
    ['V3HubReqChatProcess04Governed', 'canonical_chat_request', 'canonical_chat_request'],
    ['V3HubReqExecution05Planned', 'canonical_chat_request', 'canonical_chat_request'],
    ['V3HubReqTarget06Resolved', 'canonical_chat_request', 'canonical_chat_request'],
    ['V3HubReqOutbound07ProviderSemantic', 'canonical_chat_request', 'canonical_chat_request'],
    ['ProviderReqCompat06ProviderCompat', 'canonical_chat_request', 'provider_request_semantic'],
    ['V3ProviderReqOutbound08WirePayload', 'provider_request_semantic', 'provider_request_wire'],
    ['V3ProviderReqOutbound09TransportRequest', 'provider_request_wire', 'provider_request_wire'],
  ]],
  ['v3.relay.response.stage_shapes', [
    ['V3ProviderRespInbound01Raw', 'provider_response_wire', 'provider_response_wire'],
    ['ProviderRespCompat02ProviderCompat', 'provider_response_wire', 'provider_response_wire'],
    ['V3HubRespInbound02Normalized', 'provider_response_wire', 'canonical_chat_response'],
    ['V3HubRespChatProcess03Governed', 'canonical_chat_response', 'canonical_chat_response'],
    ['V3HubRespContinuation04Committed', 'canonical_chat_response', 'canonical_chat_response'],
    ['V3HubRespOutbound05ClientSemantic', 'canonical_chat_response', 'client_response_semantic'],
    ['V3ServerRespOutbound06ClientFrame', 'client_response_semantic', 'client_response_semantic'],
  ]],
  ['v3.direct.same_protocol.stage_shapes', [
    ['V3ResponsesDirect11Policy', 'same_protocol_request', 'same_protocol_request'],
    ['V3Provider12ResponsesWirePayload', 'same_protocol_request', 'same_protocol_request'],
    ['V3Transport13ResponsesHttpRequest', 'same_protocol_request', 'same_protocol_request'],
    ['V3ProviderResp14Raw', 'same_protocol_response', 'same_protocol_response'],
    ['V3DirectResp14ProviderProjectionPrepared', 'same_protocol_response', 'same_protocol_response'],
    ['V3DirectResp15ClientPayloadReady', 'same_protocol_response', 'same_protocol_response'],
  ]],
]);

function read(root, relative) {
  return fs.readFileSync(path.join(root, relative), 'utf8');
}

function readRustSources(root, relative) {
  const sourcePath = path.join(root, relative);
  if (!fs.existsSync(sourcePath)) return [];
  const stat = fs.statSync(sourcePath);
  if (stat.isFile()) return relative.endsWith('.rs') ? [read(root, relative)] : [];
  return fs.readdirSync(sourcePath, { withFileTypes: true }).flatMap((entry) => {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) return readRustSources(root, child);
    return entry.isFile() && entry.name.endsWith('.rs') ? [read(root, child)] : [];
  });
}

function matchingDelimiter(source, start, open, close) {
  let depth = 0;
  for (let index = start; index < source.length; index += 1) {
    if (source[index] === open) depth += 1;
    if (source[index] === close) depth -= 1;
    if (depth === 0) return index;
  }
  return -1;
}

function splitTopLevel(source, delimiter) {
  const values = [];
  let start = 0;
  let round = 0;
  let square = 0;
  let angle = 0;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char === '(') round += 1;
    else if (char === ')') round -= 1;
    else if (char === '[') square += 1;
    else if (char === ']') square -= 1;
    else if (char === '<') angle += 1;
    else if (char === '>') angle -= 1;
    else if (char === delimiter && round === 0 && square === 0 && angle === 0) {
      values.push(source.slice(start, index));
      start = index + 1;
    }
  }
  values.push(source.slice(start));
  return values;
}

function normalizeRustType(value) {
  return value.replace(/\s+/gu, ' ').replace(/\s*([<>,&])\s*/gu, '$1').trim();
}

function rustFunctionSignature(source, owner) {
  const [implOwner, functionName = implOwner] = owner.split('::');
  const functionPattern = new RegExp(`\\bfn\\s+${functionName}\\b`, 'gu');
  for (const match of source.matchAll(functionPattern)) {
    const openParen = source.indexOf('(', match.index + match[0].length);
    if (openParen < 0) continue;
    const closeParen = matchingDelimiter(source, openParen, '(', ')');
    if (closeParen < 0) continue;
    if (owner.includes('::')) {
      const implPattern = new RegExp(`\\bimpl(?:\\s*<[^{}]*>)?\\s+${implOwner.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}\\s*\\{`, 'gu');
      const implMatch = [...source.matchAll(implPattern)].find((candidate) => {
        const openBrace = source.indexOf('{', candidate.index);
        return match.index > openBrace && match.index < matchingDelimiter(source, openBrace, '{', '}');
      });
      if (!implMatch) continue;
    }
    const parameters = splitTopLevel(source.slice(openParen + 1, closeParen), ',')
      .map((parameter) => parameter.trim())
      .filter(Boolean)
      .map((parameter) => {
        const separator = splitTopLevel(parameter, ':');
        return normalizeRustType(separator.length > 1 ? separator.slice(1).join(':') : separator[0]);
      });
    const bodyStart = source.indexOf('{', closeParen);
    const suffix = source.slice(closeParen + 1, bodyStart);
    const returnMatch = suffix.match(/->\s*([^\n{]+?)(?:\s+where\b|$)/su);
    return {
      implOwner: owner.includes('::') ? implOwner : null,
      parameters,
      returnType: normalizeRustType(returnMatch?.[1] ?? '()'),
    };
  }
  return null;
}

function validateStageSignature(root, stage) {
  if (!stage?.validator_owner || !stage?.validator_source) return 'missing validator owner/source';
  if (!stage.validator_source.endsWith('.rs')) return 'validator source must be Rust';
  const sourcePath = path.join(root, stage.validator_source);
  if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) return 'validator source is missing';
  const signature = rustFunctionSignature(fs.readFileSync(sourcePath, 'utf8'), stage.validator_owner);
  if (!signature) return 'validator owner is not a real Rust function in validator_source';
  if (stage.validator_impl && signature.implOwner !== stage.validator_impl) {
    return `validator must belong to impl ${stage.validator_impl}`;
  }
  const expectedInputs = (stage.validator_input_types ?? []).map(normalizeRustType);
  if (JSON.stringify(signature.parameters) !== JSON.stringify(expectedInputs)) {
    return `validator input types must be ${expectedInputs.join(', ')}`;
  }
  if (signature.returnType !== normalizeRustType(stage.validator_output_type ?? '')) {
    return `validator output type must be ${stage.validator_output_type}`;
  }
  return null;
}

export function verifyV3StageProtocolShapes(root = process.cwd()) {
  const failures = [];
  for (const relative of [MANIFEST, DESIGN, PACKAGE, UMBRELLA, MAINLINE, SERVER_OUTCOME]) {
    if (!fs.existsSync(path.join(root, relative))) failures.push(`missing ${relative}`);
  }
  if (failures.length > 0) return failures;

  const manifest = YAML.parse(read(root, MANIFEST));
  if (manifest?.status !== 'active') failures.push(`${MANIFEST}: status must be active`);
  if (manifest?.rules?.direct_same_protocol?.protocol_identity !== 'same_as_entry') {
    failures.push(`${MANIFEST}: Direct protocol identity must remain same_as_entry`);
  }
  if (manifest?.rules?.control_fields?.carrier !== 'typed_side_channel_only'
    || !(manifest?.rules?.control_fields?.forbidden_in_payload ?? []).includes('metadata_center')) {
    failures.push(`${MANIFEST}: control fields must remain typed-side-channel-only and forbidden in payload`);
  }
  const shapes = manifest?.shape_contracts ?? {};
  for (const shape of new Set([...REQUIRED_CHAINS.values()].flatMap((rows) => rows.flatMap((row) => row.slice(1))))) {
    if (!shapes[shape]?.field_registry) failures.push(`${MANIFEST}: shape ${shape} must bind a field_registry`);
  }

  const chains = new Map((manifest?.chains ?? []).map((chain) => [chain.chain_id, chain]));
  const mainline = YAML.parse(read(root, MAINLINE));
  const mainlineEdges = new Map((mainline?.chains ?? []).flatMap((chain) => chain.edges ?? []).map((edge) => [edge.step_id, edge]));
  for (const [chainId, expected] of REQUIRED_CHAINS) {
    const chain = chains.get(chainId);
    if (!chain) {
      failures.push(`${MANIFEST}: missing chain ${chainId}`);
      continue;
    }
    if (chain.stages?.length !== expected.length) {
      failures.push(`${MANIFEST}: ${chainId} stage count must be ${expected.length}`);
      continue;
    }
    for (let index = 0; index < expected.length; index += 1) {
      const stage = chain.stages[index];
      const [nodeId, entryShape, exitShape] = expected[index];
      if (stage?.node_id !== nodeId || stage?.entry_shape !== entryShape || stage?.exit_shape !== exitShape) {
        failures.push(`${MANIFEST}: ${chainId}[${index}] must be ${nodeId} ${entryShape} -> ${exitShape}`);
      }
      const signatureFailure = validateStageSignature(root, stage);
      if (signatureFailure) failures.push(`${MANIFEST}: ${nodeId} ${signatureFailure}`);
      const crossesDirectTransportBoundary = chainId === 'v3.direct.same_protocol.stage_shapes'
        && stage?.node_id === 'V3ProviderResp14Raw';
      if (index > 0 && !crossesDirectTransportBoundary && chain.stages[index - 1]?.exit_shape !== stage?.entry_shape) {
        failures.push(`${MANIFEST}: ${chainId} shape discontinuity before ${nodeId}`);
      }
    }
    const stepIds = chain.mainline_step_ids ?? [];
    if (stepIds.length !== expected.length - 1) {
      failures.push(`${MANIFEST}: ${chainId} must bind ${expected.length - 1} adjacent mainline steps`);
    } else {
      for (let index = 0; index < stepIds.length; index += 1) {
        const edge = mainlineEdges.get(stepIds[index]);
        const fromNode = expected[index][0];
        const toNode = expected[index + 1][0];
        if (!edge || edge.status !== 'anchored' || edge.from_node !== fromNode || edge.to_node !== toNode) {
          failures.push(`${MAINLINE}: ${stepIds[index]} must be anchored ${fromNode} -> ${toNode}`);
        }
      }
    }
  }

  const direct = chains.get('v3.direct.same_protocol.stage_shapes');
  if (direct?.protocol_identity !== 'same_as_entry') failures.push(`${MANIFEST}: Direct chain must declare same_as_entry`);
  if ((direct?.stages ?? []).some((stage) => !stage.entry_shape.startsWith('same_protocol_') || stage.entry_shape !== stage.exit_shape)) {
    failures.push(`${MANIFEST}: every Direct stage must preserve its same-protocol shape`);
  }
  const directSources = DIRECT_RUNTIME_SOURCE_ROOTS.flatMap((relative) => readRustSources(root, relative)).join('\n');
  // chat canonical -> openai chat wire 是共享 codec 库函数（request_outbound_format，
  // direct 与 relay 共用同一出站 codec）；仅禁止 direct 复用 relay 的响应侧转换。
  for (const forbidden of ['build_v3_openai_responses_standard_request_from_chat_canonical', 'encode_v3_responses_semantic_as_anthropic_request']) {
    if (directSources.includes(forbidden)) failures.push(`Direct runtime must not invoke relay codec ${forbidden}`);
  }
  for (const required of [
    'pub request_local_excluded_candidates: BTreeSet<String>',
    'captured_target_09,\n                failed_candidates.clone(),\n                trace,',
    'let mut failed_candidates = initial_request_local_excluded_candidates;',
  ]) {
    if (!directSources.includes(required)) failures.push(`Direct-to-Relay handoff must preserve request-local exclusions: missing ${required}`);
  }
  const serverOutcome = read(root, SERVER_OUTCOME);
  if (!serverOutcome.includes('handoff.request_local_excluded_candidates')) {
    failures.push('Direct-to-Relay server handoff must pass request-local exclusions into Relay');
  }

  const packageJson = JSON.parse(read(root, PACKAGE));
  if (!packageJson.scripts?.['verify:v3-architecture-ci']?.includes('verify-v3-architecture-ci.mjs')) failures.push(`${PACKAGE}: V3 architecture umbrella missing`);
  if (!packageJson.scripts?.['build:v3-cli']?.startsWith('npm run verify:v3-architecture-ci')) failures.push(`${PACKAGE}: build:v3-cli must run architecture CI before Cargo`);
  const umbrella = read(root, UMBRELLA);
  for (const gate of ['verify:v3-stage-protocol-shapes', 'test:v3-stage-protocol-shapes-red-fixtures']) {
    if (!umbrella.includes(gate)) failures.push(`${UMBRELLA}: missing ${gate}`);
  }
  return failures;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const failures = verifyV3StageProtocolShapes();
  if (failures.length > 0) {
    console.error(failures.join('\n'));
    process.exit(1);
  }
  console.log('[verify:v3-stage-protocol-shapes] PASS: Direct same-protocol and Relay stage-shape contracts are build-wired');
}
