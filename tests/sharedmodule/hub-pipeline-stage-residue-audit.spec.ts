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

function walkFiles(dir: string, suffixes: string[], out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(fullPath, suffixes, out);
      continue;
    }
    if (entry.isFile() && suffixes.some((suffix) => entry.name.endsWith(suffix))) {
      out.push(fullPath);
    }
  }
  return out;
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
    expect(engineSource).toContain('apply_hub_req_chatprocess_03_tool_governance');
    expect(engineSource).toContain('apply_vr_route_04_selection');
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

  it('req_process stage1 TS shell must be physically removed', () => {
    const stagePath = path.join(
      process.cwd(),
      'sharedmodule/llmswitch-core/src/conversion/hub/pipeline/stages/req_process/req_process_stage1_tool_governance/index.ts',
    );

    expect(fs.existsSync(stagePath)).toBe(false);
  });

  it('hub pipeline normalize request TS shell must be physically removed', () => {
    const normalizePath = path.join(
      process.cwd(),
      'sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-normalize-request.ts',
    );

    expect(fs.existsSync(normalizePath)).toBe(false);
  });

  it('legacy TS stage native entrypoints must stay locked to known bridge shells', () => {
    const sourceRoots = [
      path.join(process.cwd(), 'sharedmodule/llmswitch-core/src'),
      path.join(process.cwd(), 'src'),
    ];
    const allowed = new Set([
      'sharedmodule/llmswitch-core/src/router/virtual-router/engine-selection/native-hub-pipeline-orchestration-semantics-protocol.d.ts',
      'sharedmodule/llmswitch-core/src/router/virtual-router/engine-selection/native-hub-pipeline-orchestration-semantics-protocol.ts',
    ]);
    const findings: string[] = [];

    for (const root of sourceRoots) {
      for (const fullPath of walkFiles(root, ['.ts', '.tsx'])) {
        const source = fs.readFileSync(fullPath, 'utf8');
        if (!source.includes('runHubPipelineStageWithNative')) continue;
        const relativePath = path.relative(process.cwd(), fullPath).split(path.sep).join('/');
        if (!allowed.has(relativePath)) findings.push(relativePath);
      }
    }

    expect(findings).toEqual([]);
  });

  it('legacy TS stage barrel must not become a tracked live import surface', () => {
    const sourceRoots = [
      path.join(process.cwd(), 'sharedmodule/llmswitch-core/src'),
      path.join(process.cwd(), 'src'),
      path.join(process.cwd(), 'tests'),
    ];
    const findings: string[] = [];

    for (const root of sourceRoots) {
      for (const fullPath of walkFiles(root, ['.ts', '.tsx', '.js', '.jsx', '.d.ts'])) {
        const relativePath = path.relative(process.cwd(), fullPath).split(path.sep).join('/');
        if (relativePath === 'tests/sharedmodule/hub-pipeline-stage-residue-audit.spec.ts') {
          continue;
        }
        if (relativePath === 'sharedmodule/llmswitch-core/src/router/virtual-router/engine-selection/native-hub-pipeline-lib.js') {
          continue;
        }
        const source = fs.readFileSync(fullPath, 'utf8');
        if (source.includes('native-hub-pipeline-lib')) findings.push(relativePath);
      }
    }

    expect(findings).toEqual([]);
  });

  it('legacy runHubPipelineStageJson required export must not gain runtime consumers', () => {
    const sourceRoots = [
      path.join(process.cwd(), 'sharedmodule/llmswitch-core/src'),
      path.join(process.cwd(), 'src'),
    ];
    const allowed = new Set([
      'sharedmodule/llmswitch-core/src/router/virtual-router/engine-selection/native-hub-pipeline-orchestration-semantics-protocol.d.ts',
      'sharedmodule/llmswitch-core/src/router/virtual-router/engine-selection/native-hub-pipeline-orchestration-semantics-protocol.js',
      'sharedmodule/llmswitch-core/src/router/virtual-router/engine-selection/native-hub-pipeline-orchestration-semantics-protocol.ts',
      'sharedmodule/llmswitch-core/src/router/virtual-router/engine-selection/native-router-hotpath-required-exports.d.ts',
      'sharedmodule/llmswitch-core/src/router/virtual-router/engine-selection/native-router-hotpath-required-exports.js',
      'sharedmodule/llmswitch-core/src/router/virtual-router/engine-selection/native-router-hotpath-required-exports.ts',
    ]);
    const findings: string[] = [];

    for (const root of sourceRoots) {
      for (const fullPath of walkFiles(root, ['.ts', '.tsx', '.js', '.jsx', '.d.ts'])) {
        const source = fs.readFileSync(fullPath, 'utf8');
        if (!source.includes('runHubPipelineStageJson')) continue;
        const relativePath = path.relative(process.cwd(), fullPath).split(path.sep).join('/');
        if (!allowed.has(relativePath)) findings.push(relativePath);
      }
    }

    expect(findings).toEqual([]);
  });

  it('legacy runHubPipelineStageJson Rust NAPI owner must stay single-export only', () => {
    const crateRoot = path.join(
      process.cwd(),
      'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src',
    );
    const ownerFilesBySymbol: Record<string, Set<string>> = {
      'js_name = "runHubPipelineStageJson"': new Set(['lib.rs']),
      'hub_pipeline_lib::run_hub_pipeline_stage_json(': new Set(['lib.rs']),
      run_hub_pipeline_stage_json: new Set([
        'hub_pipeline_lib/engine.rs',
        'hub_pipeline_lib/mod.rs',
        'lib.rs',
      ]),
    };
    const findings: string[] = [];

    for (const fullPath of walkFiles(crateRoot, ['.rs'])) {
      if (fullPath.endsWith('_tests.rs') || fullPath.endsWith(path.join('shared_tooling', 'tests.rs'))) {
        continue;
      }
      const relativePath = path.relative(crateRoot, fullPath).split(path.sep).join('/');
      const source = fs.readFileSync(fullPath, 'utf8');
      for (const [symbol, allowedFiles] of Object.entries(ownerFilesBySymbol)) {
        if (source.includes(symbol) && !allowedFiles.has(relativePath)) {
          findings.push(`${relativePath}:${symbol}`);
        }
      }
    }

    expect(findings).toEqual([]);
  });

  it('legacy runHubPipelineStageJson stage branches must stay fixed to retirement list', () => {
    const enginePath = path.join(
      process.cwd(),
      'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_lib/engine.rs',
    );
    const source = fs.readFileSync(enginePath, 'utf8');
    const stageNames = Array.from(source.matchAll(/Some\("([A-Za-z0-9]+)"\)/g)).map((match) => match[1]);
    const legacyStageNames = stageNames.filter((name) =>
      ['normalizeRequest', 'reqProcessToolGovernance', 'respProcessFinalize'].includes(name)
    );
    const branchHelpers = Array.from(source.matchAll(/return\s+(run_[a-z_]+_stage)\(raw\);/g)).map((match) => match[1]);

    expect(legacyStageNames).toEqual([
      'normalizeRequest',
      'reqProcessToolGovernance',
      'respProcessFinalize',
    ]);
    expect(branchHelpers).toEqual([
      'run_normalize_request_stage',
      'run_req_process_tool_governance_stage',
      'run_resp_process_finalize_stage',
    ]);
    expect(source).not.toContain('run_resp_outbound_pipeline_json');
    expect(source).not.toContain('run_req_process_pipeline_json');
  });

  it('legacy request-side Rust stage bridge owner pair must stay fixed', () => {
    const crateRoot = path.join(
      process.cwd(),
      'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src',
    );
    const allowedOwnerFiles = new Set([
      'hub_pipeline.rs',
      'hub_pipeline_blocks/napi_bindings.rs',
    ]);
    const symbols = [
      'run_req_inbound_pipeline',
      'run_req_inbound_pipeline_json',
      'run_req_process_pipeline',
      'run_req_process_pipeline_json',
    ];
    const findings: string[] = [];

    for (const fullPath of walkFiles(crateRoot, ['.rs'])) {
      if (fullPath.endsWith('_tests.rs') || fullPath.endsWith(path.join('shared_tooling', 'tests.rs'))) {
        continue;
      }
      const relativePath = path.relative(crateRoot, fullPath).split(path.sep).join('/');
      const source = fs.readFileSync(fullPath, 'utf8');
      for (const symbol of symbols) {
        if (new RegExp(`\\b${symbol}\\b`).test(source) && !allowedOwnerFiles.has(relativePath)) {
          findings.push(`${relativePath}:${symbol}`);
        }
      }
    }

    expect(findings).toEqual([]);
  });

  it('legacy response-side Rust stage bridge owner pair must stay fixed', () => {
    const crateRoot = path.join(
      process.cwd(),
      'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src',
    );
    const allowedOwnerFiles = new Set([
      'hub_pipeline.rs',
      'hub_pipeline_blocks/napi_bindings.rs',
    ]);
    const symbols = [
      'run_resp_outbound_pipeline',
      'run_resp_outbound_pipeline_json',
    ];
    const findings: string[] = [];

    for (const fullPath of walkFiles(crateRoot, ['.rs'])) {
      if (fullPath.endsWith('_tests.rs') || fullPath.endsWith(path.join('shared_tooling', 'tests.rs'))) {
        continue;
      }
      const relativePath = path.relative(crateRoot, fullPath).split(path.sep).join('/');
      const source = fs.readFileSync(fullPath, 'utf8');
      for (const symbol of symbols) {
        if (new RegExp(`\\b${symbol}\\b`).test(source) && !allowedOwnerFiles.has(relativePath)) {
          findings.push(`${relativePath}:${symbol}`);
        }
      }
    }

    expect(findings).toEqual([]);
  });

  it('legacy normalize-request TS block files must be physically removed', () => {
    const pipelineRoot = path.join(
      process.cwd(),
      'sharedmodule/llmswitch-core/src/conversion/hub/pipeline',
    );
    const testRoot = path.join(process.cwd(), 'tests');
    const legacyFiles = [
      'hub-pipeline-normalize-request-blocks.ts',
      'hub-pipeline-normalize-request-finalize-blocks.ts',
      'hub-pipeline-normalize-request-metadata-blocks.ts',
      'hub-pipeline-normalize-request-orchestration-blocks.ts',
      'hub-pipeline-normalize-request-result-blocks.ts',
      'hub-pipeline-normalize-request-shape-blocks.ts',
      'hub-pipeline-request-normalization-utils.ts',
      'hub-pipeline-governance-blocks.ts',
    ].filter((relativePath) => fs.existsSync(path.join(pipelineRoot, relativePath)));

    expect(legacyFiles).toEqual([]);
  });

  it('rust lib response path must call Rust resp stage modules instead of TS stage shells', () => {
    const crateRoot = path.join(
      process.cwd(),
      'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src',
    );
    const engineSource = fs.readFileSync(path.join(crateRoot, 'hub_pipeline_lib/engine.rs'), 'utf8');

    expect(engineSource).toContain('parse_resp_format_envelope');
    expect(engineSource).toContain('govern_hub_resp_chatprocess_03_response');
    expect(engineSource).toContain('finalize_hub_resp_outbound_04_client_semantic');
    expect(engineSource).toContain('build_hub_resp_outbound_04_client_payload_for_protocol');
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

  it('phase 6C forbids new direct stage calls outside typed pipeline owners', () => {
    const crateRoot = path.join(
      process.cwd(),
      'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src',
    );
    const ownerFilesBySymbol: Record<string, Set<string>> = {
      run_req_process_pipeline: new Set([
        'hub_pipeline.rs',
        'hub_pipeline_blocks/napi_bindings.rs',
      ]),
      run_resp_outbound_pipeline: new Set([
        'hub_pipeline.rs',
        'hub_pipeline_blocks/napi_bindings.rs',
      ]),
      run_resp_outbound_pipeline_json: new Set([
        'hub_pipeline.rs',
        'hub_pipeline_blocks/napi_bindings.rs',
      ]),
      apply_req_process_tool_governance: new Set([
        'hub_req_chatprocess_03_governance_boundary.rs',
        'req_process_stage1_tool_governance.rs',
        'req_process_stage1_tool_governance_blocks/orchestrator.rs',
      ]),
      apply_route_selection: new Set([
        'req_process_stage2_route_select.rs',
        'vr_route_04_selection_boundary.rs',
      ]),
      govern_response: new Set([
        'hub_resp_chatprocess_03_governance_boundary.rs',
        'resp_process_stage1_tool_governance.rs',
        'resp_process_stage1_tool_governance_blocks/orchestrator.rs',
      ]),
      finalize_chat_response: new Set([
        'hub_resp_outbound_04_finalize_boundary.rs',
        'resp_process_stage2_finalize.rs',
      ]),
      finalize_chat_response_json: new Set([
        'resp_process_stage2_finalize.rs',
      ]),
      build_client_payload_for_protocol: new Set(['hub_resp_outbound_04_client_payload_boundary.rs']),
    };
    const findings: string[] = [];

    for (const fullPath of walkFiles(crateRoot, ['.rs'])) {
      if (fullPath.endsWith('_tests.rs') || fullPath.endsWith(path.join('shared_tooling', 'tests.rs'))) {
        continue;
      }
      const relativePath = path.relative(crateRoot, fullPath).split(path.sep).join('/');
      const source = fs.readFileSync(fullPath, 'utf8');
      for (const [symbol, allowedFiles] of Object.entries(ownerFilesBySymbol)) {
        if (new RegExp(`\\b${symbol}\\b`).test(source) && !allowedFiles.has(relativePath)) {
          findings.push(`${relativePath}:${symbol}`);
        }
      }
    }

    expect(findings).toEqual([]);
  });

  it('phase 6C forbids old req_process/resp_process names in typed topology files', () => {
    const typedRoot = path.join(
      process.cwd(),
      'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_types',
    );
    const findings: string[] = [];

    for (const fullPath of walkFiles(typedRoot, ['.rs'])) {
      const relativePath = path.relative(typedRoot, fullPath).split(path.sep).join('/');
      const source = fs.readFileSync(fullPath, 'utf8');
      const matches = collectMatches(source, [
        { label: 'HubReqProcess', pattern: /HubReqProcess/ },
        { label: 'HubRespProcess', pattern: /HubRespProcess/ },
        { label: 'req_process', pattern: /req_process/ },
        { label: 'resp_process', pattern: /resp_process/ },
      ]);
      findings.push(...matches.map((match) => `${relativePath}:${match}`));
    }

    expect(findings).toEqual([]);
  });

  it('legacy resp_process stage2 and resp outbound SSE TS shells must be physically removed', () => {
    const stageRoot = path.join(
      process.cwd(),
      'sharedmodule/llmswitch-core/src/conversion/hub/pipeline/stages',
    );
    const legacyFiles = [
      'resp_process/resp_process_stage2_finalize/index.ts',
      'resp_outbound/resp_outbound_stage2_sse_stream/index.ts',
    ].filter((relativePath) => fs.existsSync(path.join(stageRoot, relativePath)));

    expect(legacyFiles).toEqual([]);
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
    expect(source).not.toContain('maybeCommitClockReservationFromContext');
    expect(source).not.toContain('ClockReservation');
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

  it('req_process stage1 legacy TS shell must not be resurrected with semantic residue', () => {
    const filePath = path.join(
      process.cwd(),
      'sharedmodule/llmswitch-core/src/conversion/hub/pipeline/stages/req_process/req_process_stage1_tool_governance/index.ts',
    );

    expect(fs.existsSync(filePath)).toBe(false);
  });

  it('legacy resp_process stage1 TS governance shell must be physically removed', () => {
    const filePath = path.join(
      process.cwd(),
      'sharedmodule/llmswitch-core/src/conversion/hub/pipeline/stages/resp_process/resp_process_stage1_tool_governance/index.ts',
    );

    expect(fs.existsSync(filePath)).toBe(false);
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

  it('legacy request stage shells covered by Rust total API must be physically removed', () => {
    const stageRoot = path.join(
      process.cwd(),
      'sharedmodule/llmswitch-core/src/conversion/hub/pipeline/stages',
    );
    const legacyFiles = [
      'req_outbound/req_outbound_stage2_format_build/index.ts',
      'req_outbound/req_outbound_stage3_compat/index.ts',
      'req_process/req_process_stage2_route_select/index.ts',
    ].filter((relativePath) => fs.existsSync(path.join(stageRoot, relativePath)));

    expect(legacyFiles).toEqual([]);
  });

  it('legacy response stage shells covered by Rust total API must be physically removed', () => {
    const stageRoot = path.join(
      process.cwd(),
      'sharedmodule/llmswitch-core/src/conversion/hub/pipeline/stages',
    );
    const legacyPaths = [
      'req_inbound/req_inbound_stage1_format_parse',
      'resp_inbound/resp_inbound_stage1_sse_decode',
      'resp_inbound/resp_inbound_stage2_format_parse',
      'resp_inbound/resp_inbound_stage3_semantic_map',
      'resp_outbound/resp_outbound_stage1_client_remap',
      'resp_outbound/resp_outbound_stage2_sse_stream',
      'resp_process/resp_process_stage1_tool_governance',
      'resp_process/resp_process_stage2_finalize',
      'resp_process/resp_process_stage3_servertool_orchestration',
    ];
    const existing = legacyPaths.filter((relativePath) => fs.existsSync(path.join(stageRoot, relativePath)));

    expect(existing).toEqual([]);
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

  it('servertool followup must not add standalone TS helper files during Rust closeout', () => {
    const legacyFiles = [
      'sharedmodule/llmswitch-core/src/servertool/followup-captured-tool-outputs.ts',
    ];
    const existingFiles = legacyFiles.filter((relativePath) => fs.existsSync(path.join(process.cwd(), relativePath)));
    const followupOriginDelta = fs.readFileSync(
      path.join(process.cwd(), 'sharedmodule/llmswitch-core/src/servertool/followup-origin-delta.ts'),
      'utf8'
    );
    const findings = collectMatches(followupOriginDelta, [
      { label: 'extracts captured tool outputs in TS', pattern: /extractCapturedToolOutputs/ },
      { label: 'extracts chat tool outputs in TS', pattern: /extractChatToolOutputs/ },
      { label: 'applies single followup delta op in TS', pattern: /applySingleDeltaOp/ },
      { label: 'rebuilds tool messages in TS', pattern: /appendToolMessagesFromToolOutputs/ },
      { label: 'mutates tool list in TS', pattern: /dropToolByFunctionName|appendToolIfMissing/ },
      { label: 'prunes pending tool calls in TS', pattern: /prunePendingToolCallsForOutputs/ },
    ]);

    expect({ existingFiles, findings }).toEqual({ existingFiles: [], findings: [] });
  });

  it('servertool followup seed must not retain TS payload or tool semantics', () => {
    const filePath = path.join(process.cwd(), 'sharedmodule/llmswitch-core/src/servertool/followup-seed.ts');
    const source = fs.readFileSync(filePath, 'utf8');
    const findings = collectMatches(source, [
      { label: 'imports non-native responses bridge conversion', pattern: /from ['"]\.\.\/conversion\/responses\/responses-openai-bridge\.js['"]/ },
      { label: 'imports clone helper for TS semantic cloning', pattern: /from ['"]\.\/server-side-tools\.js['"]/ },
      { label: 'implements responses top-level parameter extraction in TS', pattern: /function\s+extractResponsesTopLevelParameters/ },
      { label: 'mutates followup parameter object in TS', pattern: /delete\s*\([^)]*\)\.stream|delete\s*\([^)]*\)\.tool_choice/ },
      { label: 'iterates followup model precedence in TS', pattern: /record\.assignedModelId|record\.originalModelId/ },
      { label: 'checks raw responses input in TS', pattern: /rawInput|textInput/ },
      { label: 'converts responses input text to chat message in TS', pattern: /messages:\s*\[\{\s*role:\s*'user',\s*content:\s*textInput/s },
      { label: 'drops tools by function name in TS', pattern: /dropToolByFunctionName|tools\.filter\(/ },
      { label: 'calls responses bridge conversion from followup TS', pattern: /buildChatRequestFromResponses|captureResponsesContext/ },
    ]);

    expect(findings).toEqual([]);
  });

  it('servertool followup dispatch and shape guard must not coerce tool semantics in TS', () => {
    const files = [
      'sharedmodule/llmswitch-core/src/servertool/followup-shape-guard.ts',
      'src/server/runtime/http-server/executor/servertool-followup-dispatch.ts',
    ];
    const findings = files.flatMap((relativePath) => {
      const filePath = path.join(process.cwd(), relativePath);
      const source = fs.readFileSync(filePath, 'utf8');
      return collectMatches(source, [
        { label: `${relativePath}: converts chat messages to Responses input in TS`, pattern: /coerceMessageToResponsesInputItems|toResponsesInputTextItem|normalizeResponsesFollowupPayloadShape/ },
        { label: `${relativePath}: converts assistant tool_calls in TS`, pattern: /coerceAssistantToolCallsToResponsesInputItems|message\.tool_calls|type:\s*['"]function_call['"]/ },
        { label: `${relativePath}: converts tool outputs in TS`, pattern: /tool_call_id|function_call_output|call_id|seenToolOutputs/ },
        { label: `${relativePath}: silently repairs tool arguments in TS`, pattern: /parseToolCallArguments|catch\s*\{\s*return\s+['"]\{\}['"]/ },
      ]);
    });

    expect(findings).toEqual([]);
  });

  it('servertool handlers must not inject or strip tool protocol payloads in TS', () => {
    const files = [
      'sharedmodule/llmswitch-core/src/servertool/handlers/apply-patch.ts',
      'sharedmodule/llmswitch-core/src/servertool/handlers/web-search.ts',
    ];
    const findings = files.flatMap((relativePath) => {
      const filePath = path.join(process.cwd(), relativePath);
      const source = fs.readFileSync(filePath, 'utf8');
      return collectMatches(source, [
        { label: `${relativePath}: appends Responses tool_outputs in TS`, pattern: /tool_outputs\s*=|tool_outputs\s*\?/ },
        { label: `${relativePath}: emits tool_call_id in TS`, pattern: /tool_call_id\s*:/ },
        { label: `${relativePath}: scans or mutates assistant tool_calls in TS`, pattern: /messageRow\.tool_calls|delete\s+messageRow\.tool_calls|\.filter\(\(call\)/ },
      ]);
    });

    expect(findings).toEqual([]);
  });

  it('request executor must not classify tool request semantics in TS', () => {
    const filePath = path.join(
      process.cwd(),
      'src/server/runtime/http-server/executor/request-executor-request-semantics.ts',
    );
    const source = fs.readFileSync(filePath, 'utf8');
    const findings = collectMatches(source, [
      { label: 'reads tool continuation mode in TS', pattern: /toolContinuation|submit_tool_outputs/ },
      { label: 'classifies tool result followup in TS', pattern: /toolOutputs|tool_outputs|__captured_tool_results/ },
      { label: 'scans messages for tool results in TS', pattern: /message\.tool_call_id|role === ['"]tool['"]|function_call_output|tool_result|tool_message/ },
      { label: 'classifies required tool call in TS', pattern: /tool_choice|toolChoice|toolsNode|clientToolsRaw|baselineTools/ },
    ]);

    expect(findings).toEqual([]);
  });

  it('request executor response contract must not classify response tool semantics in TS', () => {
    const filePath = path.join(
      process.cwd(),
      'src/server/runtime/http-server/executor/request-executor-response-contract.ts',
    );
    const source = fs.readFileSync(filePath, 'utf8');
    const findings = collectMatches(source, [
      { label: 'checks chat tool_calls in TS', pattern: /message\?\.tool_calls|hasNonEmptyToolCalls|structured tool_calls/ },
      { label: 'checks responses function_call output in TS', pattern: /hasOutputFunctionCalls|function_call|tool_call/ },
      { label: 'checks required_action tool_calls in TS', pattern: /required_action|submit_tool_outputs|tool_calls/ },
      { label: 'checks tool-result-like response content in TS', pattern: /tool_result|function_call_output|tool_message/ },
    ]);

    expect(findings).toEqual([]);
  });

  it('server response handler must not classify response tool continuation in TS', () => {
    const filePath = path.join(process.cwd(), 'src/server/handlers/handler-response-utils.ts');
    const source = fs.readFileSync(filePath, 'utf8');
    const bodyStart = source.indexOf('function isToolCallContinuationResponse');
    expect(bodyStart).toBeGreaterThanOrEqual(0);
    const body = source.slice(bodyStart, source.indexOf('\n}', bodyStart) + 2);
    const findings = collectMatches(body, [
      { label: 'derives tool_calls finish reason in TS', pattern: /deriveFinishReason\([^)]*\)\s*===\s*['"]tool_calls['"]/ },
      { label: 'checks required_action tool_calls in TS', pattern: /required_action|submit_tool_outputs|tool_calls/ },
      { label: 'checks output function/tool calls in TS', pattern: /function_call|tool_call/ },
    ]);
    expect(body).toContain('isToolCallContinuationResponseNative(body)');
    expect(findings).toEqual([]);
  });

  it('server response handler SSE contract probe must not classify response tool semantics in TS', () => {
    const filePath = path.join(process.cwd(), 'src/server/handlers/handler-response-utils.ts');
    const source = fs.readFileSync(filePath, 'utf8');
    const bodyStart = source.indexOf('function updateContractProbeFromSseChunk');
    expect(bodyStart).toBeGreaterThanOrEqual(0);
    const bodyEnd = source.indexOf('\nfunction buildResponsesTerminalSseFramesFromProbe', bodyStart);
    expect(bodyEnd).toBeGreaterThan(bodyStart);
    const body = source.slice(bodyStart, bodyEnd);
    const findings = collectMatches(body, [
      { label: 'checks required_action in TS SSE probe', pattern: /required_action|response\.required_action/ },
      { label: 'maps output call_id in TS SSE probe', pattern: /call_id|output_item/ },
      { label: 'deduplicates output items in TS SSE probe', pattern: /alreadyExists|existingCallId|existingId/ },
    ]);
    expect(body).toContain('updateResponsesContractProbeFromSseChunkNative(chunk, contractProbe.probe)');
    expect(findings).toEqual([]);
  });

  it('server response handler terminal probe frames must be built by native', () => {
    const filePath = path.join(process.cwd(), 'src/server/handlers/handler-response-utils.ts');
    const source = fs.readFileSync(filePath, 'utf8');
    const bodyStart = source.indexOf('function buildResponsesTerminalSseFramesFromProbe');
    expect(bodyStart).toBeGreaterThanOrEqual(0);
    const nextFunction = source.indexOf('\nfunction ', bodyStart + 1);
    const body = source.slice(bodyStart, nextFunction > bodyStart ? nextFunction : undefined);
    const findings = collectMatches(body, [
      { label: 'checks required_action in TS terminal frames', pattern: /required_action|response\.required_action/ },
      { label: 'checks output in TS terminal frames', pattern: /probe\.output|hasCompletedOutput/ },
      { label: 'serializes response.done frames in TS terminal frames', pattern: /response\.done|response\.required_action/ },
    ]);
    expect(body).toContain('buildResponsesTerminalSseFramesFromProbeNative(probe, requestLabel)');
    expect(findings).toEqual([]);
  });

  it('servertool followup response block must not classify tool-bearing client payloads in TS', () => {
    const filePath = path.join(
      process.cwd(),
      'sharedmodule/llmswitch-core/src/servertool/followup-response-block.ts',
    );
    const source = fs.readFileSync(filePath, 'utf8');
    const bodyStart = source.indexOf('export function isEmptyClientResponsePayload');
    expect(bodyStart).toBeGreaterThanOrEqual(0);
    const nextExport = source.indexOf('\nexport function ', bodyStart + 1);
    const body = source.slice(bodyStart, nextExport > bodyStart ? nextExport : undefined);
    const findings = collectMatches(body, [
      { label: 'checks required_action tool_calls in TS', pattern: /required_action|submit_tool_outputs|tool_calls/ },
      { label: 'checks output function/tool calls in TS', pattern: /function_call|tool_call|tool_use/ },
      { label: 'loops response choices/output in TS', pattern: /for \(const (choice|item) of/ },
    ]);
    expect(body).toContain('isEmptyClientResponsePayloadWithNative(payload)');
    expect(findings).toEqual([]);

    const requiresActionStart = source.indexOf('export function hasRequiresActionShape');
    expect(requiresActionStart).toBeGreaterThanOrEqual(0);
    const requiresActionNextExport = source.indexOf('\nexport function ', requiresActionStart + 1);
    const requiresActionBody = source.slice(
      requiresActionStart,
      requiresActionNextExport > requiresActionStart ? requiresActionNextExport : undefined,
    );
    const requiresActionFindings = collectMatches(requiresActionBody, [
      { label: 'checks required_action tool_calls in TS', pattern: /required_action|submit_tool_outputs|tool_calls/ },
      { label: 'checks output function/tool calls in TS', pattern: /function_call|tool_call|tool_use/ },
      { label: 'loops response choices/output in TS', pattern: /for \(const (choice|item) of/ },
    ]);
    expect(requiresActionBody).toContain('isToolCallContinuationResponseWithNative(payload)');
    expect(requiresActionFindings).toEqual([]);
  });

  it('bridge snapshot recorder must not classify empty response tool semantics in TS', () => {
    const filePath = path.join(process.cwd(), 'src/modules/llmswitch/bridge/snapshot-recorder.ts');
    const source = fs.readFileSync(filePath, 'utf8');
    const bodyStart = source.indexOf('function classifyEmptyResponseSignal');
    expect(bodyStart).toBeGreaterThanOrEqual(0);
    const nextMarker = source.indexOf('\n/**', bodyStart + 1);
    const body = source.slice(bodyStart, nextMarker > bodyStart ? nextMarker : undefined);
    const findings = collectMatches(body, [
      { label: 'checks required_action tool calls in TS', pattern: /required_action|submit_tool_outputs|tool_calls/ },
      { label: 'checks output function/tool calls in TS', pattern: /function_call|tool_call|tool_use/ },
      { label: 'loops choices/output for semantic classification in TS', pattern: /for \(const item of output\)|choices\.length/ },
    ]);
    expect(body).toContain('classifyEmptyResponseSignalNative(stage, payload)');
    expect(findings).toEqual([]);
  });

  it('bridge snapshot recorder tool failures must stay a native thin wrapper', () => {
    const filePath = path.join(process.cwd(), 'src/modules/llmswitch/bridge/snapshot-recorder-tool-failures.ts');
    const source = fs.readFileSync(filePath, 'utf8');
    const bodyStart = source.indexOf('export function detectToolExecutionFailures');
    expect(bodyStart).toBeGreaterThanOrEqual(0);
    const nextExport = source.indexOf('\nexport function ', bodyStart + 1);
    const body = source.slice(bodyStart, nextExport > bodyStart ? nextExport : undefined);
    const findings = collectMatches(body, [
      { label: 'collects tool messages in TS', pattern: /collectToolMessages|messages|input/ },
      { label: 'classifies tool names in TS', pattern: /exec_command|apply_patch|shell_command/ },
      { label: 'maps tool ids in TS', pattern: /tool_call_id|call_id/ },
      { label: 'deduplicates tool failures in TS', pattern: /new Set|dedup/ },
    ]);
    expect(body).toContain('detectToolExecutionFailuresNative(payload)');
    expect(findings).toEqual([]);
  });

  it('provider response shared blocks must not keep dead TS converted tool-call validators', () => {
    const filePath = path.join(
      process.cwd(),
      'src/server/runtime/http-server/executor/provider-response-shared-pure-blocks.ts',
    );
    const source = fs.readFileSync(filePath, 'utf8');
    const findings = collectMatches(source, [
      { label: 'exports TS provider tool call collector', pattern: /export function collectConvertedProviderToolCalls/ },
      { label: 'exports TS provider tool call validator', pattern: /export function collectValidatedConvertedProviderToolCallsOrThrow/ },
      { label: 'exports TS provider tool call mutator', pattern: /export function normalizeValidatedConvertedProviderToolCallsInPlace/ },
      { label: 'exports TS provider tool call validate wrapper', pattern: /export function validateConvertedProviderToolCallsOrThrow/ },
      { label: 'scans required_action tool calls for converted validation', pattern: /required_action|submit_tool_outputs\.tool_calls/ },
    ]);

    expect(findings).toEqual([]);
  });

  it('responses openai pipeline must not capture tool results in TS', () => {
    const filePath = path.join(
      process.cwd(),
      'sharedmodule/llmswitch-core/src/conversion/pipeline/codecs/v2/responses-openai-pipeline.ts',
    );
    const source = fs.readFileSync(filePath, 'utf8');
    const findings = collectMatches(source, [
      { label: 'implements response tool result capture in TS', pattern: /function\s+captureToolResults|const\s+captureToolResults|for\s*\([^)]*inputArr|itemType|toolCallId/ },
      { label: 'classifies function_call_output in TS', pattern: /\bfunction_call_output\b|\btool_result\b|\btool_message\b|\btool_use_id\b/ },
    ]);

    expect(findings).toEqual([]);
  });

  it('finish reason utility must not classify tool semantics in TS', () => {
    const filePath = path.join(process.cwd(), 'src/server/utils/finish-reason.ts');
    const source = fs.readFileSync(filePath, 'utf8');
    const findings = collectMatches(source, [
      { label: 'checks chat tool_calls in TS', pattern: /hasChatChoiceToolCalls|message\.tool_calls|toolCalls\.length/ },
      { label: 'checks responses tool calls in TS', pattern: /hasResponsesToolCall|required_action|submit_tool_outputs|function_call|tool_call/ },
      { label: 'maps provider tool stop reason in TS', pattern: /case\s+['"]tool_use['"]|return\s+['"]tool_calls['"]/ },
    ]);

    expect(findings).toEqual([]);
  });

  it('servertool orchestration blocks must not retain TS tool call/output mutation semantics', () => {
    const filePath = path.join(process.cwd(), 'sharedmodule/llmswitch-core/src/servertool/orchestration-blocks.ts');
    const source = fs.readFileSync(filePath, 'utf8');
    const findings = collectMatches(source, [
      { label: 'builds assistant tool_call message in TS', pattern: /tool_calls:\s*calls|toolCalls\.map\(/ },
      { label: 'appends tool_outputs in TS', pattern: /tool_outputs\)\.push|tool_outputs\s*=\s*outputs/ },
      { label: 'builds tool role messages from outputs in TS', pattern: /role:\s*'tool'|tool_call_id:\s*toolCallId/ },
      { label: 'strips tool_outputs in TS', pattern: /delete\s*\([^)]*\)\.tool_outputs/ },
      { label: 'patches tool call arguments in TS', pattern: /functionCall|function_call|\.arguments\s*=\s*argumentsText/ },
      { label: 'filters executed tool_calls in TS', pattern: /toolCalls\.filter\(|executedIds\.has/ },
      { label: 'swallows orchestration mutation errors', pattern: /catch\s*\{\s*\/\/ ignore\s*\}/s },
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

  it('legacy TS provider-payload and working-request block residue must be physically removed', () => {
    const pipelineRoot = path.join(
      process.cwd(),
      'sharedmodule/llmswitch-core/src/conversion/hub/pipeline',
    );
    const testRoot = path.join(process.cwd(), 'tests');
    const legacyFiles = [
      'hub-pipeline-provider-payload-finalize-blocks.ts',
      'hub-pipeline-provider-payload-observation-blocks.ts',
      'hub-pipeline-provider-payload-observation.ts',
      'hub-pipeline-provider-payload-policy-apply-blocks.ts',
      'hub-pipeline-provider-payload-policy-blocks.ts',
      'hub-pipeline-provider-payload-result-blocks.ts',
      'hub-pipeline-working-request-analysis-blocks.ts',
      'hub-pipeline-working-request-blocks.ts',
    ];
    const legacyTests = [
      'sharedmodule/hub-pipeline-provider-payload-observation.spec.ts',
    ];

    const existingFiles = legacyFiles.filter((relativePath) => fs.existsSync(path.join(pipelineRoot, relativePath)));
    const existingTests = legacyTests.filter((relativePath) => fs.existsSync(path.join(testRoot, relativePath)));

    expect({ existingFiles, existingTests }).toEqual({ existingFiles: [], existingTests: [] });
  });

  it('legacy TS adapter-context and inbound setup residue must be physically removed', () => {
    const pipelineRoot = path.join(
      process.cwd(),
      'sharedmodule/llmswitch-core/src/conversion/hub/pipeline',
    );
    const testRoot = path.join(process.cwd(), 'tests');
    const legacyFiles = [
      'hub-pipeline-adapter-context.ts',
      'hub-pipeline-adapter-context-blocks.ts',
      'hub-pipeline-adapter-context-metadata-blocks.ts',
      'hub-pipeline-adapter-context-target-blocks.ts',
      'hub-pipeline-chat-process-entry-blocks.ts',
      'hub-pipeline-execute-request-stage-inbound-setup.ts',
      'hub-pipeline-test-seams.ts',
    ];
    const legacyTests = [
      'sharedmodule/hub-pipeline-adapter-context.spec.ts',
    ];

    const existingFiles = legacyFiles.filter((relativePath) => fs.existsSync(path.join(pipelineRoot, relativePath)));
    const existingTests = legacyTests.filter((relativePath) => fs.existsSync(path.join(testRoot, relativePath)));

    expect({ existingFiles, existingTests }).toEqual({ existingFiles: [], existingTests: [] });
  });

  it('legacy TS policy/governance utility residue must be physically removed', () => {
    const pipelineRoot = path.join(
      process.cwd(),
      'sharedmodule/llmswitch-core/src/conversion/hub/pipeline',
    );
    const testRoot = path.join(process.cwd(), 'tests');
    const legacyFiles = [
      'hub-pipeline-chat-process-governance-utils.ts',
      'hub-pipeline-heavy-input-fastpath.ts',
      'hub-pipeline-max-tokens-policy.ts',
      'hub-pipeline-snapshot-recorder-blocks.ts',
    ];
    const legacyTests = [
      'sharedmodule/hub-pipeline-chat-process-governance-utils.spec.ts',
      'sharedmodule/hub-pipeline-max-tokens-policy.spec.ts',
    ];

    const existingFiles = legacyFiles.filter((relativePath) => fs.existsSync(path.join(pipelineRoot, relativePath)));
    const existingTests = legacyTests.filter((relativePath) => fs.existsSync(path.join(testRoot, relativePath)));

    expect({ existingFiles, existingTests }).toEqual({ existingFiles: [], existingTests: [] });
  });

  it('legacy TS chat-process request utility residue must be physically removed', () => {
    const pipelineRoot = path.join(
      process.cwd(),
      'sharedmodule/llmswitch-core/src/conversion/hub/pipeline',
    );
    const testRoot = path.join(process.cwd(), 'tests');
    const legacyFiles = [
      'hub-pipeline-chat-process-request-utils.ts',
      'hub-pipeline-chat-process-shared.ts',
    ];
    const legacyTests = [
      'sharedmodule/hub-pipeline-chat-process-shared.spec.ts',
    ];

    const existingFiles = legacyFiles.filter((relativePath) => fs.existsSync(path.join(pipelineRoot, relativePath)));
    const existingTests = legacyTests.filter((relativePath) => fs.existsSync(path.join(testRoot, relativePath)));

    expect({ existingFiles, existingTests }).toEqual({ existingFiles: [], existingTests: [] });
  });

  it('legacy TS HubPipeline runtime block duplicates must be physically removed', () => {
    const pipelineRoot = path.join(
      process.cwd(),
      'sharedmodule/llmswitch-core/src/conversion/hub/pipeline',
    );
    const legacyFiles = [
      'hub-pipeline-class-runtime-blocks.ts',
      'hub-pipeline-runtime-blocks.ts',
      'hub-pipeline-runtime-execute-blocks.ts',
      'hub-pipeline-runtime-hooks-blocks.ts',
    ];

    const existing = legacyFiles.filter((relativePath) => fs.existsSync(path.join(pipelineRoot, relativePath)));

    expect(existing).toEqual([]);
  });

  it('legacy TS tool-surface semantic engine must be physically removed from HubPipeline graph', () => {
    const hubRoot = path.join(process.cwd(), 'sharedmodule/llmswitch-core/src/conversion/hub');
    const legacyFiles = [
      'tool-surface/tool-surface-engine.ts',
      'tool-surface/tool-surface-convert.ts',
      'tool-surface/tool-surface-diff.ts',
    ];
    const existingFiles = legacyFiles.filter((relativePath) => fs.existsSync(path.join(hubRoot, relativePath)));

    const pipelineTypesPath = path.join(hubRoot, 'pipeline/hub-pipeline-types.ts');
    const pipelineTypesSource = fs.readFileSync(pipelineTypesPath, 'utf8');
    const findings = collectMatches(pipelineTypesSource, [
      { label: 'imports TS tool-surface engine type', pattern: /tool-surface\/tool-surface-engine/ },
    ]);

    expect({ existingFiles, findings }).toEqual({ existingFiles: [], findings: [] });
  });

  it('legacy TS virtual router tool-signal classifier must be physically removed', () => {
    const repoRoot = process.cwd();
    const legacyFiles = [
      'sharedmodule/llmswitch-core/src/router/virtual-router/tool-signals.ts',
      'tests/sharedmodule/router/virtual-router/tool-signals.spec.ts',
    ];

    const existing = legacyFiles.filter((relativePath) => fs.existsSync(path.join(repoRoot, relativePath)));

    expect(existing).toEqual([]);
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

  it('legacy runHubChatProcess API must be physically removed', () => {
    const filePath = path.join(
      process.cwd(),
      'sharedmodule/llmswitch-core/src/conversion/hub/process/chat-process.ts',
    );

    expect(fs.existsSync(filePath)).toBe(false);
  });

  it('legacy chat-process TS governance helpers must be physically removed', () => {
    const processRoot = path.join(
      process.cwd(),
      'sharedmodule/llmswitch-core/src/conversion/hub/process',
    );
    const testRoot = path.join(process.cwd(), 'tests');
    const legacyFiles = [
      'chat-process-anthropic-alias.ts',
      'chat-process-governance-orchestration.ts',
      'chat-process-request-sanitizer.ts',
      'chat-process-servertool-orchestration.ts',
      'blocks/chat-process-request-sanitizer-runtime-bridge.ts',
    ];
    const legacyTests = [
      'sharedmodule/chat-process-request-sanitizer.spec.ts',
    ];

    const existingFiles = legacyFiles.filter((relativePath) => fs.existsSync(path.join(processRoot, relativePath)));
    const existingTests = legacyTests.filter((relativePath) => fs.existsSync(path.join(testRoot, relativePath)));

    expect({ existingFiles, existingTests }).toEqual({ existingFiles: [], existingTests: [] });
  });

  it('provider runtime must not call TS tool-governor response harvest outside HubPipeline resp_process', () => {
    const providerRuntimeRoot = path.join(process.cwd(), 'src/providers/core/runtime');
    const forbiddenFiles = [
      'standard-tool-text-harvest.ts',
    ];
    const existingFiles = forbiddenFiles.filter((relativePath) => fs.existsSync(path.join(providerRuntimeRoot, relativePath)));

    const findings: string[] = [];
    const visit = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          visit(fullPath);
          continue;
        }
        if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
        const source = fs.readFileSync(fullPath, 'utf8');
        const relativePath = path.relative(providerRuntimeRoot, fullPath);
        const matches = collectMatches(source, [
          { label: 'imports conversion/shared/tool-governor', pattern: /conversion\/shared\/tool-governor/ },
          { label: 'calls processChatResponseTools', pattern: /\bprocessChatResponseTools\b/ },
          { label: 'harvests standard tool text in provider runtime', pattern: /applyStandardToolTextHarvestToChatPayload/ },
        ]);
        findings.push(...matches.map((match) => `${relativePath}:${match}`));
      }
    };
    visit(providerRuntimeRoot);

    expect({ existingFiles, findings }).toEqual({ existingFiles: [], findings: [] });
  });

  it('legacy TS tool governor public APIs must be physically removed after Rust HubPipeline takeover', () => {
    const repoRoot = process.cwd();
    const legacyFiles = [
      'sharedmodule/llmswitch-core/src/conversion/shared/tool-governor.ts',
      'sharedmodule/llmswitch-core/src/conversion/shared/tool-governor-request.ts',
      'sharedmodule/llmswitch-core/src/conversion/shared/tool-governor-response.ts',
      'sharedmodule/llmswitch-core/src/conversion/shared/tool-governor-shared.ts',
      'sharedmodule/llmswitch-core/src/conversion/shared/tool-governor-guards.ts',
      'sharedmodule/llmswitch-core/src/conversion/shared/tool-filter-pipeline.ts',
      'sharedmodule/llmswitch-core/src/conversion/hub/tool-governance/engine.ts',
      'sharedmodule/llmswitch-core/src/conversion/hub/tool-governance/index.ts',
      'sharedmodule/llmswitch-core/src/conversion/hub/tool-governance/rules.ts',
      'sharedmodule/llmswitch-core/src/conversion/hub/tool-governance/types.ts',
    ];
    const legacyTests = [
      'tests/sharedmodule/request-tool-governor-apply-patch-guidance.spec.ts',
      'tests/sharedmodule/mcp-tool-descriptions.spec.ts',
      'tests/sharedmodule/resp-process-tool-filters-exec-command-raw-shape.spec.ts',
      'tests/sharedmodule/tool-filter-image-hints.spec.ts',
      'tests/sharedmodule/tool-governor-apply-patch-failfast.spec.ts',
      'tests/sharedmodule/tool-governor-apply-patch-rewrite.spec.ts',
      'tests/sharedmodule/tool-governor-exec-command-guard.spec.ts',
      'tests/v2/src/tool-processing-test.ts',
      'tests/v2/tool-processing-test.ts',
    ];
    const existingFiles = legacyFiles.filter((relativePath) => fs.existsSync(path.join(repoRoot, relativePath)));
    const existingTests = legacyTests.filter((relativePath) => fs.existsSync(path.join(repoRoot, relativePath)));

    const conversionIndex = fs.readFileSync(
      path.join(repoRoot, 'sharedmodule/llmswitch-core/src/conversion/index.ts'),
      'utf8'
    );
    const indexFindings = collectMatches(conversionIndex, [
      { label: 'exports shared tool-governor', pattern: /shared\/tool-governor/ },
      { label: 'exports governTools TS API', pattern: /governTools/ },
    ]);

    expect({ existingFiles, existingTests, indexFindings }).toEqual({
      existingFiles: [],
      existingTests: [],
      indexFindings: [],
    });
  });

  it('legacy TS filters must not expose tool semantics after Rust HubPipeline takeover', () => {
    const filtersRoot = path.join(process.cwd(), 'sharedmodule/llmswitch-core/src/filters');
    const publicIndex = fs.readFileSync(path.join(filtersRoot, 'index.ts'), 'utf8');
    const forbiddenModules = [
      'request-tool-choice-policy',
      'request-tool-list-filter',
      'request-toolcalls-stringify',
      'request-tools-normalize',
      'response-finish-invariants',
      'response-openai-to-responses-bridge',
      'response-tool-text-canonicalize',
      'tool-filter-hooks',
      'tool-post-constraints',
      'response-tool-arguments-stringify',
      'response-tool-arguments-schema-converge',
      'response-tool-arguments-blacklist',
      'response-tool-arguments-whitelist',
    ];
    const exported = forbiddenModules.filter((name) => publicIndex.includes(name));
    const existing = forbiddenModules
      .map((name) => `special/${name}.ts`)
      .filter((relativePath) => fs.existsSync(path.join(filtersRoot, relativePath)));

    expect({ exported, existing }).toEqual({ exported: [], existing: [] });
  });
});
