#!/usr/bin/env node
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const moduleUrl = pathToFileURL(
  path.join(
    repoRoot,
    'dist',
    'conversion',
    'hub',
    'pipeline',
    'stages',
    'req_inbound',
    'req_inbound_stage3_context_capture',
    'context-capture-orchestration.js'
  )
).href;

async function importFresh(tag) {
  return import(`${moduleUrl}?case=${tag}_${Date.now()}_${Math.random().toString(16).slice(2)}`);
}

function makeAdapterContext(overrides = {}) {
  return {
    requestId: 'req_ctx_orch',
    entryEndpoint: '/v1/responses',
    providerProtocol: 'openai-responses',
    ...overrides
  };
}

function makeStageRecorder() {
  const calls = [];
  return {
    calls,
    recorder: {
      record(stageId, payload) {
        calls.push({ stageId, payload });
      }
    }
  };
}

async function main() {
  const { runReqInboundStage3ContextCaptureOrchestration } = await importFresh('hub-req-inbound-context-capture-orchestration');
  assert.equal(typeof runReqInboundStage3ContextCaptureOrchestration, 'function');

  {
    let called = false;
    const stage = makeStageRecorder();
    const result = await runReqInboundStage3ContextCaptureOrchestration({
      rawRequest: { model: 'gpt-test' },
      adapterContext: makeAdapterContext({ __rt: { serverToolFollowup: true } }),
      stageRecorder: stage.recorder,
      captureContext: () => {
        called = true;
        return { impossible: true };
      }
    });
    assert.equal(called, false);
    assert.equal(result.providerProtocol, 'openai-responses');
    assert.deepEqual(result.tool_outputs, []);
    assert.equal(stage.calls.length, 1);
  }

  {
    const stage = makeStageRecorder();
    const result = await runReqInboundStage3ContextCaptureOrchestration({
      rawRequest: { model: 'gpt-test' },
      adapterContext: makeAdapterContext({ __rt: { serverToolFollowup: '  TRUE ' } }),
      stageRecorder: stage.recorder
    });
    assert.equal(result.providerProtocol, 'openai-responses');
    assert.deepEqual(result.tool_outputs, []);
    assert.equal(stage.calls[0].stageId, 'chat_process.req.stage3.context_capture');
  }

  {
    const adapterContext = makeAdapterContext({ providerProtocol: 'openai-chat' });
    Object.defineProperty(adapterContext, '__rt', {
      configurable: true,
      enumerable: true,
      get() {
        throw new Error('rt read failed');
      }
    });
    await assert.rejects(
      () =>
        runReqInboundStage3ContextCaptureOrchestration({
          rawRequest: {
            model: 'gpt-test',
            tool_outputs: [{ tool_call_id: 'call_1', output: 'ok' }]
          },
          adapterContext,
          captureContext: () => ({ stage: 'capture-only' })
        }),
      /resolveServerToolFollowupSnapshotJson.*json stringify failed/
    );
  }

  {
    const result = await runReqInboundStage3ContextCaptureOrchestration({
      rawRequest: {
        model: 'gpt-test',
        tool_outputs: [{ tool_call_id: 'call_1', output: 'ok' }]
      },
      adapterContext: makeAdapterContext({ providerProtocol: 'openai-chat' }),
      captureContext: () => ({ stage: 'capture-only' })
    });
    assert.equal(result.stage, 'capture-only');
    assert.ok(Array.isArray(result.tool_outputs));
    assert.equal(result.tool_outputs[0].tool_call_id, 'call_1');
  }

  {
    const result = await runReqInboundStage3ContextCaptureOrchestration({
      rawRequest: {
        model: 'gpt-test',
        tool_outputs: [{ tool_call_id: 'call_2', output: 'ok' }]
      },
      adapterContext: makeAdapterContext(),
      captureContext: () => ({ tool_outputs: [{ tool_call_id: 'manual', call_id: 'manual' }], keep: true })
    });
    assert.equal(result.keep, true);
    assert.equal(result.tool_outputs[0].tool_call_id, 'manual');
  }

  {
    const result = await runReqInboundStage3ContextCaptureOrchestration({
      rawRequest: { model: 'gpt-test', input: [{ type: 'message', role: 'user', content: 'hello' }] },
      adapterContext: makeAdapterContext(),
      captureContext: () => ({ merged: false })
    });
    assert.equal(result.merged, false);
    assert.equal(result.tool_outputs, undefined);
  }

  {
    const result = await runReqInboundStage3ContextCaptureOrchestration({
      rawRequest: { model: 'gpt-test' },
      adapterContext: makeAdapterContext({ providerProtocol: 'anthropic-chat' }),
      captureContext: () => {
        throw new Error('capture failed');
      }
    });
    assert.equal(result.providerProtocol, 'anthropic-chat');
  }

  {
    const result = await runReqInboundStage3ContextCaptureOrchestration({
      rawRequest: { model: 'gpt-test' },
      adapterContext: makeAdapterContext({ providerProtocol: 'gemini-chat' })
    });
    assert.equal(result.providerProtocol, 'gemini-chat');
  }

  console.log('✅ coverage-hub-req-inbound-context-capture-orchestration passed');
}

main().catch((error) => {
  console.error('❌ coverage-hub-req-inbound-context-capture-orchestration failed:', error);
  process.exit(1);
});
