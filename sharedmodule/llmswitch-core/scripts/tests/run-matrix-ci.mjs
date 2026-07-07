#!/usr/bin/env node
/**
 * Matrix CI runner: run → detect → (optional) fix → re-run → report
 *
 * Scopes:
 *  - Single-protocol loopbacks (chat/responses/anthropic)
 *  - Golden samples (chat, anthropic)
 *  - Gemini real (optional, when GEMINI_API_KEY present)
 *
 * Fixers:
 *  - Chat golden failure → recapture LM Studio provider-response and re-run
 *  - Responses client loopback missing completed → uses injection variant (already in test)
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const defaultSamplesDir = path.join(projectRoot, 'tests', 'fixtures', 'codex-samples');
if (!process.env.CODEX_SAMPLES_DIR) {
  process.env.CODEX_SAMPLES_DIR = defaultSamplesDir;
}
if (!process.env.ROUTECODEX_SAMPLES_DIR) {
  process.env.ROUTECODEX_SAMPLES_DIR = defaultSamplesDir;
}

if (process.env.ROUTECODEX_MATRIX_SKIP === '1') {
  console.log('[matrix] ROUTECODEX_MATRIX_SKIP=1, skipping matrix tests');
  process.exit(0);
}

function runNode(file, args = [], envOverride) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [file, ...args], {
      stdio: 'pipe',
      cwd: projectRoot,
      env: {
        ...process.env,
        ...(envOverride || {})
      }
    });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d.toString(); process.stdout.write(d); });
    child.stderr.on('data', (d) => { err += d.toString(); process.stderr.write(d); });
    child.on('exit', (code) => resolve({ code, out, err }));
    child.on('error', (e) => resolve({ code: 1, out, err: String(e) }));
  });
}

async function run(label, rel, options = {}) {
  const args = Array.isArray(options.args) ? options.args : [];
  const res = await runNode(path.join(projectRoot, rel), args, options.env);
  return { label, file: rel, ok: res.code === 0, out: res.out, err: res.err };
}

async function recaptureLMStudio() {
  return run('capture:lmstudio', 'scripts/tools/capture-chat-golden-lmstudio.mjs');
}

function needsRecapture(result) {
  if (result.ok) return false;
  const text = (result.out + '\n' + result.err).toLowerCase();
  return text.includes('chat golden sse roundtrip failed');
}

async function main() {
  const isCi = process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true';
  const runGoldens = process.env.LLMSWITCH_MATRIX_SKIP_GOLDENS !== '1';

  const results = [];
  // Keep local artifacts out of the llmswitch-core working tree (avoids accidental commits).
  // llmswitch-core/.gitignore already ignores ../test-results/**.
  const reportDir = path.join(projectRoot, '..', 'test-results', 'llmswitch-core');
  await fs.mkdir(reportDir, { recursive: true }).catch(() => {});

  // Build first (allow CI to select a deterministic build profile).
  const buildScript = String(process.env.LLMSWITCH_MATRIX_BUILD_SCRIPT || 'build').trim() || 'build';
  const build = await new Promise((resolve) => {
    const child = spawn('npm', ['run', buildScript], { stdio: 'inherit', cwd: projectRoot });
    child.on('exit', (code) => resolve(code === 0));
    child.on('error', () => resolve(false));
  });
  if (!build) {
    console.error(`❌ Build failed (${buildScript})`);
    process.exit(1);
  }

  // 1) loopbacks (single-protocol)
  for (const [label, file] of [
    ['looprt:chat', 'scripts/tests/loop-rt-chat.mjs'],
    ['looprt:anthropic', 'scripts/tests/loop-rt-anthropic.mjs'],
    ['looprt:gemini', 'scripts/tests/loop-rt-gemini.mjs']
  ]) {
    results.push(await run(label, file));
  }

  results.push(await run('anthropic:response-regression', 'scripts/tests/anthropic-response-regression.mjs'));

  // 1b.1) codex-samples provider-response 回归（tool_call_id 形状 + 配对）
  results.push(await run('matrix:codex-samples', 'scripts/tests/codex-matrix-regression.mjs'));
  // 1b.1.1) responses: preserve call_* tool ids when present (LM Studio compat)
  results.push(await run('matrix:responses-tool-call-id-preserve', 'scripts/tests/responses-tool-call-id-preserve.mjs'));
  // 1b.1.1.1) responses: route-selected toolCallIdStyle must override captured context (prevents leakage)
  results.push(
    await run(
      'matrix:responses-tool-call-id-style-route-wins',
      'scripts/tests/responses-tool-call-id-style-route-wins.mjs'
    )
  );
  // 1b.1.1.2) responses: latest user local image path in text should autoload into image_url block
  results.push(await run('matrix:responses-local-image-path-autoload', 'scripts/tests/responses-local-image-path-autoload.mjs'));
  // 1c) cross protocol chat chain (chat→responses→chat→anthropic→chat→gemini→chat)
  results.push(await run('matrix:cross-protocol', 'scripts/tests/cross-protocol-matrix.mjs'));
  // 1c.1.1) hub pipeline full-stage smoke (inbound→process→outbound + chat_process re-entry)
  results.push(await run('matrix:hub-pipeline-smoke', 'scripts/tests/hub-pipeline-smoke.mjs'));
  // 1c.1.1.1) coverage boosts (pure, deterministic)
  results.push(await run('matrix:coverage-openai-message-normalize', 'scripts/tests/coverage-openai-message-normalize.mjs'));
  results.push(await run('matrix:coverage-compat-lmstudio-tool-call-ids', 'scripts/tests/compat-lmstudio-tool-call-ids.mjs'));
  results.push(await run('matrix:coverage-hub-req-outbound-compat', 'scripts/tests/coverage-hub-req-outbound-compat.mjs'));
  results.push(await run('matrix:anthropic-usage-input-output-regression', 'scripts/tests/anthropic-usage-input-output-regression.mjs'));
  results.push(await run('matrix:anthropic-usage-full-preserve', 'scripts/tests/anthropic-usage-full-preserve.mjs'));
  results.push(await run('matrix:anthropic-sse-usage-merge', 'scripts/tests/anthropic-sse-usage-merge.mjs'));
  results.push(await run('matrix:anthropic-sse-stop-sequence', 'scripts/tests/anthropic-sse-stop-sequence.mjs'));
  results.push(await run('matrix:anthropic-sse-terminated-salvage', 'scripts/tests/anthropic-sse-to-json-terminated-salvage.mjs'));
  results.push(await run('matrix:openai-chat-json-text-body', 'scripts/tests/openai-chat-json-text-body.mjs'));
  results.push(await run('matrix:coverage-instruction-target', 'scripts/tests/coverage-instruction-target.mjs'));
  results.push(await run('matrix:coverage-guidance-augment', 'scripts/tests/coverage-guidance-augment.mjs'));
  results.push(
    await run('matrix:coverage-text-markup-normalizer', 'scripts/run-package-bin.mjs', {
      args: [
        'c8/bin/c8.js',
        '--lines', '95',
        '--branches', '95',
        '--functions', '95',
        '--statements', '95',
        '--reporter', 'json-summary',
        '--reporter', 'text',
        '--report-dir', 'coverage/module-text-markup-normalizer',
        '--include', 'dist/conversion/shared/text-markup-normalizer.js',
        '--exclude', '**/node_modules/**',
        'node',
        'scripts/tests/coverage-text-markup-normalizer.mjs'
      ],
      env: { C8_COVERAGE: '1' }
    })
  );
  results.push(await run('matrix:coverage-bridge-protocol-blackbox', 'scripts/tests/coverage-bridge-protocol-blackbox.mjs'));
  // 1d.1) hard-order guard: provider -> compat -> inbound -> chat_process -> outbound -> client
  results.push(await run('matrix:provider-response-chain-order', 'scripts/tests/provider-response-chain-order.mjs'));
  // 1e) virtual-router pool mode (round-robin vs priority)
  results.push(await run('matrix:virtual-router-pool-mode', 'scripts/tests/virtual-router-pool-mode.mjs'));
  // 1e.1) virtual-router direct provider.model selection (RR across keys)
  results.push(await run('matrix:virtual-router-direct-model', 'scripts/tests/virtual-router-direct-model.mjs'));
  // 1e.3) capability-based routing must use default pool (vision/web_search)
  results.push(
    await run(
      'matrix:virtual-router-capability-default-pool',
      'scripts/tests/virtual-router-capability-default-pool.mjs'
    )
  );
  // 1f) servertool followup timeout (must not hang)
  results.push(await run('matrix:vision-kimi-bypass', 'scripts/tests/vision-kimi-bypass.mjs'));
  results.push(await run('matrix:servertool-timeout', 'scripts/tests/servertool-timeout.mjs'));
  // 1f.1) stop_message_flow followup message trimming (Gemini tool-calling adjacency)
  results.push(await run('matrix:stop-message-followup-trimmer', 'scripts/tests/stop-message-followup-trimmer.mjs'));
  results.push(await run('matrix:stop-message-stage-mode-routing', 'scripts/tests/stop-message-stage-mode-routing.mjs'));
  results.push(await run('matrix:stop-message-stage-activation-validation', 'scripts/tests/stop-message-stage-activation-validation.mjs'));
  results.push(await run('matrix:stop-message-shorthand-parse', 'scripts/tests/stop-message-shorthand-parse.mjs'));
  results.push(await run('matrix:stop-message-marker-clean-and-reactivate', 'scripts/tests/stop-message-marker-clean-and-reactivate.mjs'));
  results.push(await run('matrix:stop-message-ai-followup-prompt-shape', 'scripts/tests/stop-message-ai-followup-prompt-shape.mjs'));
  results.push(await run('matrix:stop-message-captured-request-context', 'scripts/tests/stop-message-captured-request-context.mjs'));
  results.push(await run('matrix:stop-message-followup-no-recursion', 'scripts/tests/stop-message-followup-no-recursion.mjs'));
  results.push(await run('matrix:stop-message-auto-branch-coverage', 'scripts/tests/stop-message-auto-branch-coverage.mjs'));
  results.push(await run('matrix:stop-message-mode-off-default-guard', 'scripts/tests/stop-message-mode-off-default-guard.mjs'));
  results.push(await run('matrix:stop-message-global-clear-hard-reset', 'scripts/tests/stop-message-global-clear-hard-reset.mjs'));
  results.push(
    await run('matrix:servertool-client-inject-strict-failure', 'scripts/tests/servertool-client-inject-strict-failure.mjs')
  );
  results.push(
    await run('matrix:servertool-handler-error-followup', 'scripts/tests/servertool-handler-error-followup.mjs')
  );
  results.push(
    await run(
      'matrix:native-chat-process-governance-semantics',
      'scripts/tests/coverage-native-chat-process-governance-semantics.mjs'
    )
  );
  results.push(
    await run(
      'matrix:native-resp-tool-harvest-anthropic-regression',
      'scripts/tests/native-resp-tool-harvest-anthropic-regression.mjs'
    )
  );
  results.push(
    await run(
      'matrix:native-hub-pipeline-resp-semantics',
      'scripts/tests/coverage-native-hub-pipeline-resp-semantics.mjs'
    )
  );
  results.push(
    await run(
      'matrix:coverage-hub-resp-process-stage2-finalize',
      'scripts/tests/coverage-hub-resp-process-stage2-finalize.mjs'
    )
  );
  results.push(
    await run(
      'matrix:coverage-hub-req-process-route-select',
      'scripts/tests/coverage-hub-req-process-route-select.mjs'
    )
  );
  results.push(
    await run(
      'matrix:coverage-hub-req-outbound-context-merge',
      'scripts/tests/coverage-hub-req-outbound-context-merge.mjs'
    )
  );
  results.push(
    await run(
      'matrix:hub-req-process-route-select-compare',
      'scripts/tests/hub-req-process-route-select-v1-v2-compare.mjs'
    )
  );
  // 1f.3) responses freeform tool arguments (apply_patch)
  results.push(await run('matrix:responses-freeform-tool-args', 'scripts/tests/responses-freeform-tool-args.mjs'));
  // 1f.4) apply_patch freeform A/B: do not enforce structured schema in tool mapping
  results.push(await run('matrix:apply-patch-freeform-schema', 'scripts/tests/apply-patch-freeform-tool-schema-passthrough.mjs'));
  // 1f.4.1) apply_patch must accept GNU unified diff and convert to apply_patch grammar
  results.push(await run('matrix:apply-patch-gnu-diff', 'scripts/tests/apply-patch-gnu-diff-compat.mjs'));
  // 1f.4.1.1) apply_patch native regression matrix: 7 same-shape compat/state-machine gates
  results.push(await run('matrix:apply-patch-native-regression-matrix', 'scripts/tests/apply-patch-native-regression-matrix.mjs'));
  // 1f.4.2.3) responses tool loop: submit_tool_outputs resume must work for non-responses providers
  results.push(await run('matrix:responses-submit-tool-outputs-resume', 'scripts/tests/responses-submit-tool-outputs-resume.mjs'));
  // 1f.5) responses request: must not emit top-level parameters wrapper
  results.push(await run('matrix:responses-no-parameters-wrapper', 'scripts/tests/responses-request-no-parameters-wrapper.mjs'));
  results.push(await run('matrix:responses-overlong-function-name', 'scripts/tests/responses-overlong-function-name-regression.mjs'));
  // 2) goldens (chat + anthropic)
  //
  // These run against repo fixtures by default (tests/fixtures/codex-samples).
  // For local debugging you can override with CODEX_SAMPLES_DIR=...
  if (runGoldens) {
    const chatGolden = await run('golden:chat', 'scripts/tests/chat-golden-roundtrip.mjs');
    if (!chatGolden.ok && needsRecapture(chatGolden) && !isCi) {
      console.log('🔁 Recapturing LM Studio chat provider-response and retrying...');
      const cap = await recaptureLMStudio();
      results.push(cap);
      results.push(await run('golden:chat:retry', 'scripts/tests/chat-golden-roundtrip.mjs'));
    } else {
      results.push(chatGolden);
    }

    results.push(await run('golden:anthropic', 'scripts/tests/anthropic-golden-roundtrip.mjs'));
  } else {
    console.log('[matrix] LLMSWITCH_MATRIX_SKIP_GOLDENS=1, skipping goldens');
  }

  // 3) gemini real (optional)
  if (process.env.GEMINI_API_KEY) {
    const skipGeminiReal = String(process.env.LLMSWITCH_MATRIX_SKIP_GEMINI_REAL || '').trim() === '1';
    const forceGeminiReal = String(process.env.LLMSWITCH_MATRIX_RUN_GEMINI_REAL || '').trim() === '1';
    const shouldRunGeminiReal = !skipGeminiReal && (forceGeminiReal || isCi);
    if (shouldRunGeminiReal) {
      results.push(await run('real:gemini', 'scripts/tests/gemini-real-to-responses.mjs'));
    } else {
      console.log('[matrix] Skipping gemini real test (set LLMSWITCH_MATRIX_RUN_GEMINI_REAL=1 to run locally).');
    }
  }

  // Summary
  const summary = {
    timestamp: new Date().toISOString(),
    results: results.map(r => ({ label: r.label, file: r.file, ok: r.ok }))
  };
  const anyFail = results.some(r => !r.ok);
  const outFile = path.join(reportDir, `matrix-ci-${Date.now()}.json`);
  await fs.writeFile(outFile, JSON.stringify({ ...summary, details: results }, null, 2), 'utf-8');
  console.log(`\n📄 Matrix report saved: ${outFile}`);
  if (anyFail) {
    console.error('❌ Matrix failed');
    process.exit(1);
  } else {
    console.log('✅ Matrix passed');
  }
}

main().catch((e) => { console.error('Matrix runner crashed:', e); process.exit(1); });
