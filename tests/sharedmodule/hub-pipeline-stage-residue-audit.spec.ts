import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from '@jest/globals';

interface ResidueCheck {
  label: string;
  pattern: RegExp;
}

function collectMatches(source: string, checks: ResidueCheck[]): string[] {
  const lines = source.split('\n');
  const findings: string[] = [];
  for (const check of checks) {
    for (let index = 0; index < lines.length; index += 1) {
      if (check.pattern.test(lines[index] ?? '')) {
        findings.push(`${check.label}@L${index + 1}`);
      }
    }
  }
  return findings;
}

describe('hub pipeline stage residue audit', () => {
  it('rust lib total entry must exist before HubPipeline mainline can be switched', () => {
    const crateRoot = path.join(
      process.cwd(),
      'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src',
    );
    const requiredFiles = [
      'hub_pipeline_lib/mod.rs',
      'hub_pipeline_lib/engine.rs',
      'hub_pipeline_lib/types.rs',
      'hub_pipeline_lib/errors.rs',
      'hub_pipeline_lib/effect_plan.rs',
      'hub_pipeline_lib/diagnostics.rs',
      'hub_pipeline_lib/stage_catalog.rs',
    ];

    const missing = requiredFiles.filter((relativePath) => !fs.existsSync(path.join(crateRoot, relativePath)));
    expect(missing).toEqual([]);

    const libSource = fs.readFileSync(path.join(crateRoot, 'lib.rs'), 'utf8');
    const engineSource = fs.readFileSync(path.join(crateRoot, 'hub_pipeline_lib/engine.rs'), 'utf8');
    expect(libSource).toContain('mod hub_pipeline_lib;');
    expect(libSource).toContain('executeHubPipelineJson');
    expect(engineSource).toContain('pub struct HubPipelineEngine');
    expect(engineSource).toContain('pub fn execute_hub_pipeline_json');
    expect(engineSource).toContain('HubPipelineEffectPlan::empty()');
  });

  it('rust lib request path must call Rust req stage modules instead of TS stage shells', () => {
    const crateRoot = path.join(
      process.cwd(),
      'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src',
    );
    const engineSource = fs.readFileSync(path.join(crateRoot, 'hub_pipeline_lib/engine.rs'), 'utf8');

    expect(engineSource).toContain('parse_format_envelope');
    expect(engineSource).toContain('apply_req_inbound_semantic_lift');
    expect(engineSource).toContain('capture_req_inbound_responses_context_snapshot');
    expect(engineSource).toContain('apply_req_process_tool_governance');
    expect(engineSource).toContain('apply_route_selection');
    expect(engineSource).toContain('apply_req_outbound_context_snapshot');
    expect(engineSource).toContain('build_format_request');
    expect(engineSource).toContain('run_req_outbound_stage3_compat');
    expect(engineSource).toContain('HubPipelineStageId::ReqInboundFormatParse');
    expect(engineSource).toContain('HubPipelineStageId::ReqInboundSemanticLift');
    expect(engineSource).toContain('HubPipelineStageId::ReqInboundContextCapture');
    expect(engineSource).toContain('HubPipelineStageId::ReqProcessToolGovernance');
    expect(engineSource).toContain('HubPipelineStageId::ReqProcessRouteSelect');
    expect(engineSource).toContain('HubPipelineStageId::ReqOutboundContextMerge');
    expect(engineSource).toContain('HubPipelineStageId::ReqOutboundFormatBuild');
    expect(engineSource).toContain('HubPipelineStageId::ReqOutboundCompat');
    expect(engineSource).not.toContain('stages/req_inbound');
    expect(engineSource).not.toContain('stages/req_outbound');
  });

  it('rust lib response path must call Rust resp stage modules instead of TS stage shells', () => {
    const crateRoot = path.join(
      process.cwd(),
      'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src',
    );
    const engineSource = fs.readFileSync(path.join(crateRoot, 'hub_pipeline_lib/engine.rs'), 'utf8');

    expect(engineSource).toContain('parse_resp_format_envelope');
    expect(engineSource).toContain('govern_response');
    expect(engineSource).toContain('finalize_chat_response');
    expect(engineSource).toContain('build_client_payload_for_protocol');
    expect(engineSource).toContain('process_sse_stream');
    expect(engineSource).toContain('HubPipelineEffectKind::StreamPipe');
    expect(engineSource).toContain('HubPipelineStageId::RespInboundFormatParse');
    expect(engineSource).toContain('HubPipelineStageId::RespProcessToolGovernance');
    expect(engineSource).toContain('HubPipelineStageId::RespProcessFinalize');
    expect(engineSource).toContain('HubPipelineStageId::RespOutboundClientRemap');
    expect(engineSource).toContain('HubPipelineStageId::RespOutboundSseStream');
    expect(engineSource).not.toContain('stages/resp_inbound');
    expect(engineSource).not.toContain('stages/resp_process');
    expect(engineSource).not.toContain('stages/resp_outbound');
  });

  it('resp outbound SSE TS shell must consume Rust effect plan instead of deciding stream mode', () => {
    const filePath = path.join(
      process.cwd(),
      'sharedmodule/llmswitch-core/src/conversion/hub/pipeline/stages/resp_outbound/resp_outbound_stage2_sse_stream/index.ts',
    );
    const source = fs.readFileSync(filePath, 'utf8');

    expect(source).toContain('planSseStreamEffectWithNative');
    expect(source).toContain('effectPlan.effects');
    expect(source).not.toContain('processSseStreamWithNative');
    expect(source).not.toContain('normalizeProviderProtocolTokenWithNative');
    expect(source).not.toContain('const shouldStream');
  });

  it('provider response mainline must invoke Rust HubPipeline total entry before TS residue stages', () => {
    const filePath = path.join(
      process.cwd(),
      'sharedmodule/llmswitch-core/src/conversion/hub/response/provider-response.ts',
    );
    const source = fs.readFileSync(filePath, 'utf8');

    expect(source).toContain('executeHubPipelineWithNative');
    expect(source).toContain('shouldRunProviderResponseRustHubPipeline');
    expect(source).toContain('runProviderResponseRustHubPipeline');
    expect(source).toContain('nativeResponsePlan.effectPlan.effects');
    expect(source).toContain('__nativeResponsePlan');
    expect(source).toContain('executeProviderResponseNativeOutboundEffects');
    expect(source).toContain('runtimeStateWrite');
    expect(source).toContain('servertoolRuntimeAction');
    expect(source).toContain('executeProviderResponseNativeServertoolEffects');
    expect(source).toContain('executeProviderResponseNativeRuntimeStateEffect');
    expect(source).toContain('inspectStopGatewaySignalWithNative');
    expect(source).toContain('if (nativeResponsePlan)');
    expect(source).toContain('requireReenterPipeline');
    expect(source).not.toContain('if (options.providerInvoker || options.reenterPipeline || options.clientInjectDispatch) {\n    return false;');
    expect(source).not.toContain('runtime.clock');
    expect(source).not.toContain('runtime.webSearch');
    expect(source).not.toContain('runtime.servertool');
    expect(source).not.toContain('effectPlan.effects.length !== 1');
  });

  it('TS native wrapper must fail fast through required export gate for Rust lib total entry', () => {
    const wrapperPath = path.join(
      process.cwd(),
      'sharedmodule/llmswitch-core/src/router/virtual-router/engine-selection/native-hub-pipeline-orchestration-semantics-protocol.ts',
    );
    const requiredExportsPath = path.join(
      process.cwd(),
      'sharedmodule/llmswitch-core/src/router/virtual-router/engine-selection/native-router-hotpath-required-exports.ts',
    );
    const wrapperSource = fs.readFileSync(wrapperPath, 'utf8');
    const requiredExportsSource = fs.readFileSync(requiredExportsPath, 'utf8');

    expect(requiredExportsSource).toContain('"executeHubPipelineJson"');
    expect(wrapperSource).toContain('export function executeHubPipelineWithNative');
    expect(wrapperSource).toContain("const capability = 'executeHubPipelineJson'");
    expect(wrapperSource).toContain('failNativeRequired<HubPipelineLibOutput>');
    const functionBody = wrapperSource.slice(
      wrapperSource.indexOf('export function executeHubPipelineWithNative'),
      wrapperSource.indexOf('export function runHubPipelineOrchestrationWithNative'),
    );
    expect(functionBody).not.toContain('runHubPipelineJson');
  });

  it('req_process stage1 must not directly depend on process-level TS semantic residue', () => {
    const filePath = path.join(
      process.cwd(),
      'sharedmodule/llmswitch-core/src/conversion/hub/pipeline/stages/req_process/req_process_stage1_tool_governance/index.ts',
    );
    const source = fs.readFileSync(filePath, 'utf8');

    const findings = collectMatches(source, [
      {
        label: 'imports chat-process-heartbeat-directives',
        pattern: /chat-process-heartbeat-directives\.js/,
      },
      {
        label: 'imports chat-process-clock-runtime-bridge',
        pattern: /chat-process-clock-runtime-bridge\.js/,
      },
      {
        label: 'imports chat-process-request-sanitizer-runtime-bridge',
        pattern: /chat-process-request-sanitizer-runtime-bridge\.js/,
      },
      {
        label: 'calls applyHeartbeatDirectives',
        pattern: /\bapplyHeartbeatDirectives\s*\(/,
      },
      {
        label: 'calls applyChatProcessClockRuntimeBridge',
        pattern: /\bapplyChatProcessClockRuntimeBridge\s*\(/,
      },
      {
        label: 'calls applyChatProcessRequestSanitizerRuntimeBridge',
        pattern: /\bapplyChatProcessRequestSanitizerRuntimeBridge\s*\(/,
      },
    ]);

    expect(findings).toEqual([]);
  });

  it('resp_process stage1 must remain thin-shell and must not reintroduce TS governance sidecar mutation', () => {
    const filePath = path.join(
      process.cwd(),
      'sharedmodule/llmswitch-core/src/conversion/hub/pipeline/stages/resp_process/resp_process_stage1_tool_governance/index.ts',
    );
    const source = fs.readFileSync(filePath, 'utf8');

    const findings = collectMatches(source, [
      {
        label: 'defines attachRequestedToolNames',
        pattern: /\bfunction attachRequestedToolNames\b/,
      },
      {
        label: 'defines markTextHarvestApplied',
        pattern: /\bfunction markTextHarvestApplied\b/,
      },
      {
        label: 'writes __rcc_tool_governance sidecar',
        pattern: /__rcc_tool_governance/,
      },
    ]);

    expect(findings).toEqual([]);
  });
});
