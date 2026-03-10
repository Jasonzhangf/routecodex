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
  const buildScript = String(process.env.LLMSWITCH_MATRIX_BUILD_SCRIPT || 'build:dev').trim() || 'build:dev';
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
    ['looprt:responses', 'scripts/tests/loop-rt-responses.mjs'],
    ['looprt:anthropic', 'scripts/tests/loop-rt-anthropic.mjs'],
    ['looprt:gemini', 'scripts/tests/loop-rt-gemini.mjs']
  ]) {
    results.push(await run(label, file));
  }

  results.push(await run('anthropic:chat-regression', 'scripts/tests/chat-to-anthropic-regression.mjs'));
  results.push(await run('anthropic:response-regression', 'scripts/tests/anthropic-response-regression.mjs'));
  results.push(await run('matrix:anthropic-outbound-postmap-tool-use-preserve', 'scripts/tests/anthropic-outbound-postmap-tool-use-preserve.mjs'));

  // 1b) protocol bridge matrix (JSON + SSE, codex samples)
  results.push(await run('matrix:bridge', 'scripts/tests/protocol-bridge-matrix.mjs'));
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
  // 1c.1) tool governance invariants
  results.push(await run('matrix:tool-governance', 'scripts/tests/tool-governance-check.mjs'));
  results.push(await run('matrix:tool-governance-native-compare', 'scripts/tests/tool-governance-native-compare.mjs'));
  results.push(await run('matrix:semantic-mapper-chat-native-compare', 'scripts/tests/semantic-mapper-chat-native-compare.mjs'));
  // 1c.1.1) hub pipeline full-stage smoke (inbound→process→outbound + chat_process re-entry)
  results.push(await run('matrix:hub-pipeline-smoke', 'scripts/tests/hub-pipeline-smoke.mjs'));
  // 1c.1.1.1) coverage boosts (pure, deterministic)
  results.push(await run('matrix:coverage-openai-message-normalize', 'scripts/tests/coverage-openai-message-normalize.mjs'));
  results.push(await run('matrix:coverage-request-tool-list-filter', 'scripts/tests/coverage-request-tool-list-filter.mjs'));
  results.push(await run('matrix:coverage-context-diff', 'scripts/tests/coverage-context-diff.mjs'));
  results.push(await run('matrix:coverage-sticky-pool', 'scripts/tests/coverage-sticky-pool-via-router.mjs'));
  results.push(await run('matrix:coverage-parse-loose-json', 'scripts/tests/coverage-parse-loose-json.mjs'));
  results.push(await run('matrix:coverage-responses-sse-parser-lmstudio-no-event', 'scripts/tests/responses-sse-parser-lmstudio-no-event.mjs'));
  results.push(await run('matrix:coverage-responses-sse-terminated-salvage', 'scripts/tests/responses-sse-to-json-terminated-salvage.mjs'));
  results.push(await run('matrix:coverage-responses-sse-missing-terminator', 'scripts/tests/responses-sse-missing-terminator.mjs'));
  results.push(await run('matrix:coverage-compat-lmstudio-tool-call-ids', 'scripts/tests/compat-lmstudio-tool-call-ids.mjs'));
  results.push(await run('matrix:coverage-compat-iflow-qwen-tool-tokens', 'scripts/tests/compat-iflow-qwen-tool-tokens.mjs'));
  results.push(
    await run(
      'matrix:compat-iflow-thinking-reasoning-content',
      'scripts/tests/compat-iflow-thinking-reasoning-content.mjs'
    )
  );
  results.push(await run('matrix:compat-iflow-kimi-history-media-placeholder', 'scripts/tests/compat-iflow-kimi-history-media-placeholder.mjs'));
  results.push(await run('matrix:compat-iflow-reasoning-replay-20260206', 'scripts/tests/compat-iflow-reasoning-replay-20260206.mjs'));
  results.push(await run('matrix:compat-profile-auto-resolve', 'scripts/tests/compat-profile-auto-resolve.mjs'));
  results.push(await run('matrix:coverage-hub-req-outbound-compat', 'scripts/tests/coverage-hub-req-outbound-compat.mjs'));
  results.push(await run('matrix:deepseek-web-compat-tool-calling', 'scripts/tests/deepseek-web-compat-tool-calling.mjs'));
  results.push(await run('matrix:anthropic-usage-input-output-regression', 'scripts/tests/anthropic-usage-input-output-regression.mjs'));
  results.push(await run('matrix:anthropic-usage-full-preserve', 'scripts/tests/anthropic-usage-full-preserve.mjs'));
  results.push(await run('matrix:anthropic-sse-usage-merge', 'scripts/tests/anthropic-sse-usage-merge.mjs'));
  results.push(await run('matrix:anthropic-sse-stop-sequence', 'scripts/tests/anthropic-sse-stop-sequence.mjs'));
  results.push(await run('matrix:anthropic-sse-terminated-salvage', 'scripts/tests/anthropic-sse-to-json-terminated-salvage.mjs'));
  results.push(await run('matrix:deepseek-bootstrap-multi-key-scan', 'scripts/tests/deepseek-bootstrap-multi-key-scan.mjs'));
  results.push(await run('matrix:openai-chat-json-text-body', 'scripts/tests/openai-chat-json-text-body.mjs'));
  results.push(await run('matrix:coverage-chat-sse-openai-no-event', 'scripts/tests/chat-sse-to-json-openai-no-event.mjs'));
  results.push(await run('matrix:coverage-chat-sse-deepseek-web-patch', 'scripts/tests/chat-sse-to-json-deepseek-web-patch.mjs'));
  results.push(await run('matrix:coverage-instruction-target', 'scripts/tests/coverage-instruction-target.mjs'));
  results.push(await run('matrix:coverage-guidance-augment', 'scripts/tests/coverage-guidance-augment.mjs'));
  results.push(await run('matrix:coverage-tool-harvester', 'scripts/tests/coverage-tool-harvester.mjs'));
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
  results.push(await run('matrix:coverage-recursive-detection-guard', 'scripts/tests/coverage-recursive-detection-guard.mjs'));
  results.push(await run('matrix:coverage-tool-surface-engine', 'scripts/tests/coverage-tool-surface-engine.mjs'));
  results.push(await run('matrix:coverage-structured-apply-patch', 'scripts/tests/coverage-structured-apply-patch.mjs'));
  results.push(await run('matrix:coverage-engine-health', 'scripts/tests/coverage-engine-health.mjs'));
  results.push(await run('matrix:coverage-bridge-protocol-blackbox', 'scripts/tests/coverage-bridge-protocol-blackbox.mjs'));
  // 1c.2) glm /v1/responses compat + tool governance
  results.push(await run('matrix:glm-responses-compat', 'scripts/tests/glm-responses-compat.mjs'));
  // 1c.3) gemini inbound finish_reason invariants (tool_calls)
  results.push(await run('matrix:gemini-finish-reason', 'scripts/tests/gemini-finish-reason.mjs'));
  // 1c.3.1) gemini outbound tool schema sanitization (oneOf/anyOf/allOf)
  results.push(await run('matrix:gemini-tool-schema-sanitize', 'scripts/tests/gemini-tool-schema-sanitize.mjs'));
  // 1c.4) antigravity Claude-thinking outbound shape (Anthropic vs Responses)
  results.push(await run('matrix:antigravity-claude-thinking', 'scripts/tests/antigravity-claude-thinking-shape.mjs'));
  // 1c.4.1) antigravity: tool schema must be downlinked (functionDeclarations)
  results.push(await run('matrix:antigravity-tools-downlink', 'scripts/tests/antigravity-tools-downlink.mjs'));
  // 1c.4.1.1) antigravity: session-based thoughtSignature cache/inject (Gemini functionCall parts)
  results.push(await run('matrix:antigravity-gemini-signature-cache', 'scripts/tests/antigravity-gemini-signature-cache.mjs'));
  // 1c.4.1.2) antigravity: thoughtSignature prepare recovery (invalidate + retry hint)
  results.push(
    await run(
      'matrix:antigravity-thought-signature-prepare-recovery',
      'scripts/tests/antigravity-thought-signature-prepare-recovery.mjs'
    )
  );
  // 1c.4.2) web_search route: tools list must be cleaned regardless of route name ("web_search" vs "search")
  results.push(await run('matrix:web-search-route-tools-clean', 'scripts/tests/web-search-route-tools-clean.mjs'));
	  // 1c.4.2.1) web_search backend handler smoke (providerInvoker + reenterPipeline)
	  results.push(await run('matrix:web-search-backend-smoke', 'scripts/tests/web-search-backend-smoke.mjs'));
	  // 1c.4.3) clock tool schema must satisfy OpenAI strict JSON-schema rules (required/additionalProperties)
	  results.push(await run('matrix:clock-tool-schema-openai-strict', 'scripts/tests/clock-tool-schema-openai-strict.mjs'));
	  // 1c.4.3.1) clock daemon/tmux metadata must propagate into adapterContext so session scope resolves to clockd.<daemonId>
	  results.push(await run('matrix:clock-session-scope-daemon-context', 'scripts/tests/clock-session-scope-daemon-context.mjs'));
  // 1d) responses provider response chain
  results.push(await run('matrix:responses-chain', 'scripts/tests/hub-response-chain.mjs'));
  // 1d.1) hard-order guard: provider -> compat -> inbound -> chat_process -> outbound -> client
  results.push(await run('matrix:provider-response-chain-order', 'scripts/tests/provider-response-chain-order.mjs'));
  // 1e) virtual-router pool mode (round-robin vs priority)
  results.push(await run('matrix:virtual-router-pool-mode', 'scripts/tests/virtual-router-pool-mode.mjs'));
  // 1e.0) quotaView must override health snapshot cooldown restores (except explicit safety policy TTLs).
  results.push(
    await run(
      'matrix:virtual-router-quota-health-restore',
      'scripts/tests/virtual-router-quota-health-restore.mjs'
    )
  );
  // 1e.0.1) antigravity: after repeated identical errors, prefer non-antigravity fallbacks when possible
  results.push(await run('matrix:virtual-router-antigravity-retry-fallback', 'scripts/tests/virtual-router-antigravity-retry-fallback.mjs'));
  // 1e.0.2) antigravity: scope Google account verification errors to the failing runtimeKey (do not global-cooldown).
  results.push(await run('matrix:virtual-router-antigravity-risk-scope', 'scripts/tests/virtual-router-antigravity-risk-scope.mjs'));
  // 1e.0.3) antigravity: missing thoughtSignature should immediately freeze Gemini series (avoid request storms).
  results.push(await run('matrix:virtual-router-antigravity-thought-signature-freeze', 'scripts/tests/virtual-router-antigravity-thought-signature-freeze.mjs'));
  // 1e.1) virtual-router direct provider.model selection (RR across keys)
  results.push(await run('matrix:virtual-router-direct-model', 'scripts/tests/virtual-router-direct-model.mjs'));
  // 1e.2) route classifier: local search tools must not be misrouted to web_search
  results.push(await run('matrix:web-search-vs-search-route', 'scripts/tests/web-search-vs-search-route.mjs'));
  // 1f) servertool followup timeout (must not hang)
  results.push(await run('matrix:virtual-router-media-kimi-route', 'scripts/tests/virtual-router-media-kimi-route.mjs'));
  results.push(await run('matrix:vision-kimi-bypass', 'scripts/tests/vision-kimi-bypass.mjs'));
  results.push(await run('matrix:servertool-timeout', 'scripts/tests/servertool-timeout.mjs'));
  // 1f.1) stop_message_flow followup message trimming (Gemini tool-calling adjacency)
  results.push(await run('matrix:stop-message-followup-trimmer', 'scripts/tests/stop-message-followup-trimmer.mjs'));
  results.push(await run('matrix:stop-message-stage-mode-routing', 'scripts/tests/stop-message-stage-mode-routing.mjs'));
  results.push(await run('matrix:stop-message-stage-activation-validation', 'scripts/tests/stop-message-stage-activation-validation.mjs'));
  results.push(await run('matrix:stop-message-shorthand-parse', 'scripts/tests/stop-message-shorthand-parse.mjs'));
  results.push(await run('matrix:stop-message-marker-clean-and-reactivate', 'scripts/tests/stop-message-marker-clean-and-reactivate.mjs'));
  results.push(await run('matrix:stop-message-followup-iflow-trim', 'scripts/tests/stop-message-followup-iflow-trim.mjs'));
  results.push(await run('matrix:stop-message-ai-followup-prompt-shape', 'scripts/tests/stop-message-ai-followup-prompt-shape.mjs'));
  results.push(await run('matrix:stop-message-captured-request-context', 'scripts/tests/stop-message-captured-request-context.mjs'));
  results.push(await run('matrix:stop-message-followup-no-recursion', 'scripts/tests/stop-message-followup-no-recursion.mjs'));
  results.push(await run('matrix:stop-message-counter-and-fallback', 'scripts/tests/stop-message-counter-and-fallback.mjs'));
  results.push(await run('matrix:stop-message-auto-branch-coverage', 'scripts/tests/stop-message-auto-branch-coverage.mjs'));
  results.push(await run('matrix:stop-message-mode-off-default-guard', 'scripts/tests/stop-message-mode-off-default-guard.mjs'));
  results.push(await run('matrix:stop-message-global-clear-hard-reset', 'scripts/tests/stop-message-global-clear-hard-reset.mjs'));
  // 1f.1.1) serverToolFollowup hops must not re-enter ServerTool orchestration (prevents nested loops)
  results.push(await run('matrix:servertool-followup-skip', 'scripts/tests/servertool-followup-skip.mjs'));
  // 1f.1.2) followup can optionally preserve client tools (stop_message_flow continuation)
  results.push(await run('matrix:servertool-followup-preserve-tools', 'scripts/tests/servertool-followup-preserve-tools.mjs'));
  // 1f.2) servertool followup must accept requires_action payloads (tool call)
  results.push(await run('matrix:servertool-followup-requires-action', 'scripts/tests/servertool-followup-requires-action.mjs'));
  // 1f.2.1) responses empty-completed reply should auto-continue and include tool list hint
  results.push(await run('matrix:servertool-empty-responses-continue', 'scripts/tests/servertool-empty-responses-continue.mjs'));
  // 1f.2.2) continue_execution no-op tool should auto-followup and keep tool list available
  results.push(
    await run('matrix:servertool-continue-execution-followup', 'scripts/tests/servertool-continue-execution-followup.mjs')
  );
  results.push(
    await run('matrix:servertool-client-inject-strict-failure', 'scripts/tests/servertool-client-inject-strict-failure.mjs')
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
      'matrix:native-chat-process-clock-reminder-semantics',
      'scripts/tests/coverage-native-chat-process-clock-reminder-semantics.mjs'
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
      'matrix:coverage-hub-req-inbound-semantic-lift',
      'scripts/tests/coverage-hub-req-inbound-semantic-lift.mjs'
    )
  );
  results.push(
    await run(
      'matrix:coverage-hub-req-inbound-context-capture-orchestration',
      'scripts/tests/coverage-hub-req-inbound-context-capture-orchestration.mjs'
    )
  );
  results.push(
    await run(
      'matrix:coverage-hub-req-inbound-context-tool-snapshot',
      'scripts/tests/coverage-hub-req-inbound-context-tool-snapshot.mjs'
    )
  );
  results.push(
    await run(
      'matrix:coverage-hub-req-inbound-responses-context-snapshot',
      'scripts/tests/coverage-hub-req-inbound-responses-context-snapshot.mjs'
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
      'matrix:coverage-hub-native-batch',
      'scripts/tests/coverage-hub-native-batch.mjs'
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
  // 1f.4.1.1) apply_patch args normalizer: action skeleton + configurable pipeline
  results.push(await run('matrix:apply-patch-action-pipeline', 'scripts/tests/apply-patch-action-pipeline.mjs'));
  // 1f.4.2.3) responses tool loop: submit_tool_outputs resume must work for non-responses providers
  results.push(await run('matrix:responses-submit-tool-outputs-resume', 'scripts/tests/responses-submit-tool-outputs-resume.mjs'));
  // 1f.5) responses request: must not emit top-level parameters wrapper
  results.push(await run('matrix:responses-no-parameters-wrapper', 'scripts/tests/responses-request-no-parameters-wrapper.mjs'));
  results.push(await run('matrix:responses-overlong-function-name', 'scripts/tests/responses-overlong-function-name-regression.mjs'));
  // 1f.6) hub policy: enforce outbound sanitize/flatten (responses)
  results.push(await run('matrix:hub-policy-enforce-responses', 'scripts/tests/hub-policy-enforce-responses.mjs'));
  // 1f.7) hub policy: enforce outbound sanitize/flatten (openai-chat / anthropic / gemini)
  results.push(await run('matrix:hub-policy-enforce-openai-chat', 'scripts/tests/hub-policy-enforce-openai-chat.mjs'));
  results.push(await run('matrix:hub-policy-enforce-anthropic', 'scripts/tests/hub-policy-enforce-anthropic.mjs'));
  results.push(await run('matrix:hub-policy-enforce-gemini', 'scripts/tests/hub-policy-enforce-gemini.mjs'));

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
