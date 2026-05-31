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

  it('req_process stage1 TS shell must enter Rust total stage API instead of direct native helper', () => {
    const stagePath = path.join(
      process.cwd(),
      'sharedmodule/llmswitch-core/src/conversion/hub/pipeline/stages/req_process/req_process_stage1_tool_governance/index.ts',
    );
    const stageSource = fs.readFileSync(stagePath, 'utf8');

    expect(stageSource).toContain('runHubPipelineStageWithNative');
    expect(stageSource).not.toContain('applyReqProcessToolGovernanceWithNative');
    expect(stageSource).not.toContain('native-hub-pipeline-req-process-semantics');
  });

  it('hub pipeline normalize request TS shell must enter Rust total stage API instead of orchestration helper', () => {
    const normalizePath = path.join(
      process.cwd(),
      'sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-normalize-request.ts',
    );
    const source = fs.readFileSync(normalizePath, 'utf8');

    expect(source).toContain('runHubPipelineStageWithNative');
    expect(source).toContain("stage: 'normalizeRequest'");
    expect(source).not.toContain('runHubPipelineOrchestrationWithNative');
    expect(source).not.toContain('resolveNormalizedRouteShape');
    expect(source).not.toContain('buildNormalizedMetadataRecord');
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

  it('resp_process stage2 TS shell must enter Rust total stage API instead of direct finalize helpers', () => {
    const stagePath = path.join(
      process.cwd(),
      'sharedmodule/llmswitch-core/src/conversion/hub/pipeline/stages/resp_process/resp_process_stage2_finalize/index.ts',
    );
    const stageSource = fs.readFileSync(stagePath, 'utf8');

    expect(stageSource).toContain('runHubPipelineStageWithNative');
    expect(stageSource).not.toContain('finalizeRespProcessChatResponseWithNative');
    expect(stageSource).not.toContain('filterOutExecutedServerToolCallsWithNative');
    expect(stageSource).not.toContain('buildProcessedRequestFromChatResponse');
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
    expect(source).toContain('runProviderResponseRustHubPipeline');
    expect(source).toContain('nativeResponsePlan.effectPlan.effects');
    expect(source).toContain('__nativeResponsePlan');
    expect(source).toContain('executeProviderResponseNativeOutboundEffects');
    expect(source).toContain('runtimeStateWrite');
    expect(source).toContain('servertoolRuntimeAction');
    expect(source).toContain('executeProviderResponseNativeServertoolEffects');
    expect(source).toContain('executeProviderResponseNativeRuntimeStateEffect');
    expect(source).toContain('const nativeResponsePlan = runProviderResponseRustHubPipeline(nativeOptions);');
    expect(source).toContain('requireReenterPipeline');
    expect(source).not.toContain('shouldRunProviderResponseRustHubPipeline');
    expect(source).not.toContain('if (nativeResponsePlan)');
    expect(source).not.toContain('return false;');
    expect(source).not.toContain('runRespInboundStage2FormatParse');
    expect(source).not.toContain('runRespInboundStage3SemanticMap');
    expect(source).not.toContain('runRespProcessStage1ToolGovernance');
    expect(source).not.toContain('runRespProcessStage2Finalize');
    expect(source).not.toContain('runRespProcessStage3ServerToolOrchestration');
    expect(source).not.toContain('runRespOutboundStage1ClientRemap');
    expect(source).not.toContain('OpenAIChatResponseMapper');
    expect(source).not.toContain('PROVIDER_RESPONSE_REGISTRY');
    expect(source).not.toContain('hasNewGovernedServerToolCalls(');
    expect(source).not.toContain('if (options.providerInvoker || options.reenterPipeline || options.clientInjectDispatch) {\n    return false;');
    expect(source).not.toContain('runtime.clock');
    expect(source).not.toContain('runtime.webSearch');
    expect(source).not.toContain('runtime.servertool');
    expect(source).not.toContain('runtime.serverToolFollowup');
    expect(source).not.toContain('effectPlan.effects.length !== 1');
  });

  it('provider response helper must not retain TS mapper canonicalization residue', () => {
    const filePath = path.join(
      process.cwd(),
      'sharedmodule/llmswitch-core/src/conversion/hub/response/provider-response-helpers.ts',
    );
    const source = fs.readFileSync(filePath, 'utf8');

    expect(source).toContain('resolveProviderResponseContextSignals');
    expect(source).toContain('maybeCommitClockReservationFromContext');
    expect(source).not.toContain('response-mappers');
    expect(source).not.toContain('ResponseMapper');
    expect(source).not.toContain('ProviderResponsePlan');
    expect(source).not.toContain('normalizeClientPayloadToCanonicalChatCompletionOrThrow');
    expect(source).not.toContain('detectProviderResponseShapeWithNative');
    expect(source).not.toContain('isCanonicalChatCompletionPayloadWithNative');
    expect(source).not.toContain('buildStructuredProviderBusinessError');
    expect(source).not.toContain('readStructuredProviderBusinessError');
    expect(source).not.toContain('createMapper');
  });

  it('runtime source outside response-mappers must not import response mapper residue', () => {
    const sourceRoot = path.join(process.cwd(), 'sharedmodule/llmswitch-core/src');
    const findings: string[] = [];
    const visit = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          visit(fullPath);
          continue;
        }
        if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
        const relativePath = path.relative(sourceRoot, fullPath);
        if (relativePath === 'conversion/hub/response/response-mappers.ts') continue;
        const source = fs.readFileSync(fullPath, 'utf8');
        if (source.includes('response-mappers')) {
          findings.push(relativePath);
        }
      }
    };

    visit(sourceRoot);
    expect(findings).toEqual([]);
  });

  it('legacy TS response mapper file and tests must be physically removed from active graph', () => {
    const mapperPath = path.join(
      process.cwd(),
      'sharedmodule/llmswitch-core/src/conversion/hub/response/response-mappers.ts',
    );
    expect(fs.existsSync(mapperPath)).toBe(false);

    const testRoot = path.join(process.cwd(), 'tests');
    const findings: string[] = [];
    const visit = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          visit(fullPath);
          continue;
        }
        if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
        if (fullPath.endsWith(path.join('tests', 'sharedmodule', 'hub-pipeline-stage-residue-audit.spec.ts').split(path.sep).join('/'))) continue;
        const source = fs.readFileSync(fullPath, 'utf8');
        if (source.includes('response-mappers')) {
          findings.push(path.relative(testRoot, fullPath));
        }
      }
    };

    visit(testRoot);
    expect(findings).toEqual([]);
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

  it('legacy TS hub registry must be physically removed', () => {
    const registryPath = path.join(
      process.cwd(),
      'sharedmodule/llmswitch-core/src/conversion/hub/registry.ts',
    );

    expect(fs.existsSync(registryPath)).toBe(false);
  });

  it('public conversion barrels must not export legacy mapper or adapter implementations', () => {
    const conversionIndexPath = path.join(
      process.cwd(),
      'sharedmodule/llmswitch-core/src/conversion/index.ts',
    );
    const formatAdapterIndexPath = path.join(
      process.cwd(),
      'sharedmodule/llmswitch-core/src/conversion/hub/format-adapters/index.ts',
    );
    const conversionIndexSource = fs.readFileSync(conversionIndexPath, 'utf8');
    const formatAdapterIndexSource = fs.readFileSync(formatAdapterIndexPath, 'utf8');

    const findings = [
      ...collectMatches(conversionIndexSource, [
        {
          label: 'exports legacy ChatSemanticMapper',
          pattern: /ChatSemanticMapper/,
        },
        {
          label: 'exports legacy AnthropicSemanticMapper',
          pattern: /AnthropicSemanticMapper/,
        },
        {
          label: 'exports legacy ResponsesSemanticMapper',
          pattern: /ResponsesSemanticMapper/,
        },
        {
          label: 'exports legacy GeminiSemanticMapper',
          pattern: /GeminiSemanticMapper/,
        },
        {
          label: 'exports operation-table semantic mapper module',
          pattern: /operation-table\/semantic-mappers/,
        },
      ]),
      ...collectMatches(formatAdapterIndexSource, [
        {
          label: 'exports legacy ChatFormatAdapter',
          pattern: /ChatFormatAdapter/,
        },
        {
          label: 'exports legacy AnthropicFormatAdapter',
          pattern: /AnthropicFormatAdapter/,
        },
        {
          label: 'exports legacy ResponsesFormatAdapter',
          pattern: /ResponsesFormatAdapter/,
        },
        {
          label: 'exports legacy GeminiFormatAdapter',
          pattern: /GeminiFormatAdapter/,
        },
      ]),
    ];

    expect(findings).toEqual([]);
  });

  it('format-adapters public surface must only expose stage recorder glue', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'sharedmodule/llmswitch-core/src/conversion/hub/format-adapters/index.ts'),
      'utf8',
    );

    const findings = collectMatches(source, [
      { label: 'FormatAdapter interface residue', pattern: /interface\s+FormatAdapter\b/ },
      { label: 'SemanticMapper interface residue', pattern: /interface\s+SemanticMapper\b/ },
      { label: 'ChatEnvelope import residue', pattern: /ChatEnvelope/ },
      { label: 'FormatEnvelope import residue', pattern: /FormatEnvelope/ },
      { label: 'JsonObject import residue', pattern: /JsonObject/ },
    ]);

    expect(findings).toEqual([]);
    expect(source).toContain('export interface StageRecorder');
  });

  it('legacy concrete TS format adapter implementations must be physically removed', () => {
    const adapterRoot = path.join(
      process.cwd(),
      'sharedmodule/llmswitch-core/src/conversion/hub/format-adapters',
    );
    const legacyFiles = [
      'chat-format-adapter.ts',
      'anthropic-format-adapter.ts',
      'responses-format-adapter.ts',
      'gemini-format-adapter.ts',
      '__tests__/format-adapters-native.test.ts',
    ];

    const existing = legacyFiles.filter((relativePath) => fs.existsSync(path.join(adapterRoot, relativePath)));
    expect(existing).toEqual([]);
  });

  it('legacy llmswitch-core hub pipeline tests must not exercise removed TS mapper pipeline', () => {
    const legacyTestRoot = path.join(process.cwd(), 'sharedmodule/llmswitch-core/test/hub');
    const legacyFiles = [
      'anthropic-pipeline.spec.ts',
      'chat-pipeline.spec.ts',
      'gemini-pipeline.spec.ts',
      'inbound-outbound.spec.ts',
    ].filter((entry) => fs.existsSync(path.join(legacyTestRoot, entry)));

    expect(legacyFiles).toEqual([]);
  });

  it('legacy TS hub pipeline entrypoints must be physically removed from public graph', () => {
    const sourceRoot = path.join(process.cwd(), 'sharedmodule/llmswitch-core/src/conversion');
    const legacyFiles = [
      'hub/node-support.ts',
      'hub/pipelines/inbound.ts',
      'hub/pipelines/outbound.ts',
    ].filter((relativePath) => fs.existsSync(path.join(sourceRoot, relativePath)));
    const conversionIndexSource = fs.readFileSync(path.join(sourceRoot, 'index.ts'), 'utf8');
    const exportFindings = collectMatches(conversionIndexSource, [
      {
        label: 'exports legacy node-support',
        pattern: /hub\/node-support/,
      },
      {
        label: 'exports legacy inbound pipeline',
        pattern: /hub\/pipelines\/inbound/,
      },
      {
        label: 'exports legacy outbound pipeline',
        pattern: /hub\/pipelines\/outbound/,
      },
    ]);

    expect({ legacyFiles, exportFindings }).toEqual({ legacyFiles: [], exportFindings: [] });
  });

  it('legacy TS operation-table semantic mapper implementations must be physically removed', () => {
    const semanticMapperRoot = path.join(
      process.cwd(),
      'sharedmodule/llmswitch-core/src/conversion/hub/operation-table/semantic-mappers',
    );
    const existing = fs.existsSync(semanticMapperRoot)
      ? fs.readdirSync(semanticMapperRoot).filter((entry) => entry.endsWith('.ts'))
      : [];

    expect(existing).toEqual([]);
  });

  it('tests must not import removed operation-table semantic mapper implementations', () => {
    const testRoot = path.join(process.cwd(), 'tests');
    const findings: string[] = [];
    const visit = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          visit(fullPath);
          continue;
        }
        if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
        const relativePath = path.relative(testRoot, fullPath);
        if (relativePath === path.join('sharedmodule', 'hub-pipeline-stage-residue-audit.spec.ts')) continue;
        const source = fs.readFileSync(fullPath, 'utf8');
        if (source.includes('conversion/hub/operation-table/semantic-mappers') || source.includes('operation-table/semantic-mappers')) {
          findings.push(relativePath);
        }
      }
    };

    visit(testRoot);
    expect(findings).toEqual([]);
  });

  it('legacy TS operation-table runner and request semantic stage shells must be physically removed', () => {
    const sourceRoot = path.join(process.cwd(), 'sharedmodule/llmswitch-core/src');
    const testRoot = path.join(process.cwd(), 'tests');
    const legacyFiles = [
      'conversion/hub/operation-table/operation-table-runner.ts',
      'conversion/hub/pipeline/stages/req_inbound/req_inbound_stage2_semantic_map/index.ts',
      'conversion/hub/pipeline/stages/req_inbound/req_inbound_stage2_semantic_map/semantic-lift.ts',
      'conversion/hub/pipeline/stages/req_inbound/req_inbound_stage2_semantic_map/README.md',
      'conversion/hub/pipeline/stages/req_outbound/req_outbound_stage1_semantic_map/index.ts',
      'conversion/hub/pipeline/stages/req_outbound/req_outbound_stage1_semantic_map/context-merge.ts',
      'conversion/hub/pipeline/stages/req_outbound/req_outbound_stage1_semantic_map/README.md',
    ];
    const legacyTests = [
      'compat/anthropic-tool-alias-map.spec.ts',
      'sharedmodule/req-inbound-stage2-tool-shape-normalization.spec.ts',
    ];
    const existingFiles = legacyFiles.filter((relativePath) => fs.existsSync(path.join(sourceRoot, relativePath)));
    const existingTests = legacyTests.filter((relativePath) => fs.existsSync(path.join(testRoot, relativePath)));

    expect({ existingFiles, existingTests }).toEqual({ existingFiles: [], existingTests: [] });
  });

  it('bridge action pipeline wrapper must not retain TS registry fallback execution', () => {
    const filePath = path.join(process.cwd(), 'sharedmodule/llmswitch-core/src/conversion/bridge-actions.ts');
    const source = fs.readFileSync(filePath, 'utf8');
    const findings = collectMatches(source, [
      { label: 'exports TS bridge action registry registration', pattern: /export function registerBridgeAction/ },
      { label: 'keeps TS bridge action registry map', pattern: /new Map<string, BridgeAction>/ },
      { label: 'executes registered TS bridge action', pattern: /registry\.get/ },
      { label: 'swallows bridge action errors', pattern: /catch\s*\{\s*\/\/ Ignore action failures/s },
    ]);

    expect(findings).toEqual([]);
  });

  it('anthropic response bridge policy must fail fast instead of swallowing policy errors', () => {
    const filePath = path.join(
      process.cwd(),
      'sharedmodule/llmswitch-core/src/conversion/hub/response/response-runtime-anthropic-policy.ts',
    );
    const source = fs.readFileSync(filePath, 'utf8');
    const findings = [
      ...(source.includes('// ignore policy failures') ? ['swallows anthropic response policy failure'] : []),
      ...(/try\s*\{[\s\S]*runBridgeActionPipeline/.test(source) ? ['wraps bridge policy execution in broad try'] : []),
    ];

    expect(findings).toEqual([]);
  });

  it('hub request mainline must enter Rust total API without request-stage mapper hooks', () => {
    const pipelineRoot = path.join(
      process.cwd(),
      'sharedmodule/llmswitch-core/src/conversion/hub/pipeline',
    );
    const checkedFiles = [
      'hub-pipeline-execute-request-stage.ts',
      'hub-pipeline.ts',
      'hub-pipeline-runtime-execute-blocks.ts',
    ];
    const findings: string[] = [];
    for (const relativePath of checkedFiles) {
      const source = fs.readFileSync(path.join(pipelineRoot, relativePath), 'utf8');
      if (relativePath === 'hub-pipeline-execute-request-stage.ts') {
        expect(source).toContain('runHubPipelineLibWithNative');
      }
      const matches = collectMatches(source, [
        { label: 'requires request stage hooks', pattern: /requireRequestStageHooks/ },
        { label: 'passes hooks into request stage', pattern: /hooks:/ },
        { label: 'createSemanticMapper residue', pattern: /createSemanticMapper/ },
        { label: 'createFormatAdapter residue', pattern: /createFormatAdapter/ },
        { label: 'SemanticMapper type residue', pattern: /\bSemanticMapper\b/ },
        { label: 'mapper toChat call residue', pattern: /\.toChat\s*\(/ },
        { label: 'mapper fromChat call residue', pattern: /\.fromChat\s*\(/ },
      ]);
      findings.push(...matches.map((match) => `${relativePath}:${match}`));
    }

    expect(findings).toEqual([]);
  });

  it('legacy TS outbound provider payload orchestration file must be physically removed', () => {
    const filePath = path.join(
      process.cwd(),
      'sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-provider-payload-orchestration-blocks.ts',
    );

    expect(fs.existsSync(filePath)).toBe(false);
  });

  it('legacy TS request route/outbound/inbound orchestrators must be physically removed', () => {
    const pipelineRoot = path.join(
      process.cwd(),
      'sharedmodule/llmswitch-core/src/conversion/hub/pipeline',
    );
    const legacyFiles = [
      'stages/req_inbound/req_inbound_stage3_context_capture',
      'hub-pipeline-route-and-outbound.ts',
      'hub-pipeline-execute-request-stage-provider-payload.ts',
      'hub-pipeline-execute-request-stage-inbound.ts',
      'hub-pipeline-execute-request-stage-inbound-orchestration-blocks.ts',
      'hub-pipeline-execute-request-stage-inbound-semantic-blocks.ts',
      'hub-pipeline-execute-request-stage-inbound-governance-blocks.ts',
      'hub-pipeline-execute-request-stage-inbound-result-blocks.ts',
      'hub-pipeline-execute-request-stage-inbound-blocks.ts',
      'hub-pipeline-stage-hooks.ts',
      'hub-pipeline-shared-guards.ts',
    ];

    const existing = legacyFiles.filter((relativePath) => fs.existsSync(path.join(pipelineRoot, relativePath)));

    expect(existing).toEqual([]);
  });

  it('chat_process request mainline must enter Rust total API without TS route/outbound mapper orchestration', () => {
    const pipelineRoot = path.join(
      process.cwd(),
      'sharedmodule/llmswitch-core/src/conversion/hub/pipeline',
    );
    const mainlineSource = fs.readFileSync(path.join(pipelineRoot, 'hub-pipeline-execute-chat-process-entry.ts'), 'utf8');

    expect(mainlineSource).toContain('runHubPipelineLibWithNative');
    const findings = [
      ...collectMatches(mainlineSource, [
        { label: 'requires request stage hooks', pattern: /requireRequestStageHooks/ },
        { label: 'executes TS route outbound', pattern: /executeRouteAndBuildOutbound/ },
        { label: 'runs TS governance phase', pattern: /executeChatProcessGovernancePhase/ },
        { label: 'creates TS semantic mapper', pattern: /createSemanticMapper/ },
        { label: 'imports TS route outbound file', pattern: /hub-pipeline-route-and-outbound\.js/ },
      ]).map((match) => `hub-pipeline-execute-chat-process-entry.ts:${match}`),
    ];

    expect(findings).toEqual([]);
  });
});
