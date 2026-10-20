#!/usr/bin/env node
// CLI glue only. Protocol behavior, assertions and evidence have one helper owner.
import { spawnSync } from 'node:child_process';
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { HARNESS_ID, SOURCE_REPO, SOURCE_SHA, inspectCorpus } from './protocol-live-mock/corpus.mjs';
import { MockProviderError, startMockProvider } from './protocol-live-mock/mock-provider.mjs';
import { assertProviderCaptures } from './protocol-live-mock/assertions.mjs';
import { describeTurns } from './protocol-live-mock/case-contract.mjs';
import {
  captureRuntimeIdentity, generateRccConfig, sendHttp, startRcc, stopRcc,
} from './protocol-live-mock/lifecycle.mjs';
import { collectExecutionModeEvidence, REQUIRED_EXECUTION_MODES, runCase } from './protocol-live-mock/case-runner.mjs';
import {
  collectProviderConcurrencyEvidence,
  isProviderConcurrencyReplay,
  runProviderConcurrencyReplay,
} from './protocol-live-mock/provider-concurrency.mjs';
import { finalizeReport, renderMarkdown } from './protocol-live-mock/report.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const v3Root = resolve(scriptDir, '../..');
const repoRoot = resolve(v3Root, '..');
const fixtureRoot = join(v3Root, 'fixtures/protocol-live-mock-matrix');
const helperRoot = join(scriptDir, 'protocol-live-mock');

export function parseArgs(argv) {
  const options = { startupTimeoutMs: 20000, requestTimeoutMs: 30000, shutdownTimeoutMs: 8000 };
  const names = {
    '--case': 'caseId', '--binary': 'binary', '--evidence': 'evidence',
    '--binary-kind': 'binaryKind',
    '--report-path': 'reportPath', '--startup-timeout-ms': 'startupTimeoutMs',
    '--request-timeout-ms': 'requestTimeoutMs', '--shutdown-timeout-ms': 'shutdownTimeoutMs',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--help' || flag === '-h') { options.help = true; continue; }
    if (flag === '--selftest') { options.selftest = true; continue; }
    const name = names[flag];
    if (!name) throw new Error('unknown argument: ' + flag);
    const value = argv[++index];
    if (!value || value.startsWith('--')) throw new Error('missing value for ' + flag);
    if (name.endsWith('TimeoutMs')) {
      const number = Number(value);
      if (!Number.isSafeInteger(number) || number < 1) throw new Error(flag + ' requires positive integer milliseconds');
      options[name] = number;
    } else {
      options[name] = value;
    }
  }
  if (options.binaryKind && !['installed', 'candidate'].includes(options.binaryKind)) {
    throw new Error('--binary-kind must be installed or candidate');
  }
  return options;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(`Usage: node v3-protocol-live-mock-matrix.mjs [options]
  --selftest                  Run all Node helper tests in one subprocess; no RCC launch
  --case ID                   Run one fixture; default is the complete corpus
  --binary PATH               Explicit candidate binary; default is installed ~/.local/bin/rccv3
  --binary-kind KIND          installed or candidate; override identity label for an explicit path
  --evidence PATH             Retained evidence directory; default is a new temporary directory
  --report-path PATH          Markdown report; default is evidence/baseline-report.md
  --startup-timeout-ms N      RCC readiness deadline (default 20000)
  --request-timeout-ms N      Client request deadline (default 30000)
  --shutdown-timeout-ms N     Owned child shutdown deadline (default 8000)
  --help                      Print help
Defaults are anchored to this script, so root and v3 working directories work.`);
    return 0;
  }
  if (options.selftest) {
    const tests = readdirSync(helperRoot).filter((name) => name.endsWith('.test.mjs')).sort();
    const child = spawnSync(process.execPath, ['--test', '--test-timeout=30000', ...tests.map((name) => join(helperRoot, name))], {
      stdio: 'inherit', cwd: repoRoot, timeout: 90000,
    });
    if (child.error) throw child.error;
    return child.status ?? 1;
  }

  const evidenceRoot = options.evidence ? resolve(options.evidence) : mkdtempSync(join(tmpdir(), 'v3-protocol-live-mock-'));
  mkdirSync(evidenceRoot, { recursive: true });
  const installedBinary = resolve(join(process.env.HOME, '.local/bin/rccv3'));
  const binary = resolve(options.binary ?? installedBinary);
  const reportPath = resolve(options.reportPath ?? join(evidenceRoot, 'baseline-report.md'));
  const corpus = inspectCorpus(fixtureRoot);
  const selected = corpus.fixtures.filter(({ value }) => !options.caseId || value.case_id === options.caseId);
  if (options.caseId && selected.length === 0) throw new Error('unknown case: ' + options.caseId);
  const runtimeIdentity = { ...captureRuntimeIdentity(binary),
    kind: options.binaryKind ?? (binary === installedBinary ? 'installed' : 'candidate') };
  const report = {
    harness_id: HARNESS_ID, status: 'running', evidence_root: evidenceRoot, fixture_root: fixtureRoot,
    binary: runtimeIdentity,
    source_identity: { repo: SOURCE_REPO },
    fixture_source: { repo: SOURCE_REPO, sha: SOURCE_SHA },
    corpus: { findings: corpus.findings, coverage: corpus.coverage },
    cases: [], cleanup: { complete: true, cases: [] },
  };
  let haltReason = null;
  if (!corpus.ok) haltReason = 'invalid corpus: ' + corpus.findings.join('; ');
  for (const { relative, value: fixture } of selected) {
    if (haltReason) {
      report.cases.push({ case_id: fixture.case_id, cell: fixture.cell, status: 'not_run', diagnostic: haltReason });
      continue;
    }
    const caseRoot = join(evidenceRoot, fixture.case_id);
    mkdirSync(caseRoot, { recursive: true });
    const setup = {};
    let mock;
    let generated;
    let rcc;
    let entry;
    let phase = 'mock_start';
    const cleanup = { complete: true, case_id: fixture.case_id };
    try {
      mock = await startMockProvider({
        validateRequest(capture, fixture, turnIndex) {
          const expected = describeTurns(fixture)[turnIndex]?.providerExpected;
          if (!expected) return;
          const result = assertProviderCaptures([capture], 0, expected, {
            providerProtocol: fixture.cell.provider_protocol,
            noControlLeakage: fixture.assertions?.no_control_leakage,
          });
          if (!result.ok) {
            throw new MockProviderError('mock_provider_request_shape_mismatch', result.diagnostics.join('; '));
          }
        },
      });
      phase = 'config_generation';
      const rccPort = await allocatePort();
      const runtimeSetup = fixture.runtime_setup;
      const candidateIds = runtimeSetup?.candidate_ids ?? runtimeSetup?.target_ids;
      // Multi-identity runtime setup is legal: a declared pool tier may carry
      // more than one eligible provider/model. The lifecycle helper owns how
      // those identities become provider files and candidate receipts; this
      // runner only forwards the declaration and records what it authored.
      if (runtimeSetup && (!Array.isArray(candidateIds) || candidateIds.length < 1)) {
        throw new Error('runtime_setup must declare at least one candidate id');
      }
      const candidate = candidateIds?.[0];
      generated = await generateRccConfig({
        mockPort: mock.port, rccPort, providerProtocol: fixture.cell.provider_protocol,
        mode: fixture.cell.mode, entryProtocol: fixture.cell.entry_protocol,
        ...(candidate ? { providerId: candidate.split('/')[0], model: candidate.split('/')[1],
          wireModel: runtimeSetup.wire_model } : {}),
        runtimeSetup: runtimeSetup ? { ...runtimeSetup, candidate_ids: candidateIds } : undefined,
        fixtureRoot, workRoot: caseRoot, binary,
      });
      writeFileSync(join(caseRoot, 'config.toml'), generated.text);
      // Copy every generated provider file the lifecycle authored. A single
      // candidate keeps the historic provider.toml path; a multi-identity
      // setup receipts each provider file so config evidence matches the
      // candidates that were actually declared.
      const providerFiles = Array.isArray(generated.provider_files) && generated.provider_files.length
        ? generated.provider_files
        : [{ provider_id: generated.provider_id, path: generated.provider_path, text: generated.provider_text,
            model: generated.model, wire_model: generated.wire_model }];
      const providerFileReceipts = [];
      for (const file of providerFiles) {
        const name = providerFiles.length === 1 ? 'provider.toml'
          : `provider-${sanitizeFileName(file.provider_id)}.toml`;
        const writtenPath = join(caseRoot, name);
        writeFileSync(writtenPath, file.text);
        providerFileReceipts.push({
          provider_id: file.provider_id, path: file.path, written_path: writtenPath,
          model: file.model, wire_model: file.wire_model,
        });
      }
      if (providerFiles.length === 1) {
        writeFileSync(join(caseRoot, 'provider.toml'), providerFiles[0].text);
      }
      writeFileSync(join(caseRoot, 'config-identity.json'), JSON.stringify({
        path: generated.path, state: generated.state, listeners: generated.listeners,
        admin_bind: generated.admin_bind, env: generated.env, mode: generated.mode ?? null,
        model: generated.model, wire_model: generated.wire_model, runtime_setup: generated.runtime_setup,
        provider_files: providerFileReceipts,
        candidate_identity_receipts: generated.candidate_identity_receipts ?? null,
        candidate_ids: generated.candidate_ids ?? candidateIds ?? null,
        attempt_store: generated.attempt_store ?? null,
        attempt_store_receipt: generated.attempt_store_receipt ?? null,
      }, null, 2));
      // Explicit same-protocol Relay needs an API that really authors the mode.
      // Do not count a default Direct run as supplemental Relay evidence.
      if (fixture.cell.mode === 'relay' && fixture.cell.entry_protocol === fixture.cell.provider_protocol
          && generated.mode !== 'relay') {
        entry = { case_id: fixture.case_id, cell: fixture.cell, status: 'not_run',
          diagnostic: 'lifecycle generateRccConfig does not expose authored same-protocol relay mode' };
      } else {
        phase = 'config_check';
        const check = spawnSync(binary, ['config', 'check', '-c', generated.path], {
          encoding: 'utf8', timeout: options.startupTimeoutMs,
          env: { ...process.env, HOME: generated.home, ROUTECODEX_V3_STATE_DIR: generated.state, ...generated.env },
        });
        setup.config_check = { exit_code: check.status, signal: check.signal, stdout: check.stdout,
          stderr: check.stderr, error: check.error ? { message: check.error.message, code: check.error.code } : null };
        if (check.error || check.status !== 0) throw new Error('config check failed: ' + JSON.stringify(setup.config_check));
        phase = 'rcc_start';
        rcc = await startRcc(binary, generated, rccPort, setup, {
          startupTimeoutMs: options.startupTimeoutMs,
          snapshotAll: isProviderConcurrencyReplay(fixture),
        });
        if (!rcc.ready) throw new Error(setup.infra_failure?.diagnostic ?? 'RCC did not become ready');
        setup.health = rcc.health;
        phase = 'run_case';
        entry = isProviderConcurrencyReplay(fixture)
          ? await runProviderConcurrencyReplay({
            fixture, mock, rccUrl: 'http://127.0.0.1:' + rccPort, sendHttp,
            evidenceRoot: caseRoot, timeoutMs: options.requestTimeoutMs,
          })
          : await runCase({
            fixture, mock, rccUrl: 'http://127.0.0.1:' + rccPort, sendHttp,
            evidenceRoot: caseRoot, timeoutMs: options.requestTimeoutMs,
            sampleRoot: join(generated.home, '.rcc', 'codex-samples'),
            listenerPort: rccPort,
          });
        if (entry.status === 'infra_failure') haltReason = 'case infrastructure failed: ' + entry.diagnostic;
      }
    } catch (error) {
      const diagnostic = phase + ': ' + error.message;
      entry = { case_id: fixture.case_id, cell: fixture.cell, status: 'infra_failure',
        classification: 'infrastructure', runner_failures: 1, diagnostic,
        infra_failure: { phase, message: error.message, code: error.code ?? null } };
      haltReason = diagnostic;
    } finally {
      if (rcc) {
        try {
          cleanup.rcc = setup.cleanup ?? await stopRcc(rcc, {}, { shutdownTimeoutMs: options.shutdownTimeoutMs });
          cleanup.complete &&= cleanup.rcc.complete && !cleanup.rcc.force_killed;
          writeFileSync(join(caseRoot, 'rcc-diagnostics.json'), JSON.stringify(rcc.diagnostics(), null, 2));
        } catch (error) { cleanup.complete = false; cleanup.rcc_error = error.message; }
      }
      // One disk read after the owned stop and before generated-state cleanup
      // deletes the request-records store. Independent of business acceptance:
      // a collector failure records evidence and never abandons the cleanup.
      if (entry) {
        const collectionPhase = cleanup.rcc
          ? cleanup.rcc.complete && !cleanup.rcc.force_killed ? 'post_stop_complete' : 'post_stop_partial'
          : 'post_stop_missing';
        let captures = [];
        let captureError = null;
        try {
          captures = mock ? mock.getCaptures() : [];
        } catch (error) {
          captureError = error.message;
        }
        const storePath = generated
          ? join(generated.root, 'logs', `server-v3-${generated.rcc_port}.request-records.jsonl`)
          : null;
        const sourceSampleRoot = generated ? join(generated.home, '.rcc', 'codex-samples') : null;
        const retainedSampleRoot = generated ? join(caseRoot, 'codex-samples') : null;
        if (sourceSampleRoot && retainedSampleRoot && existsSync(sourceSampleRoot)) {
          try {
            cpSync(sourceSampleRoot, retainedSampleRoot, { recursive: true, force: true });
          } catch (error) {
            cleanup.complete = false;
            cleanup.sample_copy_error = error.message;
          }
        }
        entry.execution_mode = isProviderConcurrencyReplay(fixture)
          ? collectProviderConcurrencyEvidence({
            fixture,
            caseRoot,
            storePath,
            sampleRoot: retainedSampleRoot ?? sourceSampleRoot,
            listenerPort: generated?.rcc_port ?? null,
            exhaustedWindow: entry.observations?.provider_concurrency?.exhausted_window ?? {},
            collectionPhase,
            stopReceipt: cleanup.rcc ?? null,
          })
          : collectCaseExecutionModeEvidence({
            caseId: fixture.case_id,
            caseRoot,
            storePath,
            attempts: entry.turn_attempts ?? [],
            captures,
            listenerPort: generated?.rcc_port ?? null,
            collectionPhase,
            stopReceipt: cleanup.rcc ?? null,
          });
        if (captureError) entry.execution_mode.findings.push(`provider capture read failed: ${captureError}`);
        for (const reference of [
          entry.execution_mode.records_ref,
          entry.execution_mode.typed_source_ref,
          entry.execution_mode.evidence_ref,
        ]) {
          if (reference) entry.evidence_refs = [...(entry.evidence_refs ?? []), reference];
        }
      }
      if (mock) {
        try { writeFileSync(join(caseRoot, 'provider-captures.json'), JSON.stringify(mock.getCaptures(), null, 2)); }
        catch (error) { cleanup.complete = false; cleanup.capture_error = error.message; }
        try { await mock.close(); cleanup.mock_closed = true; }
        catch (error) { cleanup.complete = false; cleanup.mock_error = error.message; }
      }
      if (generated && cleanup.complete) {
        try { generated.cleanup(); cleanup.config_state_removed = true; }
        catch (error) { cleanup.complete = false; cleanup.config_state_error = error.message; }
      }
      cleanup.retained_state = generated && !cleanup.config_state_removed ? generated.root : null;
    }
    entry.fixture = relative;
    entry.source = fixture.source;
    entry.setup = setup;
    entry.cleanup = cleanup;
    entry.evidence_refs = [...(entry.evidence_refs ?? []),
      join(caseRoot, 'setup.json'), join(caseRoot, 'provider-captures.json')];
    writeFileSync(join(caseRoot, 'setup.json'), JSON.stringify({ setup, cleanup }, null, 2));
    report.cleanup.cases.push(cleanup);
    report.cleanup.complete &&= cleanup.complete;
    if (!cleanup.complete) {
      entry.status = 'infra_failure';
      entry.runner_failures = (entry.runner_failures ?? 0) + 1;
      entry.diagnostic += '; owned resource cleanup incomplete';
      haltReason = entry.diagnostic;
    }
    applyExecutionModeAcceptance(entry);
    report.cases.push(entry);
    console.log(fixture.case_id + ': ' + entry.status);
  }
  report.status = 'baseline_complete';
  report.halt_reason = haltReason;
  const result = finalizeReport(report);
  const jsonPath = join(evidenceRoot, 'baseline-report.json');
  writeFileSync(jsonPath, JSON.stringify(result, null, 2) + '\n');
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, renderMarkdown(result));
  console.log(JSON.stringify({ harness_id: HARNESS_ID, status: result.status,
    json_path: jsonPath, markdown_path: reportPath, summary: result.summary }, null, 2));
  return result.status === 'passed' && result.cleanup.complete ? 0 : 1;
}

// Required-case mode evidence is an acceptance gate. A mismatch or a collection
// gap appends a finding and, for a business-passing case, downgrades it to
// failed; an existing failure keeps its original diagnostic and status.
export function collectCaseExecutionModeEvidence(options) {
  try {
    return collectExecutionModeEvidence(options);
  } catch (error) {
    return {
      status: 'incomplete', expected_mode: options.expectedMode !== undefined
        ? options.expectedMode : REQUIRED_EXECUTION_MODES[options.caseId] ?? null, actual_mode: null,
      findings: [`collector error: ${error.message}`], records_ref: null, evidence_ref: null,
    };
  }
}

export function applyExecutionModeAcceptance(entry) {
  const mode = entry?.execution_mode;
  if (!mode || mode.expected_mode === null || mode.expected_mode === undefined) return;
  if (mode.status === 'pass') return;
  const detail = Array.isArray(mode.findings) && mode.findings.length ? mode.findings.join('; ') : 'no detail';
  const label = mode.kind ?? 'execution mode';
  entry.diagnostic = [entry.diagnostic, `${label} ${mode.status}: ${detail}`].filter(Boolean).join('; ');
  if (entry.status !== 'passed') return;
  entry.status = 'failed';
  entry.classification = mode.status === 'mismatch' ? 'product' : 'evidence';
  if (mode.status === 'mismatch') entry.product_failures = (entry.product_failures ?? 0) + 1;
  entry.first_divergence = 'execution_mode';
}

// One ephemeral primary address. Lifecycle owns the separate admin address.
async function allocatePort() {
  const server = createServer();
  await new Promise((accept, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', accept);
  });
  const port = server.address().port;
  await new Promise((accept, reject) => server.close((error) => error ? reject(error) : accept()));
  return port;
}

function sanitizeFileName(value) {
  const text = String(value ?? 'provider');
  return text.replace(/[^A-Za-z0-9_.-]/g, '_') || 'provider';
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = await main(); }
  catch (error) { console.error(error.stack ?? error.message); process.exitCode = 1; }
}
