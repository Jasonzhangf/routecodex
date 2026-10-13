import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

import { CorpusError, HARNESS_ID, SCHEMA_VERSION, SOURCE_LICENSE, SOURCE_REPO, SOURCE_SHA, PROTOCOLS, CELL_TRANSPORTS } from './corpus-contract.mjs';
import { validateCase } from './corpus-validation.mjs';

export { CorpusError, HARNESS_ID, SCHEMA_VERSION, SOURCE_LICENSE, SOURCE_REPO, SOURCE_SHA, PROTOCOLS, CELL_TRANSPORTS, CELL_MODES, SCRIPT_MODES, CLIENT_TRANSPORTS } from './corpus-contract.mjs';
export { validateCase } from './corpus-validation.mjs';

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
