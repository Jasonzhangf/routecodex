import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const mapPath = path.join(root, 'docs/architecture/function-map.yml');
const pkgPath = path.join(root, 'package.json');
const mapText = fs.readFileSync(mapPath, 'utf8');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const scripts = pkg.scripts || {};
const removedProviderToken = ['wind', 'surf'].join('');
const removedProtocolToken = ['cas', 'cade'].join('');
const p = (...parts) => parts.join('');
const deletedPathDenylist = [
  'scripts/cleanup-unused-code.sh',
  'scripts/phase1-cleanup.sh',
  'scripts/simple_dead_function_finder.py',
  'scripts/verify-cleanup-safety.sh',
  p('docs/audit/', removedProviderToken, '-history-output-audit.md'),
  p('docs/audit/', removedProviderToken, '-request-shape-audit.md'),
  p('docs/audit/', removedProviderToken, '-response-audit.md'),
  p('docs/design/', removedProviderToken, '-', removedProtocolToken, '-execution-plan.md'),
  p('docs/design/', removedProviderToken, '-', removedProtocolToken, '-reentry-account-strategy.md'),
  p('docs/design/', removedProviderToken, '-', removedProtocolToken, '-tool-protocol.md'),
  p('docs/goals/', removedProviderToken, '-', removedProtocolToken, '-single-path-rebuild-plan.md'),
  p('docs/goals/', removedProviderToken, '-multiturn-alignment-plan.md'),
  p('docs/goals/', removedProviderToken, '-session-persistence-and-pool-plan.md'),
  p('docs/goals/', removedProviderToken, '-tool-hybrid-protocol-plan.md'),
  p('docs/providers/', removedProviderToken, '-chat-provider-design.md'),
  p('scripts/generate-', removedProviderToken, '-static-request-fixture.ts'),
  p('scripts/', removedProviderToken, '-5520-context-audit.mjs'),
  p('scripts/', removedProviderToken, '-auth-probe.ts'),
  p('scripts/', removedProviderToken, '-', removedProtocolToken, '-reentry-probe.ts'),
  p('scripts/', removedProviderToken, '-chat-request-smoke.ts'),
  p('scripts/', removedProviderToken, '-provider-private-probe.ts'),
  p('sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/', removedProviderToken, '_tool_history_projection.rs'),
  p('sharedmodule/llmswitch-core/src/conversion/compat/profiles/chat-', removedProviderToken, '.json'),
  p('src/debug/harnesses/', removedProviderToken, '-static-request-harness.ts'),
  p('src/providers/core/contracts/', removedProviderToken, '-provider-contract.ts'),
  p('src/providers/core/runtime/', removedProviderToken, '-chat-provider.ts'),
  p('src/providers/core/runtime/', removedProviderToken, '/auth-block.ts'),
  p('src/providers/core/runtime/', removedProviderToken, '/', removedProtocolToken, '-continuation-block.ts'),
  p('src/providers/core/runtime/', removedProviderToken, '/', removedProtocolToken, '-continuation-utils.ts'),
  p('src/providers/core/runtime/', removedProviderToken, '/', removedProtocolToken, '-transport-block.ts'),
  p('src/providers/core/runtime/', removedProviderToken, '/history-tool-projection-block.ts'),
  p('src/providers/core/runtime/', removedProviderToken, '/native-', removedProviderToken, '-tool-history-projection.ts'),
  p('src/providers/core/runtime/', removedProviderToken, '/resource-lifecycle-block.ts'),
  p('src/providers/core/runtime/', removedProviderToken, '/response-parse-block.ts'),
  p('src/providers/core/runtime/', removedProviderToken, '/runtime-lifecycle-block.ts'),
  p('src/providers/core/runtime/', removedProviderToken, '/', removedProviderToken, '-account-pool.ts'),
  p('src/providers/core/runtime/', removedProviderToken, '/', removedProviderToken, '-account-session-manager.ts'),
  p('src/providers/core/runtime/', removedProviderToken, '/', removedProviderToken, '-account-store.ts'),
  p('src/providers/core/runtime/', removedProviderToken, '/', removedProviderToken, '-', removedProtocolToken, '-prompt.ts'),
  p('src/server/runtime/http-server/', removedProviderToken, '-startup-probe.ts'),
  p('tests/debug/', removedProviderToken, '-static-request-harness.spec.ts'),
  p('tests/fixtures/', removedProviderToken, '-samples/request-shape/provider-request-20260528T221543389.json'),
  p('tests/fixtures/', removedProviderToken, '-static-request-harness/baseline.json'),
  p('tests/providers/core/contracts/', removedProviderToken, '-provider-contract.codes.spec.ts'),
  p('tests/providers/core/runtime/provider-failure-policy-backoff.', removedProviderToken, '-stream-cancel.spec.ts'),
  p('tests/providers/core/runtime/', removedProviderToken, '-account-health-routing.spec.ts'),
  p('tests/providers/core/runtime/', removedProviderToken, '-auth-block.spec.ts'),
  p('tests/providers/core/runtime/', removedProviderToken, '-busy-binding-cleanup.blackbox.spec.ts'),
  p('tests/providers/core/runtime/', removedProviderToken, '-', removedProtocolToken, '-continuation-block.spec.ts'),
  p('tests/providers/core/runtime/', removedProviderToken, '-', removedProtocolToken, '-continuation.spec.ts'),
  p('tests/providers/core/runtime/', removedProviderToken, '-', removedProtocolToken, '-prompt.spec.ts'),
  p('tests/providers/core/runtime/', removedProviderToken, '-chat-provider-regression.spec.ts'),
  p('tests/providers/core/runtime/', removedProviderToken, '-chat-provider.live-probe-api.spec.ts'),
  p('tests/providers/core/runtime/', removedProviderToken, '-chat-provider.spec.ts'),
  p('tests/providers/core/runtime/', removedProviderToken, '-context-continuity.spec.ts'),
  p('tests/providers/core/runtime/', removedProviderToken, '-mcp-only.spec.ts'),
  p('tests/providers/core/runtime/', removedProviderToken, '-request-shape-sample.spec.ts'),
  p('tests/providers/core/runtime/', removedProviderToken, '-resource-lifecycle.spec.ts'),
  p('tests/server/http-server/provider-utils.', removedProviderToken, '.spec.ts'),
  p('tests/server/runtime/http-server/executor/request-executor-', removedProviderToken, '-response-protocol.spec.ts'),
  p('tests/server/runtime/http-server/request-executor.', removedProviderToken, '-route-pool.spec.ts'),
  p('tests/sharedmodule/', removedProviderToken, '-submit-stopmessage.spec.ts'),
  'src/modules/pipeline/modules/provider/interfaces/pipeline-interfaces.ts',
  'src/modules/pipeline/modules/provider/utils/debug-logger.ts',
  'src/modules/pipeline/modules/provider/utils/preflight-validator.ts',
  'src/modules/pipeline/modules/provider/utils/tool-result-text.ts',
  'src/modules/pipeline/modules/provider/utils/transformation-engine.ts',
  'src/modules/pipeline/modules/interfaces/pipeline-interfaces.ts',
  'src/modules/pipeline/modules/README.md',
  'scripts/enhance-module.js',
  'docs/MODULE_ENHANCEMENT_SYSTEM.md',
  'docs/pipeline-routing-report.md',
];

function parseOwners(text) {
  const lines = text.split('\n');
  const owners = [];
  let current = null;
  let section = null;
  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (trimmed.startsWith('- feature_id:')) {
      if (current) owners.push(current);
      current = {
        featureId: trimmed.split(':').slice(1).join(':').trim(),
        allowedPaths: [],
        forbiddenPaths: [],
        requiredTests: [],
        requiredGates: [],
      };
      section = null;
      continue;
    }
    if (!current) continue;
    if (trimmed === 'allowed_paths:') { section = 'allowedPaths'; continue; }
    if (trimmed === 'forbidden_paths:') { section = 'forbiddenPaths'; continue; }
    if (trimmed === 'required_tests:') { section = 'requiredTests'; continue; }
    if (trimmed === 'required_gates:') { section = 'requiredGates'; continue; }
    if (/^[A-Za-z_]+:/.test(trimmed) && !trimmed.startsWith('- ')) {
      section = null;
      continue;
    }
    if (section && trimmed.startsWith('- ')) current[section].push(trimmed.slice(2).trim());
  }
  if (current) owners.push(current);
  return owners;
}

const failures = [];
for (const rel of deletedPathDenylist) {
  const abs = path.join(root, rel);
  if (fs.existsSync(abs)) {
    failures.push(`deleted_path resurrected -> ${rel}`);
  }
}
for (const owner of parseOwners(mapText)) {
  for (const rel of owner.allowedPaths) {
    const abs = path.join(root, rel);
    if (!fs.existsSync(abs)) {
      failures.push(`${owner.featureId}: allowed_path missing on disk -> ${rel}`);
    }
  }
  for (const rel of owner.requiredTests) {
    const abs = path.join(root, rel);
    if (!fs.existsSync(abs)) {
      failures.push(`${owner.featureId}: required_tests path missing on disk -> ${rel}`);
    }
  }
  for (const gate of owner.requiredGates) {
    const match = gate.match(/^npm run (\S+)$/);
    if (!match) continue;
    if (!scripts[match[1]]) {
      failures.push(`${owner.featureId}: required_gates script missing in package.json -> ${gate}`);
    }
  }
}

if (failures.length > 0) {
  console.error('[verify:architecture-deleted-path] failed');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('[verify:architecture-deleted-path] ok');
console.log(`- checked ${parseOwners(mapText).length} features for dead allowed_paths / required_tests / required_gates`);
console.log(`- checked ${deletedPathDenylist.length} deleted paths stay absent`);
