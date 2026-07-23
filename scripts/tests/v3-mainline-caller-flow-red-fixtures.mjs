#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';

const root = process.cwd();
const sourcePath = path.join(root, 'docs/architecture/v3-mainline-call-map.yml');
const parsed = YAML.parse(fs.readFileSync(sourcePath, 'utf8'));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-caller-flow-red-'));
const mapPath = path.join(tmp, 'v3-mainline-call-map.yml');
const outPath = path.join(tmp, 'v3-mainline-caller-flow.md');

function runExpectFail(name, mutate, expectedText) {
  const copy = structuredClone(parsed);
  mutate(copy);
  fs.writeFileSync(mapPath, YAML.stringify(copy), 'utf8');
  fs.writeFileSync(outPath, '<stale>\n', 'utf8');
  const script = `
    import fs from 'node:fs';
    import { auditV3CallerFlow, renderV3MainlineCallerFlowMarkdown } from ${JSON.stringify(path.join(root, 'scripts/architecture/v3-mainline-caller-flow-lib.mjs'))};
    const root = ${JSON.stringify(root)};
    const mapPath = ${JSON.stringify(path.relative(root, mapPath))};
    const parsed = (await import('yaml')).default.parse(fs.readFileSync(${JSON.stringify(mapPath)}, 'utf8'));
    const audit = auditV3CallerFlow(parsed);
    const expected = renderV3MainlineCallerFlowMarkdown(root, mapPath);
    const failures = [];
    if (audit.forbiddenDirectProjection.length) failures.push('forbidden direct response projection edge');
    if (audit.invalidAggregateEntry.length) failures.push('invalid aggregate wrapper edge');
    if (audit.missing.length) failures.push('missing caller map field');
    if (!expected.includes('flowchart TD')) failures.push('render missing flowchart');
    if (!failures.length) process.exit(0);
    console.error(failures.join('\\n'));
    process.exit(1);
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: root, encoding: 'utf8' });
  if (result.status === 0) {
    console.error(`[v3-mainline-caller-flow-red] ${name}: expected failure but passed`);
    process.exit(1);
  }
  const output = `${result.stdout}\n${result.stderr}`;
  if (!output.includes(expectedText)) {
    console.error(`[v3-mainline-caller-flow-red] ${name}: missing expected text ${expectedText}`);
    console.error(output);
    process.exit(1);
  }
  console.log(`[v3-mainline-caller-flow-red] ${name}: failed as expected`);
}

runExpectFail('forbidden-direct-response-projection-edge', (copy) => {
  copy.chains[0].edges.push({
    step_id: 'red-direct-projection',
    from_node: 'V3ProviderRespInbound01Raw',
    to_node: 'V3ServerRespOutbound06ClientFrame',
    caller_symbol: 'provider_response_raw_handler',
    caller_file: 'v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs',
    callee_symbol: 'project_directly_to_client_sse',
    callee_file: 'v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs',
    status: 'anchored',
    owner_feature_id: copy.chains[0].owner_feature_id,
  });
}, 'forbidden direct response projection edge');

runExpectFail('aggregate-entry-edge-missing-kind', (copy) => {
  copy.chains[0].edges.push({
    step_id: 'red-aggregate-normal-edge',
    from_node: 'V3HubReqInbound01ClientRaw',
    to_node: 'V3ServerRespOutbound06ClientFrame',
    caller_symbol: 'execute_v3_responses_relay_runtime_with_transport_health_local_continuation_and_stopless_control',
    caller_file: 'v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs',
    callee_symbol: 'responses_relay_output_response',
    callee_file: 'v3/crates/routecodex-v3-server/src/lib.rs',
    status: 'anchored',
    owner_feature_id: copy.chains[0].owner_feature_id,
  });
}, 'invalid aggregate wrapper edge');

runExpectFail('missing-caller-symbol', (copy) => {
  delete copy.chains[0].edges[0].caller_symbol;
}, 'missing caller map field');

{
  const script = `
    import { auditV3CallerFlowSourceText } from ${JSON.stringify(path.join(root, 'scripts/architecture/v3-mainline-caller-flow-lib.mjs'))};
    const audit = auditV3CallerFlowSourceText('V3RegisteredHook { input_node: "V3ProviderResp14Raw", output_node: "V3Resp15ClientPayload" }', 'fixture/hooks.rs');
    if (!audit.forbiddenRegisteredHooks.length) process.exit(0);
    console.error('forbidden source registered direct response edge');
    process.exit(1);
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: root, encoding: 'utf8' });
  if (result.status === 0) {
    console.error('[v3-mainline-caller-flow-red] source-registered-direct-response-hook: expected failure but passed');
    process.exit(1);
  }
  const output = `${result.stdout}\n${result.stderr}`;
  if (!output.includes('forbidden source registered direct response edge')) {
    console.error('[v3-mainline-caller-flow-red] source-registered-direct-response-hook: missing expected text');
    console.error(output);
    process.exit(1);
  }
  console.log('[v3-mainline-caller-flow-red] source-registered-direct-response-hook: failed as expected');
}

{
  const script = `
    import { auditV3ArchitectureLocks, chainFingerprint } from ${JSON.stringify(path.join(root, 'scripts/architecture/v3-mainline-caller-flow-lib.mjs'))};
    const parsed = ${JSON.stringify(parsed)};
    const lockedChain = parsed.chains[0];
    const locks = {
      schema_version: 1,
      locked_items: [{
        item_id: 'chain:' + lockedChain.chain_id,
        chain_id: lockedChain.chain_id,
        status: 'audited_locked',
        reviewed_by: 'Jason',
        locked_at: '2026-07-23T00:00:00Z',
        fingerprint: chainFingerprint(lockedChain)
      }],
      manual_authorizations: []
    };
    parsed.chains[0].edges[0].to_node = 'V3RedChangedLockedNode';
    const audit = auditV3ArchitectureLocks(parsed, locks);
    if (!audit.failures.some((failure) => failure.includes('audited locked fingerprint changed'))) process.exit(0);
    console.error('audited locked fingerprint changed');
    process.exit(1);
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: root, encoding: 'utf8' });
  if (result.status === 0) {
    console.error('[v3-mainline-caller-flow-red] audited-lock-fingerprint-change: expected failure but passed');
    process.exit(1);
  }
  const output = `${result.stdout}\n${result.stderr}`;
  if (!output.includes('audited locked fingerprint changed')) {
    console.error('[v3-mainline-caller-flow-red] audited-lock-fingerprint-change: missing expected text');
    console.error(output);
    process.exit(1);
  }
  console.log('[v3-mainline-caller-flow-red] audited-lock-fingerprint-change: failed as expected');
}

{
  const script = `
    import { auditV3ArchitectureLocks } from ${JSON.stringify(path.join(root, 'scripts/architecture/v3-mainline-caller-flow-lib.mjs'))};
    const parsed = ${JSON.stringify(parsed)};
    const locks = {
      schema_version: 1,
      policy: {
        gate_audit_status: 'determined_locked',
        main_skeleton_sop: 'docs/architecture/wiki/v3-mainline-skeleton-sop.md',
        required_locked_chains: ['v3.hub_pipeline.v1.request']
      },
      locked_items: [],
      manual_authorizations: []
    };
    const audit = auditV3ArchitectureLocks(parsed, locks);
    if (!audit.failures.some((failure) => failure.includes('required main skeleton chain is not audited_locked'))) process.exit(0);
    console.error('required main skeleton chain is not audited_locked');
    process.exit(1);
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: root, encoding: 'utf8' });
  if (result.status === 0) {
    console.error('[v3-mainline-caller-flow-red] missing-required-main-skeleton-lock: expected failure but passed');
    process.exit(1);
  }
  const output = `${result.stdout}\n${result.stderr}`;
  if (!output.includes('required main skeleton chain is not audited_locked')) {
    console.error('[v3-mainline-caller-flow-red] missing-required-main-skeleton-lock: missing expected text');
    console.error(output);
    process.exit(1);
  }
  console.log('[v3-mainline-caller-flow-red] missing-required-main-skeleton-lock: failed as expected');
}


{
  const script = `
    import { auditV3ReviewSurfaceHtmlText } from ${JSON.stringify(path.join(root, 'scripts/architecture/v3-mainline-caller-flow-lib.mjs'))};
    const html = '<html><h2>Request skeleton / 请求主骨架</h2><div>V3HubReqInbound01ClientRaw V3HubReqChatProcess04Governed ProviderReqCompat06ProviderCompat V3ProviderReqOutbound08WirePayload v3.hub_pipeline.v1.request</div><h2>Response skeleton / 响应主骨架</h2><div>V3ProviderRespInbound01Raw ProviderRespCompat02ProviderCompat V3HubRespChatProcess03Governed V3HubRespContinuation04Committed v3.hub_pipeline.v1.response</div></html>';
    const audit = auditV3ReviewSurfaceHtmlText(html, 'fixture.html');
    if (!audit.failures.some((failure) => failure.includes('Error resources'))) process.exit(0);
    console.error('missing review marker Error resources');
    process.exit(1);
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: root, encoding: 'utf8' });
  if (result.status === 0) {
    console.error('[v3-mainline-caller-flow-red] missing-error-resource-review-section: expected failure but passed');
    process.exit(1);
  }
  const output = `${result.stdout}
${result.stderr}`;
  if (!output.includes('missing review marker Error resources')) {
    console.error('[v3-mainline-caller-flow-red] missing-error-resource-review-section: missing expected text');
    console.error(output);
    process.exit(1);
  }
  console.log('[v3-mainline-caller-flow-red] missing-error-resource-review-section: failed as expected');
}

{
  const script = `
    import { auditV3ReviewSurfaceHtmlText } from ${JSON.stringify(path.join(root, 'scripts/architecture/v3-mainline-caller-flow-lib.mjs'))};
    const html = '<html><h2>Request skeleton / 请求主骨架</h2><div>V3HubReqInbound01ClientRaw V3HubReqChatProcess04Governed V3ProviderReqOutbound08WirePayload v3.hub_pipeline.v1.request</div><h2>Response skeleton / 响应主骨架</h2><div>V3ProviderRespInbound01Raw ProviderRespCompat02ProviderCompat V3HubRespChatProcess03Governed V3HubRespContinuation04Committed v3.hub_pipeline.v1.response</div><h2>Error resources / 错误处理资源</h2><div>V3Error01SourceRaised V3Error06ClientProjected v3.provider.health_state v3.error.client_projection</div></html>';
    const audit = auditV3ReviewSurfaceHtmlText(html, 'fixture.html');
    if (!audit.failures.some((failure) => failure.includes('provider request compat'))) process.exit(0);
    console.error('request skeleton must show provider request compat before wire payload');
    process.exit(1);
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: root, encoding: 'utf8' });
  if (result.status === 0) {
    console.error('[v3-mainline-caller-flow-red] missing-provider-req-compat-review-marker: expected failure but passed');
    process.exit(1);
  }
  const output = `${result.stdout}
${result.stderr}`;
  if (!output.includes('provider request compat')) {
    console.error('[v3-mainline-caller-flow-red] missing-provider-req-compat-review-marker: missing expected text');
    console.error(output);
    process.exit(1);
  }
  console.log('[v3-mainline-caller-flow-red] missing-provider-req-compat-review-marker: failed as expected');
}


{
  const script = `
    import { auditV3ReviewSurfaceHtmlText } from ${JSON.stringify(path.join(root, 'scripts/architecture/v3-mainline-caller-flow-lib.mjs'))};
    const html = '<html><h2>Request skeleton / 请求主骨架</h2><div>V3HubReqInbound01ClientRaw V3HubReqChatProcess04Governed ProviderReqCompat06ProviderCompat V3Router05RequestClassified V3Target10ConcreteProviderSelected V3ProviderReqOutbound08WirePayload v3.hub_pipeline.v1.request</div><h2>Response skeleton / 响应主骨架</h2><div>V3ProviderRespInbound01Raw ProviderRespCompat02ProviderCompat V3HubRespChatProcess03Governed V3HubRespContinuation04Committed v3.hub_pipeline.v1.response</div><h2>Error resources / 错误处理资源</h2><div>V3Error01SourceRaised V3Error06ClientProjected v3.provider.health_state v3.error.client_projection</div></html>';
    const audit = auditV3ReviewSurfaceHtmlText(html, 'fixture.html');
    if (!audit.failures.some((failure) => failure.includes('typed-test-only'))) process.exit(0);
    console.error('missing review marker typed-test-only');
    process.exit(1);
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: root, encoding: 'utf8' });
  if (result.status === 0) {
    console.error('[v3-mainline-caller-flow-red] missing-review-status-legend: expected failure but passed');
    process.exit(1);
  }
  const output = `${result.stdout}
${result.stderr}`;
  if (!output.includes('typed-test-only')) {
    console.error('[v3-mainline-caller-flow-red] missing-review-status-legend: missing expected text');
    console.error(output);
    process.exit(1);
  }
  console.log('[v3-mainline-caller-flow-red] missing-review-status-legend: failed as expected');
}
