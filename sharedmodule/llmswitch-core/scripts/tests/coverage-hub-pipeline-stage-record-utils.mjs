#!/usr/bin/env node
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function cacheBustedImport(url, tag) {
  return import(`${url}?case=${tag}_${Date.now()}_${Math.random().toString(16).slice(2)}`);
}

function moduleUrl(relPath) {
  return pathToFileURL(path.join(repoRoot, 'dist', relPath)).href;
}

async function main() {
  const mod = await cacheBustedImport(
    moduleUrl('conversion/hub/pipeline/stages/utils.js'),
    'pipeline-stage-record-utils'
  );
  const { recordStage } = mod;
  assert.equal(typeof recordStage, 'function');

  recordStage(undefined, 'stage.none', { ok: true });

  const captured = [];
  const recorder = {
    record(stage, payload) {
      captured.push({ stage, payload });
    }
  };

  recordStage(recorder, 'stage.object', { x: 1 });
  recordStage(recorder, 'stage.string-json', '{"hello":"world"}');
  recordStage(recorder, 'stage.bigint', 1n);

  const throwingRecorder = {
    record() {
      throw new Error('recorder boom');
    }
  };
  recordStage(throwingRecorder, 'stage.throw', { ok: true });

  assert.equal(captured[0].payload.x, 1);
  assert.equal(captured[1].payload.hello, 'world');
  assert.equal(Object.keys(captured[2].payload).length, 0);

  console.log('✅ coverage-hub-pipeline-stage-record-utils passed');
}

main().catch((error) => {
  console.error('❌ coverage-hub-pipeline-stage-record-utils failed:', error);
  process.exit(1);
});
