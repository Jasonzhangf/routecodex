#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const requestArtifactPath = process.env.ROUTECODEX_DRY_RUN_REQUEST_ARTIFACT
  || '/Users/fanzhang/.rcc/codex-samples/openai-chat/ports/5520/req_1783782555457_b30d64a4/runs/sample_1783839364169/agent-collab-dryrun-slice/dry-run.provider-request.json';
const responseSamplePath = process.env.ROUTECODEX_DRY_RUN_RESPONSE_SAMPLE
  || '/Users/fanzhang/.rcc/codex-samples/openai-chat/ports/5520/req_1783782555457_b30d64a4/provider-response.json';

const failures = [];
const passes = [];

function fail(message) {
  throw new Error(message);
}

function check(condition, message) {
  if (!condition) fail(message);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function assertRequestDryRunArtifact(doc, source) {
  check(doc && typeof doc === 'object' && !Array.isArray(doc), `${source}: request dry-run artifact root must be an object`);
  check(doc.object === 'routecodex.pipeline_dry_run', `${source}: expected object=routecodex.pipeline_dry_run`);
  check(doc.kind === 'provider_request', `${source}: expected kind=provider_request`);
  check(doc.dryRun === true, `${source}: expected dryRun=true`);
  check(doc.evidence && typeof doc.evidence === 'object', `${source}: expected evidence object`);
  check(doc.evidence.stoppedBeforeProviderSend === true, `${source}: expected evidence.stoppedBeforeProviderSend=true`);
  check(doc.evidence.providerRequestSnapshotWritten === true, `${source}: expected evidence.providerRequestSnapshotWritten=true`);
  check(doc.providerRequest && typeof doc.providerRequest === 'object', `${source}: expected providerRequest object`);
  check(doc.providerRequest.method === 'POST', `${source}: expected providerRequest.method=POST`);
  check(Object.prototype.hasOwnProperty.call(doc.providerRequest, 'body'), `${source}: expected providerRequest.body`);
}

function assertResponseDryRunArtifact(doc, source) {
  check(doc && typeof doc === 'object' && !Array.isArray(doc), `${source}: response dry-run artifact root must be an object`);
  check(doc.ok === true, `${source}: expected ok=true`);
  check(doc.converted && typeof doc.converted === 'object', `${source}: expected converted object`);
  check(doc.converted.status === 200, `${source}: expected converted.status=200`);
  check(doc.converted.body && typeof doc.converted.body === 'object', `${source}: expected converted.body object`);
  check(doc.converted.body.object === 'chat.completion', `${source}: expected converted.body.object=chat.completion`);
  check(Array.isArray(doc.converted.body.choices), `${source}: expected converted.body.choices array`);
}

function expectValidationFailure(name, validator, doc, expectedSubstring) {
  try {
    validator(doc, name);
    failures.push(`${name}: expected validation failure`);
    return;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes(expectedSubstring)) {
      failures.push(`${name}: expected failure containing "${expectedSubstring}", got "${message}"`);
      return;
    }
    passes.push(`${name}: failed closed with "${expectedSubstring}"`);
  }
}

function runDryRunCodexResponse(sample, outDir) {
  const result = spawnSync(
    'npm',
    ['run', 'dry-run:codex-response', '--', '--sample', sample, '--out-dir', outDir],
    {
      cwd: root,
      encoding: 'utf8',
      env: process.env,
      maxBuffer: 10 * 1024 * 1024
    }
  );
  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    combined: `${result.stdout || ''}\n${result.stderr || ''}`
  };
}

function expectCommandFailure(name, result, substrings) {
  if (result.status === 0) {
    failures.push(`${name}: expected command failure`);
    return;
  }
  for (const substring of substrings) {
    if (!result.combined.includes(substring)) {
      failures.push(`${name}: expected output containing "${substring}", got "${result.combined.slice(0, 1000)}"`);
      return;
    }
  }
  passes.push(`${name}: command failed closed with required guidance`);
}

function verifyRequestArtifacts() {
  const request = readJson(requestArtifactPath);
  assertRequestDryRunArtifact(request, requestArtifactPath);
  passes.push(`request positive: ${requestArtifactPath}`);

  const missingObject = cloneJson(request);
  delete missingObject.object;
  expectValidationFailure(
    'request negative missing routecodex object',
    assertRequestDryRunArtifact,
    missingObject,
    'object=routecodex.pipeline_dry_run'
  );

  const missingStopped = cloneJson(request);
  missingStopped.evidence.stoppedBeforeProviderSend = false;
  expectValidationFailure(
    'request negative missing stoppedBeforeProviderSend',
    assertRequestDryRunArtifact,
    missingStopped,
    'evidence.stoppedBeforeProviderSend=true'
  );

  const missingBody = cloneJson(request);
  delete missingBody.providerRequest.body;
  expectValidationFailure(
    'request negative missing providerRequest.body',
    assertRequestDryRunArtifact,
    missingBody,
    'providerRequest.body'
  );
}

function verifyResponseArtifacts(tmpDir) {
  const responseOutDir = path.join(tmpDir, 'response-positive');
  const positive = runDryRunCodexResponse(responseSamplePath, responseOutDir);
  if (positive.status !== 0) {
    fail(`response positive dry-run failed: ${positive.combined}`);
  }
  const responseArtifactPath = path.join(responseOutDir, 'response-dry-run.json');
  const response = readJson(responseArtifactPath);
  assertResponseDryRunArtifact(response, responseArtifactPath);
  passes.push(`response positive: ${responseArtifactPath}`);

  const missingOk = cloneJson(response);
  missingOk.ok = false;
  expectValidationFailure(
    'response negative missing ok=true',
    assertResponseDryRunArtifact,
    missingOk,
    'ok=true'
  );

  const missingStatus = cloneJson(response);
  delete missingStatus.converted.status;
  expectValidationFailure(
    'response negative missing converted.status',
    assertResponseDryRunArtifact,
    missingStatus,
    'converted.status=200'
  );

  const missingBody = cloneJson(response);
  delete missingBody.converted.body;
  expectValidationFailure(
    'response negative missing converted.body',
    assertResponseDryRunArtifact,
    missingBody,
    'converted.body object'
  );
}

function verifySerializedSseNegative(tmpDir) {
  const sample = path.join(tmpDir, 'serialized-sse-provider-response.json');
  writeJson(sample, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream'
    },
    body: {
      sseStream: {
        readable: true,
        readableEnded: false,
        _readableState: {}
      }
    }
  });
  const result = runDryRunCodexResponse(sample, path.join(tmpDir, 'serialized-sse-out'));
  expectCommandFailure('response negative serialized sseStream without replay text', result, [
    'serialized sseStream',
    'Re-capture with snapshots enabled'
  ]);
}

function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'routecodex-dryrun-blackbox-'));
  try {
    verifyRequestArtifacts();
    verifyResponseArtifacts(tmpDir);
    verifySerializedSseNegative(tmpDir);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  if (failures.length > 0) {
    console.error('[pipeline-dry-run-blackbox-fixtures] failed');
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
  }

  console.log('[pipeline-dry-run-blackbox-fixtures] ok');
  for (const pass of passes) console.log(`- ${pass}`);
  console.log('- non-local dry-run header rejection is covered by tests/debug/pipeline-dry-run.spec.ts');
}

main();
