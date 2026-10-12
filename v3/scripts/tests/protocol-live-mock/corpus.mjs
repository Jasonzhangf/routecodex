// Corpus loader and definition validator for the protocol live mock matrix.
//
// This module is import-safe: it performs no I/O and starts no listener until
// loadFixtures/inspectCorpus is called. It validates only the definitions the
// runner needs in order to execute the corpus. It does not judge product
// semantics and it never rewrites caller payloads.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

export const HARNESS_ID = 'v3.protocol_live_mock_matrix';
export const SCHEMA_VERSION = 1;
export const SOURCE_REPO = 'https://github.com/yetone/magpie';
export const SOURCE_SHA = 'bfaedf18301d02a423bd5422d22e41432d231ab8';
export const SOURCE_LICENSE = 'MIT';

export const PROTOCOLS = Object.freeze(['openai_chat', 'responses', 'anthropic', 'gemini']);
export const CELL_TRANSPORTS = Object.freeze(['json', 'sse']);
export const CELL_MODES = Object.freeze(['direct', 'relay']);
export const SCRIPT_MODES = Object.freeze(['json', 'sse', 'fault']);
export const CLIENT_TRANSPORTS = Object.freeze(['complete', 'closed']);

const PROTOCOL_SET = new Set(PROTOCOLS);
const TRANSPORT_SET = new Set(CELL_TRANSPORTS);
const MODE_SET = new Set(CELL_MODES);
const SCRIPT_SET = new Set(SCRIPT_MODES);
const CLIENT_TRANSPORT_SET = new Set(CLIENT_TRANSPORTS);
const ID_PATTERN = /^[a-z0-9-]+$/;
const PROVIDER_ID_PATTERN = /^[A-Za-z0-9_.-]+$/;
const RUNTIME_SETUP_KEYS = new Set(['provider_id', 'model', 'wire_model', 'candidate_ids', 'all_candidates_fail']);

export class CorpusError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CorpusError';
  }
}

// loadFixtures(root) -> sorted [{ relative, value }] compatible with the main
// runner: each entry keeps the parsed fixture object untouched for execution.
export function loadFixtures(root) {
  const fixtureRoot = resolve(root);
  const manifest = readJson(join(fixtureRoot, 'manifest.json'), `fixture manifest missing: ${join(fixtureRoot, 'manifest.json')}`);
  assertManifest(manifest);
  const declared = manifest.cases;
  const casesDir = join(fixtureRoot, 'cases');
  if (!existsSync(casesDir) || !statSync(casesDir).isDirectory()) {
    throw new CorpusError(`fixture cases directory missing: ${casesDir}`);
  }
  const files = readdirSync(casesDir).filter((name) => name.endsWith('.json')).sort();
  const loaded = [];
  const byId = new Map();
  const fileIds = new Set();
  for (const name of files) {
    const fileId = basename(name, '.json');
    if (fileIds.has(fileId)) throw new CorpusError(`duplicate fixture file: cases/${name}`);
    fileIds.add(fileId);
    const relative = join('cases', name);
    const value = readJson(join(casesDir, name), `fixture case unreadable: ${relative}`);
    if (!isObject(value)) throw new CorpusError(`fixture case must be an object: ${relative}`);
    if (typeof value.case_id !== 'string' || value.case_id !== fileId) {
      throw new CorpusError(`fixture case_id mismatch: ${relative} declares ${value.case_id ?? 'null'}`);
    }
    if (byId.has(fileId)) throw new CorpusError(`duplicate case_id: ${fileId}`);
    byId.set(fileId, value);
    loaded.push({ relative, value });
  }
  for (const caseId of declared) {
    if (!byId.has(caseId)) throw new CorpusError(`manifest case missing on disk: ${caseId}`);
  }
  for (const caseId of byId.keys()) {
    if (!declared.includes(caseId)) throw new CorpusError(`case not declared in manifest: ${caseId}`);
  }
  return loaded.sort((left, right) => left.relative.localeCompare(right.relative));
}

// inspectCorpus(root, options) -> structured report. Structural load problems
// throw (CorpusError); per-case definition problems are returned as findings so
// the caller can report every current issue at once.
export function inspectCorpus(root, options = {}) {
  const loaded = loadFixtures(root);
  const findings = [];
  const extensions = [];
  for (const entry of loaded) {
    for (const finding of validateCase(entry.relative, entry.value)) findings.push(finding);
    if (!isBaseCaseId(entry.value.case_id)) extensions.push(entry.value.case_id);
  }
  const coverage = corpusCoverage(loaded);
  const sourceRefs = options.magpieRoot ? checkSourceRefs(loaded, options.magpieRoot) : { checked: false, stale_files: [], stale_tests: [] };
  return { ok: findings.length === 0, case_count: loaded.length, fixtures: loaded, findings, coverage, extensions: extensions.sort(), source_refs: sourceRefs };
}

export function validateCase(relative, value) {
  const findings = [];
  const fail = (message) => findings.push(`${relative}: ${message}`);
  if (!isObject(value)) {
    fail('case must be an object');
    return findings;
  }
  if (typeof value.case_id !== 'string' || !ID_PATTERN.test(value.case_id)) fail(`case_id invalid: ${value.case_id ?? 'null'}`);
  if (value.schema_version !== SCHEMA_VERSION) fail(`schema_version must be ${SCHEMA_VERSION}: ${value.schema_version ?? 'null'}`);
  const cell = value.cell;
  if (!isObject(cell)) {
    fail('cell object missing');
  } else {
    if (!PROTOCOL_SET.has(cell.entry_protocol)) fail(`cell.entry_protocol invalid: ${cell.entry_protocol}`);
    if (!PROTOCOL_SET.has(cell.provider_protocol)) fail(`cell.provider_protocol invalid: ${cell.provider_protocol}`);
    if (!TRANSPORT_SET.has(cell.transport)) fail(`cell.transport invalid: ${cell.transport}`);
    if (!MODE_SET.has(cell.mode)) fail(`cell.mode invalid: ${cell.mode}`);
    if (cell.mode === 'direct' && cell.entry_protocol !== cell.provider_protocol) {
      fail(`direct cell must target the same protocol: ${cell.entry_protocol} -> ${cell.provider_protocol}`);
    }
  }
  validateClientRequest(relative, value.client_request, findings);
  validateExpectedProvider(relative, value.expected_provider, findings);
  validateExpectedClient(relative, value.expected_client, findings);
  validateUpstream(relative, value.upstream_response, findings, 'upstream_response');
  validateAssertions(relative, value, findings);
  validateRuntimeSetup(relative, value.runtime_setup, findings);
  validateTurns(relative, value, findings);
  validateSource(relative, value.source, findings);
  validateToolFollowup(relative, value, findings);
  return findings;
}

function validateClientRequest(relative, request, findings) {
  const fail = (message) => findings.push(`${relative}: ${message}`);
  if (!isObject(request)) {
    fail('client_request object missing');
    return;
  }
  if (request.method !== 'POST') fail(`client_request.method must be POST: ${request.method}`);
  if (typeof request.path !== 'string' || !request.path.startsWith('/')) fail('client_request.path must be an absolute path');
  if (!isObject(request.body)) fail('client_request.body must be an object');
}

function validateExpectedProvider(relative, expected, findings) {
  const fail = (message) => findings.push(`${relative}: ${message}`);
  if (!isObject(expected)) {
    fail('expected_provider object missing');
    return;
  }
  if (!Array.isArray(expected.paths) || expected.paths.length === 0 || expected.paths.some((path) => typeof path !== 'string')) {
    fail('expected_provider.paths must be a non-empty string array');
  }
  if (expected.method !== 'POST') fail(`expected_provider.method must be POST: ${expected.method}`);
  if (typeof expected.auth_required !== 'boolean') fail('expected_provider.auth_required must be boolean');
  if (!isObject(expected.body_must) && !isObject(expected.exact)) {
    fail('expected_provider needs body_must or exact');
  }
  if (expected.body_must_not !== undefined && !Array.isArray(expected.body_must_not)) {
    fail('expected_provider.body_must_not must be an array when present');
  }
  validateAuthOrders(relative, expected, findings);
}

function validateAuthOrders(relative, expected, findings) {
  const fail = (message) => findings.push(`${relative}: ${message}`);
  if (expected.auth_orders === undefined) return;
  if (expected.auth_required !== true) {
    fail('expected_provider.auth_orders requires auth_required true');
  }
  if (!Array.isArray(expected.auth_orders) || expected.auth_orders.length !== 2) {
    fail('expected_provider.auth_orders must declare exactly two allowed identity orders');
    return;
  }
  for (const [index, order] of expected.auth_orders.entries()) {
    if (!Array.isArray(order) || order.length !== 2 || order.some((token) => typeof token !== 'string' || token.length === 0)) {
      fail(`expected_provider.auth_orders[${index}] must be exactly two non-empty auth strings`);
      continue;
    }
    if (new Set(order).size !== order.length) {
      fail(`expected_provider.auth_orders[${index}] must list two distinct identities`);
    }
  }
  if (expected.auth_orders.every((order) => Array.isArray(order) && order.every((token) => typeof token === 'string' && token.length > 0))) {
    const identities = new Set(expected.auth_orders.flat());
    if (identities.size !== 2) {
      fail('expected_provider.auth_orders must use exactly two identities across both orders');
    }
  }
}

function validateExpectedClient(relative, expected, findings) {
  const fail = (message) => findings.push(`${relative}: ${message}`);
  if (!isObject(expected)) {
    fail('expected_client object missing');
    return;
  }
  if (!CLIENT_TRANSPORT_SET.has(expected.transport)) fail(`expected_client.transport invalid: ${expected.transport}`);
  if (expected.transport === 'complete') {
    if (!Number.isInteger(expected.status) || expected.status < 200 || expected.status >= 300) {
      fail(`expected_client.status must be 2xx for complete transport: ${expected.status}`);
    }
    if (!isObject(expected.body_must)) fail('expected_client.body_must must be an object for complete transport');
  }
  if (expected.body_must_not !== undefined && !Array.isArray(expected.body_must_not)) {
    fail('expected_client.body_must_not must be an array when present');
  }
  if (typeof expected.semantic_terminal_required !== 'boolean') {
    fail('expected_client.semantic_terminal_required must be boolean');
  }
}

function validateUpstream(relative, upstream, findings, label) {
  const prefix = `${relative}: ${label}`;
  const fail = (message) => findings.push(`${prefix}: ${message}`);
  if (!isObject(upstream)) {
    fail('object missing');
    return;
  }
  if (!PROTOCOL_SET.has(upstream.protocol)) fail(`protocol invalid: ${upstream.protocol}`);
  if (!SCRIPT_SET.has(upstream.mode)) {
    fail(`mode invalid: ${upstream.mode}`);
    return;
  }
  if (upstream.mode === 'json') {
    if (!isObject(upstream.body)) fail('body must be an object for json mode');
  } else if (upstream.mode === 'sse') {
    if (!Array.isArray(upstream.sse_events) || upstream.sse_events.length === 0) {
      fail('sse_events must be a non-empty array for sse mode');
    }
  } else if (upstream.mode === 'fault') {
    if (typeof upstream.fault !== 'string' || upstream.fault.length === 0) fail('fault must be a non-empty string for fault mode');
    if (!Array.isArray(upstream.attempts) || upstream.attempts.length === 0) {
      fail('attempts must be a non-empty array for fault mode');
    }
    for (const [index, attempt] of (upstream.attempts ?? []).entries()) {
      validateScriptedAttempt(prefix, attempt, index, findings);
    }
  }
}

function validateScriptedAttempt(prefix, attempt, index, findings) {
  const fail = (message) => findings.push(`${prefix}.attempts[${index}]: ${message}`);
  if (!isObject(attempt)) {
    fail('must be an object');
    return;
  }
  if (!SCRIPT_SET.has(attempt.kind)) fail(`kind invalid: ${attempt.kind}`);
  if (attempt.kind === 'json' && !isObject(attempt.body)) fail('body must be an object for kind=json');
  if (attempt.kind === 'sse' && (!Array.isArray(attempt.sse_events) || attempt.sse_events.length === 0)) fail('sse_events must be a non-empty array for kind=sse');
  if (attempt.kind === 'fault' && (typeof attempt.fault !== 'string' || attempt.fault.length === 0)) fail('fault must be a non-empty string for kind=fault');
}

function validateAssertions(relative, value, findings) {
  const fail = (message) => findings.push(`${relative}: ${message}`);
  const assertions = value.assertions;
  if (!isObject(assertions)) {
    fail('assertions object missing');
    return;
  }
  if (!Number.isInteger(assertions.provider_attempt_count) || assertions.provider_attempt_count < 0) {
    fail(`assertions.provider_attempt_count invalid: ${assertions.provider_attempt_count}`);
  }
  if (typeof assertions.probe_attempts_may_occur !== 'boolean') fail('assertions.probe_attempts_may_occur must be boolean');
  if (typeof assertions.no_control_leakage !== 'boolean') fail('assertions.no_control_leakage must be boolean');
  // provider_attempt_count is asserted per turn by the runner; it is not a
  // reconciliation of the total scripted attempts across turns.
}

function validateRuntimeSetup(relative, setup, findings) {
  const fail = (message) => findings.push(`${relative}: ${message}`);
  if (setup === undefined) return;
  if (!isObject(setup)) {
    fail('runtime_setup must be an object when present');
    return;
  }
  for (const key of Object.keys(setup)) {
    if (!RUNTIME_SETUP_KEYS.has(key)) fail(`runtime_setup.${key} is not a supported field`);
  }
  if (typeof setup.provider_id !== 'string' || !PROVIDER_ID_PATTERN.test(setup.provider_id)) {
    fail(`runtime_setup.provider_id invalid: ${setup.provider_id ?? 'null'}`);
  }
  if (typeof setup.model !== 'string' || setup.model.length === 0) {
    fail('runtime_setup.model must be a non-empty string');
  }
  if (typeof setup.wire_model !== 'string' || setup.wire_model.length === 0) {
    fail('runtime_setup.wire_model must be a non-empty string');
  }
  if (!Array.isArray(setup.candidate_ids) || setup.candidate_ids.length === 0 || setup.candidate_ids.some((candidate) => typeof candidate !== 'string')) {
    fail('runtime_setup.candidate_ids must be a non-empty string array');
    return;
  }
  for (const candidate of setup.candidate_ids) {
    const parts = candidate.split('/');
    if (parts.length !== 2 || parts.some((part) => !PROVIDER_ID_PATTERN.test(part))) {
      fail(`runtime_setup.candidate_ids entry must be provider/model: ${candidate}`);
    }
  }
  if (new Set(setup.candidate_ids).size !== setup.candidate_ids.length) {
    fail('runtime_setup.candidate_ids must be unique');
  }
  const firstCandidate = `${setup.provider_id}/${setup.model}`;
  if (setup.candidate_ids[0] !== firstCandidate) {
    fail(`runtime_setup.candidate_ids[0] must be ${firstCandidate}`);
  }
  if (setup.all_candidates_fail !== undefined && typeof setup.all_candidates_fail !== 'boolean') {
    fail('runtime_setup.all_candidates_fail must be boolean when present');
  }
}

function validateTurns(relative, value, findings) {
  const fail = (message) => findings.push(`${relative}: ${message}`);
  const turns = value.turns;
  if (turns === undefined) return;
  if (!Array.isArray(turns) || turns.length < 2) {
    fail('turns must be an array with at least two entries when present');
    return;
  }
  const seenIds = new Set();
  for (const [index, turn] of turns.entries()) {
    if (!isObject(turn)) {
      fail(`turns[${index}] must be an object`);
      continue;
    }
    if (typeof turn.turn_id !== 'string' || !ID_PATTERN.test(turn.turn_id)) {
      fail(`turns[${index}].turn_id invalid: ${turn.turn_id}`);
    } else if (seenIds.has(turn.turn_id)) {
      fail(`turns[${index}].turn_id duplicate: ${turn.turn_id}`);
    } else {
      seenIds.add(turn.turn_id);
    }
    const hasRequest = isObject(turn.client_request);
    const hasProviderExact = isObject(turn.expected_provider_exact);
    const hasClientMust = isObject(turn.expected_client_must);
    if (index === 0 && hasProviderExact && typeof turn.expected_provider_exact === 'object') {
      fail('turns[0].expected_provider_exact must not redefine the top-level first provider shape');
    }
    if (index === 0 && isObject(turn.upstream_response)) {
      fail('turns[0].upstream_response must not redefine the top-level first upstream script');
    }
    if (index > 0 && !hasRequest) fail(`turns[${index}] must declare client_request`);
    if (index > 0 && !hasRequest && !hasProviderExact && !hasClientMust) {
      fail(`turns[${index}] must assert a follow-up provider shape or client output`);
    }
    if (hasRequest) validateClientRequest(`${relative}: turns[${index}].client_request`, turn.client_request, findings);
    if (isObject(turn.upstream_response)) validateUpstream(relative, turn.upstream_response, findings, `turns[${index}].upstream_response`);
  }
}

function validateSource(relative, source, findings) {
  const fail = (message) => findings.push(`${relative}: ${message}`);
  if (!isObject(source)) {
    fail('source object missing');
    return;
  }
  if (source.sha !== SOURCE_SHA) fail(`source.sha mismatch: ${source.sha}`);
  if (!Array.isArray(source.files)) fail('source.files must be an array');
  if (!Array.isArray(source.tests)) fail('source.tests must be an array');
  for (const test of source.tests ?? []) {
    if (typeof test !== 'string' || !test.includes('::')) fail(`source.tests entry must be file::TestName: ${test}`);
  }
}

function validateToolFollowup(relative, value, findings) {
  const fail = (message) => findings.push(`${relative}: ${message}`);
  const followup = value.tool_followup;
  if (followup === undefined) return;
  if (!isObject(followup)) {
    fail('tool_followup must be an object when present');
    return;
  }
  const hasToolFlag = followup.assert_no_synthesized_tool_result === true
    || followup.assert_declared_tool_binding_only === true
    || followup.assert_tool_executed_once === true;
  if (!hasToolFlag) fail('tool_followup must declare at least one tool assertion flag');
  if (followup.assert_tool_executed_once === true && followup.consumer !== 'echo') {
    fail('tool_followup.assert_tool_executed_once requires the actual echo consumer');
  }
  if (!Array.isArray(value.turns) || value.turns.length < 2) {
    fail('tool_followup requires at least two turns');
    return;
  }
  // Search only the scripted request/turn history. Including tool_followup
  // would make its own input/expected_output trivially self-match.
  const corpus = `${JSON.stringify(value.client_request)}\n${JSON.stringify(value.turns)}`;
  if (followup.expected_output !== undefined) {
    const needle = typeof followup.expected_output === 'string' ? followup.expected_output : JSON.stringify(followup.expected_output);
    if (needle && !corpus.includes(needle)) fail(`tool_followup.expected_output not present in scripted history: ${needle}`);
  }
  if (isObject(followup.input)) {
    for (const [key, expected] of Object.entries(followup.input)) {
      if (typeof expected === 'string' && !corpus.includes(expected)) {
        fail(`tool_followup.input.${key} not present in scripted history: ${expected}`);
      }
    }
  }
  const followupTurn = value.turns[value.turns.length - 1];
  if (!isObject(followupTurn) || !isObject(followupTurn.client_request)) {
    fail('tool_followup requires a final follow-up turn with client_request');
  }
}

export function corpusCoverage(loaded) {
  const cells = new Map();
  for (const entry of PROTOCOLS) {
    for (const provider of PROTOCOLS) {
      cells.set(`${entry}->${provider}`, {
        entry_protocol: entry,
        provider_protocol: provider,
        case_ids: [],
        json: [],
        sse: [],
        modes: new Set(),
      });
    }
  }
  for (const { value } of loaded) {
    const cell = value?.cell;
    if (!isObject(cell)) continue;
    const key = `${cell.entry_protocol}->${cell.provider_protocol}`;
    const record = cells.get(key);
    if (!record) continue;
    record.case_ids.push(value.case_id);
    if (cell.transport === 'json') record.json.push(value.case_id);
    else if (cell.transport === 'sse') record.sse.push(value.case_id);
    record.modes.add(cell.mode);
  }
  const list = [];
  let base_cells_covered = 0;
  let base_variants_covered = 0;
  for (const record of cells.values()) {
    const has_json = record.json.length > 0;
    const has_sse = record.sse.length > 0;
    if (has_json && has_sse) base_cells_covered += 1;
    if (has_json) base_variants_covered += 1;
    if (has_sse) base_variants_covered += 1;
    list.push({
      entry_protocol: record.entry_protocol,
      provider_protocol: record.provider_protocol,
      covered: has_json && has_sse,
      json: record.json.sort(),
      sse: record.sse.sort(),
      modes: [...record.modes].sort(),
      case_ids: record.case_ids.sort(),
    });
  }
  return {
    base_cells: cells.size,
    base_cells_covered,
    base_variants: cells.size * CELL_TRANSPORTS.length,
    base_variants_covered,
    variants: list,
  };
}

export function corpusExtensions(loaded) {
  return loaded.filter(({ value }) => !isBaseCaseId(value.case_id)).map(({ value }) => value.case_id).sort();
}

function isBaseCaseId(caseId) {
  return /^(chat|responses|anthropic|gemini)-to-(chat|responses|anthropic|gemini)-(json|sse)$/.test(caseId);
}

export function checkSourceRefs(loaded, magpieRoot) {
  const staleFiles = new Set();
  const staleTests = new Set();
  for (const { relative, value } of loaded) {
    const source = value.source;
    if (!isObject(source)) continue;
    for (const file of source.files ?? []) {
      const absolute = join(resolve(magpieRoot), file);
      if (!existsSync(absolute)) staleFiles.add(`source file missing: ${relative} -> ${file}`);
    }
    for (const ref of source.tests ?? []) {
      const [file, testName] = String(ref).split('::');
      const absolute = join(resolve(magpieRoot), file ?? '');
      if (!file || !existsSync(absolute)) {
        staleTests.add(`source test file missing: ${relative} -> ${file ?? ref}`);
        continue;
      }
      if (testName && !new RegExp(`func\\s+${escapeRegExp(testName)}\\s*\\(`).test(readFileSync(absolute, 'utf8'))) {
        staleTests.add(`source test name missing: ${relative} -> ${ref}`);
      }
    }
  }
  return { checked: true, stale_files: [...staleFiles].sort(), stale_tests: [...staleTests].sort() };
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function assertManifest(manifest) {
  if (!isObject(manifest)) throw new CorpusError('fixture manifest must be an object');
  if (manifest.harness_id !== HARNESS_ID || manifest.schema_version !== SCHEMA_VERSION) {
    throw new CorpusError(`fixture manifest identity mismatch: ${manifest.harness_id ?? 'null'}/${manifest.schema_version ?? 'null'}`);
  }
  if (!isObject(manifest.source)) throw new CorpusError('fixture manifest source missing');
  if (manifest.source.repo !== SOURCE_REPO || manifest.source.sha !== SOURCE_SHA) {
    throw new CorpusError(`fixture manifest source mismatch: ${manifest.source.repo ?? 'null'}/${manifest.source.sha ?? 'null'}`);
  }
  if (manifest.source.license !== SOURCE_LICENSE) {
    throw new CorpusError(`fixture manifest license mismatch: ${manifest.source.license ?? 'null'}`);
  }
  if (!Array.isArray(manifest.cases) || manifest.cases.some((id) => typeof id !== 'string')) {
    throw new CorpusError('fixture manifest cases must be a string array');
  }
  const unique = new Set(manifest.cases);
  if (unique.size !== manifest.cases.length) throw new CorpusError('fixture manifest cases contain duplicates');
}

function readJson(path, label) {
  if (!existsSync(path)) throw new CorpusError(label);
  const raw = readFileSync(path, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new CorpusError(`${label}: invalid JSON: ${error.message}`);
  }
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
