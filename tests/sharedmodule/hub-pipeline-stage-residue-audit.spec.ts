import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
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

function extractFunctionBlock(source: string, functionName: string): string {
  const signature = `function ${functionName}`;
  const start = source.indexOf(signature);
  if (start < 0) {
    return '';
  }
  let parenDepth = 0;
  let paramsEnd = -1;
  for (let index = start + signature.length; index < source.length; index += 1) {
    const char = source[index];
    if (char === '(') {
      parenDepth += 1;
      continue;
    }
    if (char === ')') {
      parenDepth -= 1;
      if (parenDepth === 0) {
        paramsEnd = index;
        break;
      }
    }
  }
  if (paramsEnd < 0) {
    return '';
  }
  let typeBraceDepth = 0;
  let braceStart = -1;
  for (let index = paramsEnd + 1; index < source.length; index += 1) {
    const char = source[index];
    if (char === '{') {
      let previous = '';
      for (let scan = index - 1; scan >= paramsEnd; scan -= 1) {
        if (!/\s/.test(source[scan] ?? '')) {
          previous = source[scan] ?? '';
          break;
        }
      }
      if (typeBraceDepth === 0 && previous !== ':') {
        braceStart = index;
        break;
      }
      typeBraceDepth += 1;
      continue;
    }
    if (char === '}' && typeBraceDepth > 0) {
      typeBraceDepth -= 1;
    }
  }
  if (braceStart < 0) {
    return '';
  }
  let depth = 0;
  for (let index = braceStart; index < source.length; index += 1) {
    const char = source[index];
    if (char === '{') {
      depth += 1;
      continue;
    }
    if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return source.slice(start, index + 1);
      }
    }
  }
  return source.slice(start);
}

function walkFiles(dir: string, suffixes: string[], out: string[] = []): string[] {
  if (!fs.existsSync(dir)) {
    return out;
  }
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

  it('legacy TS stage native entrypoints must be retired from tracked source', () => {
    const sourceRoots = [
      path.join(process.cwd(), 'sharedmodule/llmswitch-core/src'),
      path.join(process.cwd(), 'src'),
    ];
    const findings: string[] = [];

    for (const root of sourceRoots) {
      for (const fullPath of walkFiles(root, ['.ts', '.tsx', '.js', '.jsx', '.d.ts'])) {
        const source = fs.readFileSync(fullPath, 'utf8');
        if (!source.includes('runHubPipelineStageWithNative')) continue;
        findings.push(path.relative(process.cwd(), fullPath).split(path.sep).join('/'));
      }
    }

    expect(findings).toEqual([]);
  });

  it('llmswitch matrix scripts must not import deleted TS stage dist wrappers', () => {
    const scriptsRoot = path.join(process.cwd(), 'sharedmodule/llmswitch-core/scripts/tests');
    const findings: string[] = [];

    for (const fullPath of walkFiles(scriptsRoot, ['.mjs', '.js'])) {
      const relativePath = path.relative(process.cwd(), fullPath).split(path.sep).join('/');
      const source = fs.readFileSync(fullPath, 'utf8');
      const matches = collectMatches(source, [
        {
          label: 'deleted dist hub stage wrapper import',
          pattern: /dist\/conversion\/hub\/pipeline\/stages/,
        },
        {
          label: 'deleted hub node-support dist owner import',
          pattern: /dist\/conversion\/hub\/node-support\.js/,
        },
        {
          label: 'legacy hub policy engine dist owner import',
          pattern: /dist\/conversion\/hub\/policy\/policy-engine\.js/,
        },
        {
          label: 'legacy hub chat-process dist owner import',
          pattern: /dist\/conversion\/hub\/process\/chat-process\.js/,
        },
        {
          label: 'legacy provider-response dist owner import',
          pattern: /dist\/conversion\/hub\/response\/provider-response\.js/,
        },
        {
          label: 'legacy gemini web-search compat dist owner import',
          pattern: /dist\/conversion\/compat\/actions\/gemini-web-search\.js/,
        },
        {
          label: 'legacy native adapter context dist owner import',
          pattern: /dist\/conversion\/hub\/pipeline\/compat\/native-adapter-context\.js/,
        },
        {
          label: 'legacy servertool followup request builder dist owner import',
          pattern: /dist\/servertool\/handlers\/followup-request-builder\.js/,
        },
        {
          label: 'legacy web-search handler direct dist owner import',
          pattern: /dist\/servertool\/handlers\/web-search\.js/,
        },
        {
          label: 'deleted virtual-router native bridge dist import',
          pattern: /dist\/router\/virtual-router\/engine-selection\/native-hub-pipeline-req-outbound-semantics\.js/,
        },
        {
          label: 'legacy conversion streaming json-to-chat-sse dist owner import',
          pattern: /dist\/conversion\/streaming\/json-to-chat-sse\.js/,
        },
        {
          label: 'legacy conversion streaming json-to-responses-sse dist owner import',
          pattern: /dist\/conversion\/streaming\/json-to-responses-sse\.js/,
        },
        {
          label: 'legacy shared responses request adapter dist import',
          pattern: /dist\/conversion\/shared\/responses-request-adapter\.js/,
        },
        {
          label: 'deleted args-mapping dist owner import',
          pattern: /dist\/conversion\/args-mapping\.js/,
        },
      ]);
      for (const match of matches) {
        findings.push(`${relativePath}:${match}`);
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
        if (relativePath === 'sharedmodule/llmswitch-core/src/native/router-hotpath/native-hub-pipeline-lib.js') {
          continue;
        }
        const source = fs.readFileSync(fullPath, 'utf8');
        if (source.includes('native-hub-pipeline-lib')) findings.push(relativePath);
      }
    }

    expect(findings).toEqual([]);
  });

  it('legacy runHubPipelineStageJson required export must be retired from tracked source', () => {
    const sourceRoots = [
      path.join(process.cwd(), 'sharedmodule/llmswitch-core/src'),
      path.join(process.cwd(), 'src'),
    ];
    const findings: string[] = [];

    for (const root of sourceRoots) {
      for (const fullPath of walkFiles(root, ['.ts', '.tsx', '.js', '.jsx', '.d.ts'])) {
        const source = fs.readFileSync(fullPath, 'utf8');
        if (!source.includes('runHubPipelineStageJson')) continue;
        findings.push(path.relative(process.cwd(), fullPath).split(path.sep).join('/'));
      }
    }

    expect(findings).toEqual([]);
  });

  it('legacy runHubPipelineStageJson Rust export and stage branches must be physically removed', () => {
    const crateRoot = path.join(
      process.cwd(),
      'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src',
    );
    const findings: string[] = [];

    for (const fullPath of walkFiles(crateRoot, ['.rs'])) {
      if (fullPath.endsWith('_tests.rs') || fullPath.endsWith(path.join('shared_tooling', 'tests.rs'))) {
        continue;
      }
      const relativePath = path.relative(crateRoot, fullPath).split(path.sep).join('/');
      const source = fs.readFileSync(fullPath, 'utf8');
      for (const symbol of [
        'js_name = "runHubPipelineStageJson"',
        'hub_pipeline_lib::run_hub_pipeline_stage_json(',
        'run_hub_pipeline_stage_json',
        'run_normalize_request_stage',
        'run_req_process_tool_governance_stage',
        'run_resp_process_finalize_stage',
      ]) {
        if (source.includes(symbol)) findings.push(`${relativePath}:${symbol}`);
      }
    }

    expect(findings).toEqual([]);
  });

  it('legacy request-side Rust stage bridge API must be physically removed', () => {
    const crateRoot = path.join(
      process.cwd(),
      'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src',
    );
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
        if (new RegExp(`\\b${symbol}\\b`).test(source)) {
          findings.push(`${relativePath}:${symbol}`);
        }
      }
    }

    expect(findings).toEqual([]);
  });

  it('legacy response-side Rust stage bridge API must be physically removed', () => {
    const crateRoot = path.join(
      process.cwd(),
      'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src',
    );
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
        if (new RegExp(`\\b${symbol}\\b`).test(source)) {
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
    expect(source).toContain('planProviderResponseServertoolRuntimeActionsWithNative');
    expect(source).toContain('executeProviderResponseNativeServertoolEffects');
    expect(source).toContain('executeProviderResponseNativeRuntimeStateEffect');
    expect(source).toContain('const nativeResponsePlan = runProviderResponseRustHubPipeline(nativeOptions);');
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
    const servertoolRuntimeActionFindings = collectMatches(source, [
      { label: 'ts-servertool-action-reenter-branch', pattern: /effect\.action\s*===\s*['"]requireReenterPipeline['"]/ },
      { label: 'ts-servertool-action-runtime-branch', pattern: /effect\.action\s*===\s*['"]requireRuntimeExecutor['"]/ },
      { label: 'ts-servertool-missing-reenter-error-owner', pattern: /SERVERTOOL_FOLLOWUP_FAILED/ },
      { label: 'ts-servertool-missing-runtime-error-owner', pattern: /SERVERTOOL_HANDLER_FAILED/ },
      { label: 'ts-servertool-unsupported-action-owner', pattern: /unsupported action/ },
      { label: 'ts-servertool-action-payload-reader', pattern: /function\s+readServertoolRuntimeActionChatPayload\s*\(/ },
    ]);
    expect(servertoolRuntimeActionFindings).toEqual([]);
  });

  it('provider response SSE marker materialization must stay Rust-owned', () => {
    const filePath = path.join(
      process.cwd(),
      'sharedmodule/llmswitch-core/src/conversion/hub/response/provider-response.ts',
    );
    const source = fs.readFileSync(filePath, 'utf8');
    const findings = collectMatches(source, [
      { label: 'exports internal provider SSE materializer', pattern: /export\s+async\s+function\s+materializeProviderResponseSsePayload\b/ },
      { label: 'ts-sse-body-text-reader', pattern: /function\s+readProviderResponseSseText\s*\(/ },
      { label: 'ts-sse-marker-classifier', pattern: /function\s+isProviderResponseSseMarker\s*\(/ },
      { label: 'ts-sse-marker-signal', pattern: /function\s+hasProviderSseMarkerSignal\s*\(/ },
      { label: 'exports zero-consumer provider response options type shell', pattern: /export\s+interface\s+ProviderResponseConversionOptions\b/ },
      { label: 'exports zero-consumer provider response result type shell', pattern: /export\s+interface\s+ProviderResponseConversionResult\b/ },
      { label: 'dead hub stage top attach helper', pattern: /function\s+attachHubStageTopToContext\s*\(/ },
      { label: 'dead hub stage top normalizer helper', pattern: /function\s+normalizeHubStageTopEntries\s*\(/ },
      { label: 'dead hub stage top merge helper', pattern: /function\s+mergeHubStageTopEntries\s*\(/ },
      { label: 'dead hub stage top local type shell', pattern: /type\s+HubStageTopEntry\s*=/ },
      { label: 'dead hub stage top peek import', pattern: /\bpeekHubStageTopSummary\b/ },
      { label: 'ts-top-level-body-text-branch', pattern: /record\.bodyText|record\.raw/ },
      { label: 'ts-nested-body-text-branch', pattern: /nested\.bodyText|nested\.raw/ },
      { label: 'ts-marker-missing-body-error-owner', pattern: /throw\s+new\s+Error\(['"]Provider SSE marker did not include materializable stream or bodyText/ },
      { label: 'ts-stream-error-terminated-classifier', pattern: /normalizedMessage\.includes\(['"]terminated['"]\)|normalizedCode\.includes\(['"]terminated['"]\)/ },
      { label: 'ts-stream-error-hardcoded-status', pattern: /wrapped\.statusCode\s*=\s*502|wrapped\.retryable\s*=\s*true|wrapped\.requestExecutorProviderErrorStage\s*=\s*['"]provider\.sse_decode['"]/ },
    ]);

    expect(source).toContain('materializeProviderResponseSsePayloadWithNative');
    expect(source).toContain('async function materializeProviderResponseSsePayload');
    expect(source).toContain('buildProviderSseStreamReadErrorDescriptorWithNative');
    expect(source).toContain('readProviderResponseSseStreamText');
    expect(source).toContain('export async function convertProviderResponse');
    expect(findings).toEqual([]);
  });

  it('provider response helper must not retain TS mapper canonicalization residue', () => {
    const filePath = path.join(
      process.cwd(),
      'sharedmodule/llmswitch-core/src/conversion/hub/response/provider-response-helpers.ts',
    );
    const source = fs.readFileSync(filePath, 'utf8');
    const findings = collectMatches(source, [
      { label: 'ts-client-facing-request-id-fallback', pattern: /:\s*context\.requestId\b/ },
      { label: 'ts-client-protocol-openai-chat-default', pattern: /:\s*['"]openai-chat['"]/ },
      { label: 'ts-client-protocol-branching-default', pattern: /resolved\.clientProtocol\s*===/ },
      { label: 'ts-display-model-trim-defaulting', pattern: /resolved\.displayModel\.trim\(\)/ },
      { label: 'exports zero-consumer client protocol type', pattern: /export\s+type\s+ClientProtocol\b/ },
      { label: 'exports zero-consumer context signals interface', pattern: /export\s+interface\s+ProviderResponseContextSignals\b/ },
    ]);

    expect(source).toContain('resolveProviderResponseContextSignals');
    expect(source).toContain('resolveProviderResponseContextHelpersWithNative');
    expect(findings).toEqual([]);
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

  it('standardized bridge must not export zero-consumer option type shells', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'sharedmodule/llmswitch-core/src/conversion/hub/standardized-bridge.ts'),
      'utf8',
    );

    const findings = collectMatches(source, [
      { label: 'exports zero-consumer chat-to-standardized options', pattern: /export\s+interface\s+ChatToStandardizedOptions\b/ },
      { label: 'exports zero-consumer standardized-to-chat options', pattern: /export\s+interface\s+StandardizedToChatOptions\b/ },
    ]);

    expect(findings).toEqual([]);
    expect(source).toContain('chatEnvelopeToStandardizedWithNative');
    expect(source).toContain('standardizedToChatEnvelopeWithNative');
  });

  it('anthropic response runtime must not restore response semantics in TS', () => {
    const filePath = path.join(
      process.cwd(),
      'sharedmodule/llmswitch-core/src/conversion/hub/response/response-runtime-anthropic.ts',
    );
    const source = fs.readFileSync(filePath, 'utf8');

    expect(source).toContain('buildOpenAIChatFromAnthropicMessageFullWithNative');
    expect(source).not.toContain('buildOpenAIChatResponseFromAnthropicMessageWithNative');
    expect(source).not.toContain('buildChatResponseFromResponsesWithNative');
    expect(source).not.toContain('includeToolCallIds');
    expect(source).not.toContain('AnthropicResponseOptions');
    expect(source).not.toContain('export interface AnthropicResponseFromChatOptions');
    expect(source).not.toContain('responses-reasoning-registry');
    expect(source).not.toContain('cloneJsonRecord');
    expect(source).not.toContain('stripInternalContinuationRequestId');
    expect(source).not.toContain('restoreResponsesSemanticsFromSnapshot');
    expect(source).not.toContain('unwrapAnthropicMessagePayload');
    expect(source).not.toContain('consumeResponsesReasoning');
    expect(source).not.toContain('consumeResponsesOutputTextMeta');
    expect(source).not.toContain('consumeResponsesPayloadSnapshotByAliases');
    expect(source).not.toContain('consumeResponsesPassthroughByAliases');
    expect(source).not.toContain('registerResponsesPayloadSnapshot');
    expect(source).not.toContain('registerResponsesPassthrough');
    expect(source).not.toContain('__responses_reasoning');
    expect(source).not.toContain('__responses_output_text_meta');
    expect(source).not.toContain('__responses_payload_snapshot');
    expect(source).not.toContain('__responses_passthrough');

    const barrel = fs.readFileSync(
      path.join(process.cwd(), 'sharedmodule/llmswitch-core/src/conversion/hub/response/response-runtime.ts'),
      'utf8',
    );
    expect(barrel).not.toContain('AnthropicResponseFromChatOptions');
  });

  it('Hub Anthropic response scripts must not restore ignored includeToolCallIds option', () => {
    const files = [
      'sharedmodule/llmswitch-core/scripts/tests/anthropic-response-regression.mjs',
      'scripts/tests/anthropic-responses-roundtrip.mjs',
    ];

    const findings = files.flatMap((relativePath) => {
      const source = fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');
      return collectMatches(source, [
        { label: `${relativePath} restores ignored includeToolCallIds option`, pattern: /includeToolCallIds/ },
      ]);
    });

    expect(findings).toEqual([]);
  });

  it('responses response utils must not own response restore semantics in TS', () => {
    const filePath = path.join(
      process.cwd(),
      'sharedmodule/llmswitch-core/src/conversion/shared/responses-response-utils.ts',
    );
    const source = fs.readFileSync(filePath, 'utf8');

    expect(source).toContain('buildChatResponseFromResponsesFullWithNative');
    expect(source).not.toContain('responses-reasoning-registry');
    expect(source).not.toContain('createBridgeActionState');
    expect(source).not.toContain('runBridgeActionPipeline');
    expect(source).not.toContain('resolveBridgePolicy');
    expect(source).not.toContain('resolvePolicyActions');
    expect(source).not.toContain('unwrapResponsesResponse');
    expect(source).not.toContain('registerPassthroughSnapshot');
    expect(source).not.toContain('cloneSnapshot');
    expect(source).not.toContain('registerResponsesPayloadSnapshot');
    expect(source).not.toContain('registerResponsesPassthrough');
    expect(source).not.toContain('buildChatResponseFromResponsesWithNative');
    expect(source).not.toContain('__responses_payload_snapshot');
  });

  it('responses retention registry wrapper must fail fast on native errors', () => {
    const filePath = path.join(
      process.cwd(),
      'sharedmodule/llmswitch-core/src/conversion/shared/responses-reasoning-registry.ts',
    );
    const source = fs.readFileSync(filePath, 'utf8');
    const findings = collectMatches(source, [
      { label: 'optional-native-call-helper', pattern: /function\s+callNative\s*\(/ },
      { label: 'native-disabled-silent-undefined', pattern: /isNativeDisabledByEnv\(\)\)\s+return undefined/ },
      { label: 'missing-native-silent-undefined', pattern: /if\s*\(!fn\)\s+return undefined/ },
      { label: 'native-throw-silent-undefined', pattern: /catch\s*\{\s*return undefined;\s*\}/ },
      { label: 'bad-json-silent-undefined', pattern: /catch\s*\{\s*return undefined;\s*\}/ },
    ]);

    expect(source).toContain('callNativeRequired');
    expect(source).toContain('failNative');
    expect(findings).toEqual([]);
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

  it('legacy virtual router dead TS helper residues must be physically removed', () => {
    const legacyWrapperDir = ['engine', 'selection'].join('-');
    const virtualRouterRoot = path.join(
      process.cwd(),
      'sharedmodule/llmswitch-core',
      'src',
      'router',
      'virtual-router',
    );
    const legacyFiles = [
      'bootstrap/auth-utils.ts',
      'bootstrap/claude-code-helpers.ts',
      'bootstrap/config-normalizers.ts',
      'bootstrap/web-search-config.ts',
      'engine/route-analytics.ts',
      'engine/routing-state/metadata.ts',
      `${legacyWrapperDir}/native-chat-process-governed-filter-semantics.ts`,
      `${legacyWrapperDir}/native-chat-process-post-governed-normalization-semantics.ts`,
      `${legacyWrapperDir}/native-chat-process-web-search-intent-semantics.ts`,
      `${legacyWrapperDir}/native-hub-pipeline-governance-semantics.ts`,
      `${legacyWrapperDir}/native-hub-pipeline-target-semantics.ts`,
      `${legacyWrapperDir}/native-virtual-router-stop-message-actions-semantics.ts`,
      `${legacyWrapperDir}/native-virtual-router-stop-message-actions-semantics.js`,
      `${legacyWrapperDir}/native-virtual-router-stop-message-actions-semantics.d.ts`,
      `${legacyWrapperDir}/native-virtual-router-stop-message-actions-semantics.js.map`,
      'token-file-scanner.ts',
    ].filter((relativePath) => fs.existsSync(path.join(virtualRouterRoot, relativePath)));

    expect(legacyFiles).toEqual([]);
  });

  it('TS native wrapper must fail fast through required export gate for Rust lib total entry', () => {
    const wrapperPath = path.join(
      process.cwd(),
      'sharedmodule/llmswitch-core/src/native/router-hotpath/native-hub-pipeline-orchestration-semantics-protocol.ts',
    );
    const requiredExportsPath = path.join(
      process.cwd(),
      'sharedmodule/llmswitch-core/src/native/router-hotpath/native-router-hotpath-required-exports.ts',
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
        {
          label: 'exports internal OpenAI chat request normalizer from conversion barrel',
          pattern: /normalizeChatRequest/,
        },
        {
          label: 'exports req inbound bridge tool native wrapper from conversion barrel',
          pattern: /mapReqInboundBridgeToolsToChatWithNative/,
        },
        {
          label: 'exports provider protocol native normalizer from conversion barrel',
          pattern: /normalizeProviderProtocolTokenWithNative/,
        },
        {
          label: 'exports anthropic alias native helper from conversion barrel',
          pattern: /buildAnthropicToolAliasMapWithNative/,
        },
        {
          label: 'exports Claude thinking compat native helper from conversion barrel',
          pattern: /applyClaudeThinkingToolSchemaCompatWithNative/,
        },
        {
          label: 'exports shared tooling helper module from conversion barrel',
          pattern: /shared\/tooling/,
        },
        {
          label: 'exports shared tool mapping helper module from conversion barrel',
          pattern: /shared\/tool-mapping/,
        },
        {
          label: 'exports guidance policy module from conversion barrel',
          pattern: /\.\.\/guidance\/index/,
        },
        {
          label: 'exports legacy conversion types from conversion barrel',
          pattern: /types\.js/,
        },
        {
          label: 'exports legacy schema validator from conversion barrel',
          pattern: /schema-validator/,
        },
        {
          label: 'exports legacy codec registry from conversion barrel',
          pattern: /codec-registry/,
        },
        {
          label: 'exports legacy protocol conversion pipeline from conversion barrel',
          pattern: /ProtocolConversionPipeline/,
        },
        {
          label: 'exports legacy protocol pipeline schema from conversion barrel',
          pattern: /pipeline\/schema/,
        },
        {
          label: 'exports legacy protocol pipeline hooks from conversion barrel',
          pattern: /pipeline\/hooks/,
        },
        {
          label: 'exports legacy protocol pipeline meta bag from conversion barrel',
          pattern: /pipeline\/meta/,
        },
        {
          label: 'exports hub standardized bridge module from conversion barrel',
          pattern: /hub\/standardized-bridge/,
        },
        {
          label: 'exports hub response runtime module from conversion barrel',
          pattern: /hub\/response\/response-runtime/,
        },
        {
          label: 'exports hub pipeline module from conversion barrel',
          pattern: /hub\/pipeline\/hub-pipeline/,
        },
        {
          label: 'exports stage recorder type from conversion barrel',
          pattern: /StageRecorder/,
        },
        {
          label: 'exports hub types barrel from conversion barrel',
          pattern: /hub\/types\/index/,
        },
        {
          label: 'exports text markup normalizer module from conversion barrel',
          pattern: /shared\/text-markup-normalizer/,
        },
        {
          label: 'exports responses openai bridge module from conversion barrel',
          pattern: /responses\/responses-openai-bridge/,
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

  it('hub json helper public surface must not restore zero-consumer array helpers', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'sharedmodule/llmswitch-core/src/conversion/hub/types/json.ts'),
      'utf8',
    );

    const findings = collectMatches(source, [
      { label: 'exports zero-consumer JsonPrimitive alias', pattern: /export\s+type\s+JsonPrimitive\b/ },
      { label: 'exports zero-consumer JsonArray alias', pattern: /export\s+type\s+JsonArray\b/ },
      { label: 'exports zero-consumer isJsonArray helper', pattern: /export\s+function\s+isJsonArray\b/ },
    ]);

    expect(findings).toEqual([]);
    expect(source).toContain('export type JsonValue');
    expect(source).toContain('export function isJsonObject');
    expect(source).toContain('export function jsonClone');
  });

  it('snapshot stage recorder must not restore TS hotpath trimming semantics', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'sharedmodule/llmswitch-core/src/conversion/hub/snapshot-recorder.ts'),
      'utf8',
    );

    const findings = collectMatches(source, [
      { label: 'restores TS snapshot hotpath trim helper', pattern: /trimSnapshotHotpathPayloadForNative/ },
      { label: 'restores TS snapshot sanitize helper', pattern: /sanitizeSnapshotHotpathPayload|pruneSnapshotHotpathPayload/ },
      { label: 'restores identity snapshot hotpath wrapper', pattern: /return\s+payload\s*;/ },
    ]);

    expect(findings).toEqual([]);
    expect(source).toContain('normalizeSnapshotStagePayloadWithNative(stage, payload)');
  });

  it('snapshot stage recorder must only expose factory bridge API', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'sharedmodule/llmswitch-core/src/conversion/hub/snapshot-recorder.ts'),
      'utf8',
    );
    const coverageScript = fs.readFileSync(
      path.join(process.cwd(), 'sharedmodule/llmswitch-core/scripts/tests/coverage-hub-snapshot-hooks-utils-recorder.mjs'),
      'utf8',
    );
    const findings = collectMatches(source, [
      { label: 'exports internal recorder options', pattern: /export\s+interface\s+SnapshotStageRecorderOptions\b/ },
      { label: 'exports internal recorder class', pattern: /export\s+class\s+SnapshotStageRecorder\b/ },
    ]);

    if (/\bnew\s+SnapshotStageRecorder\b|snapshotRecorder\.SnapshotStageRecorder\b/.test(coverageScript)) {
      findings.push('coverage script consumes internal SnapshotStageRecorder');
    }

    expect(findings).toEqual([]);
    expect(source).toContain('export function createSnapshotRecorder');
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

  it('legacy pipeline stage catalog docs must be physically removed', () => {
    const stageRoot = path.join(
      process.cwd(),
      'sharedmodule/llmswitch-core/src/conversion/hub/pipeline/stages',
    );
    const legacyDocs = [
      'README.md',
      'INTEGRATION_NOTES.md',
      'STAGE_CATALOG.md',
    ].filter((relativePath) => fs.existsSync(path.join(stageRoot, relativePath)));

    expect(legacyDocs).toEqual([]);
  });

  it('pipeline stages directory must only keep live bridge utilities', () => {
    const stageRoot = path.join(
      process.cwd(),
      'sharedmodule/llmswitch-core/src/conversion/hub/pipeline/stages',
    );
    const files = walkFiles(stageRoot, ['.ts', '.md'])
      .map((fullPath) => path.relative(stageRoot, fullPath).split(path.sep).join('/'))
      .sort();

    expect(files).toEqual(['utils.ts']);
  });

  it('legacy hub feature runtime switch must be physically removed', () => {
    const repoRoot = process.cwd();
    const deletedFiles = [
      'sharedmodule/llmswitch-core/src/conversion/hub/hub-feature.ts',
      'sharedmodule/llmswitch-core/src/conversion/hub/hub-feature.js',
      'sharedmodule/llmswitch-core/src/conversion/hub/hub-feature.d.ts',
    ].filter((relativePath) => fs.existsSync(path.join(repoRoot, relativePath)));
    const publicBarrel = fs.readFileSync(
      path.join(repoRoot, 'sharedmodule/llmswitch-core/src/conversion/index.ts'),
      'utf8',
    );

    expect(deletedFiles).toEqual([]);
    expect(publicBarrel).not.toContain('hub/hub-feature');
  });

  it('legacy Hub enable env flags must not return as runtime gates', () => {
    const roots = [
      path.join(process.cwd(), 'sharedmodule/llmswitch-core/src'),
      path.join(process.cwd(), 'src'),
    ];
    const findings: string[] = [];
    for (const root of roots) {
      for (const fullPath of walkFiles(root, ['.ts', '.tsx', '.js', '.jsx', '.d.ts'])) {
        const relativePath = path.relative(process.cwd(), fullPath).split(path.sep).join('/');
        const source = fs.readFileSync(fullPath, 'utf8');
        const forbiddenPatterns: Array<[string, RegExp]> = [
          ['ROUTECODEX_HUB_ENABLED', /ROUTECODEX_HUB_ENABLED/],
          ['ROUTECODEX_ENABLE_HUB', /ROUTECODEX_ENABLE_HUB(?!_STAGE_RECORDER)/],
          ['ROUTECODEX_HUB_PROTOCOLS', /ROUTECODEX_HUB_PROTOCOLS/],
          ['isHubProtocolEnabled', /isHubProtocolEnabled/],
        ];
        for (const [label, pattern] of forbiddenPatterns) {
          if (pattern.test(source)) findings.push(`${relativePath}:${label}`);
        }
      }
    }

    expect(findings).toEqual([]);
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

  it('scripts must not import removed operation-table mapper, concrete adapter, or tool-surface dist owners', () => {
    const repoRoot = process.cwd();
    const scriptRoots = [
      path.join(repoRoot, 'scripts'),
      path.join(repoRoot, 'sharedmodule/llmswitch-core/scripts'),
    ];
    const findings: string[] = [];
    const forbiddenPatterns: Array<[string, RegExp]> = [
      ['operation-table dist owner', /conversion\/hub\/operation-table\//],
      ['legacy hub semantic mapper dist owner', /conversion\/hub\/semantic-mappers\//],
      ['concrete format adapter dist owner', /conversion\/hub\/format-adapters\/(?:chat|responses|anthropic|gemini)-format-adapter/],
      ['tool-surface engine dist owner', /conversion\/hub\/tool-surface\/tool-surface-engine/],
      ['legacy semantic mapper class', /\b(?:Chat|Responses|Anthropic|Gemini)SemanticMapper\b/],
    ];

    for (const root of scriptRoots) {
      for (const fullPath of walkFiles(root, ['.mjs', '.js', '.ts'])) {
        const relativePath = path.relative(repoRoot, fullPath).split(path.sep).join('/');
        const source = fs.readFileSync(fullPath, 'utf8');
        for (const [label, pattern] of forbiddenPatterns) {
          if (pattern.test(source)) findings.push(`${relativePath}:${label}`);
        }
      }
    }

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
      path.join(process.cwd(), 'sharedmodule/llmswitch-core/src/servertool/backend-route-origin-delta.ts'),
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
    const filePath = path.join(process.cwd(), 'sharedmodule/llmswitch-core/src/servertool/backend-route-seed.ts');
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

  it('servertool followup dispatch and backend route shells must not coerce tool semantics in TS', () => {
    const deletedFiles = [
      'sharedmodule/llmswitch-core/src/servertool/backend-route-shape-guard.ts',
    ];
    const files = [
      'sharedmodule/llmswitch-core/src/servertool/backend-route-reenter-block.ts',
      'src/server/runtime/http-server/executor/servertool-followup-dispatch.ts',
    ];
    const existingDeletedFiles = deletedFiles.filter((relativePath) => fs.existsSync(path.join(process.cwd(), relativePath)));
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

    expect({ existingDeletedFiles, findings }).toEqual({ existingDeletedFiles: [], findings: [] });
  });

  it('servertool handlers must not inject or strip tool protocol payloads in TS', () => {
    const files = [
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

  it('server response handler must not default missing SSE finish reason to stop', () => {
    const filePath = path.join(process.cwd(), 'src/server/handlers/handler-response-utils.ts');
    const source = fs.readFileSync(filePath, 'utf8');
    const findings = collectMatches(source, [
      { label: 'defaults finishTracker finishReason to stop', pattern: /finishTracker\.finishReason\s*(?:\|\|=|=\s*finishTracker\.finishReason\s*\?\?)\s*['"]stop['"]/ },
      { label: 'defaults terminal event finish reason to stop', pattern: /effectiveTerminalEvent[\s\S]{0,160}['"]stop['"]/ },
      { label: 'defaults contract probe finish reason to stop', pattern: /contractProbe\.probe[\s\S]{0,160}['"]stop['"]/ },
    ]);

    expect(findings).toEqual([]);
  });

  it('server response handler must not inspect required_action to repair finish reason in TS', () => {
    const filePath = path.join(process.cwd(), 'src/server/handlers/handler-response-utils.ts');
    const source = fs.readFileSync(filePath, 'utf8');
    const autoCloseStart = source.indexOf('terminalAutoCloseTimer = setTimeout');
    expect(autoCloseStart).toBeGreaterThanOrEqual(0);
    const autoCloseEnd = source.indexOf("}, 120);", autoCloseStart);
    expect(autoCloseEnd).toBeGreaterThan(autoCloseStart);
    const autoCloseBody = source.slice(autoCloseStart, autoCloseEnd);
    const repairStart = source.indexOf('const repairedTerminalFrames = !terminalWatch.sawResponsesCompletedChunk');
    expect(repairStart).toBeGreaterThanOrEqual(0);
    const repairEnd = source.indexOf('void persistNativeSseConversationState', repairStart);
    expect(repairEnd).toBeGreaterThan(repairStart);
    const repairBody = source.slice(repairStart, repairEnd);
    const findings = collectMatches(`${autoCloseBody}\n${repairBody}`, [
      { label: 'checks required_action in TS finish repair', pattern: /required_action|response\.required_action|submit_tool_outputs|tool_calls/ },
    ]);

    expect(findings).toEqual([]);
  });

  it('servertool followup response block must not classify tool-bearing client payloads in TS', () => {
    const filePath = path.join(
      process.cwd(),
      'sharedmodule/llmswitch-core/src/servertool/backend-route-response-block.ts',
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

  it('provider response utils must not merge request tools with TS semantics', () => {
    const filePath = path.join(process.cwd(), 'src/server/runtime/http-server/executor/provider-response-utils.ts');
    const source = fs.readFileSync(filePath, 'utf8');
    const findings = collectMatches(source, [
      { label: 'ts-merge-unique-tools', pattern: /mergeUniqueTools/ },
      { label: 'ts-tool-name-dedupe-set', pattern: /new\s+Set<string>\s*\(\)/ },
      { label: 'ts-read-tool-function-name', pattern: /record\.function[\s\S]{0,240}fn\?\.name/ },
      { label: 'ts-client-tools-raw-merge', pattern: /clientToolsRaw\s*:\s*mergedFollowupClientToolsRaw/ },
    ]);

    expect(findings).toEqual([]);
  });

  it('legacy V2 conversion pipeline codecs must stay physically removed', () => {
    const repoRoot = process.cwd();
    const forbiddenPaths = [
      'sharedmodule/llmswitch-core/src/conversion/pipeline',
      'sharedmodule/llmswitch-core/dist/conversion/pipeline',
      'scripts/tests/anthropic-roundtrip.mjs',
      'scripts/tests/chat-pipeline-blackbox.mjs',
      'scripts/tests/chat-pipeline-regression.mjs',
      'config/chat-pipeline-blackbox.json',
      'sharedmodule/llmswitch-core/scripts/tests/openai-v1-v2-compare.mjs',
      'sharedmodule/llmswitch-core/scripts/tests/anthropic-v1-v2-compare.mjs',
      'sharedmodule/llmswitch-core/scripts/tests/responses-v1-v2-compare.mjs',
      'sharedmodule/llmswitch-core/scripts/tests/openai-tool-choice-single-source.mjs',
    ];
    const existing = forbiddenPaths.filter((relativePath) => fs.existsSync(path.join(repoRoot, relativePath)));

    expect(existing).toEqual([]);
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

  it('legacy anthropic response bridge policy TS shell must stay physically removed', () => {
    const filePath = path.join(
      process.cwd(),
      'sharedmodule/llmswitch-core/src/conversion/hub/response/response-runtime-anthropic-policy.ts',
    );

    expect(fs.existsSync(filePath)).toBe(false);
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
    const repoRoot = process.cwd();
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
      'sharedmodule/native-router-heavy-input-fastpath.spec.ts',
    ];
    const retiredFiles = [
      'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_req_inbound_unified_fastpath.rs',
      'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/chat_post_governed_normalization_semantics.rs',
      'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_tool_governance_semantics.rs',
      'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_target_utils.rs',
      'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_provider_key.rs',
      'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_stop_message_state_codec.rs',
    ];

    const existingFiles = legacyFiles.filter((relativePath) => fs.existsSync(path.join(pipelineRoot, relativePath)));
    const existingTests = legacyTests.filter((relativePath) => fs.existsSync(path.join(testRoot, relativePath)));
    const existingRetiredFiles = retiredFiles.filter((relativePath) => fs.existsSync(path.join(repoRoot, relativePath)));
    const nativeWrapper = fs.readFileSync(
      path.join(repoRoot, 'sharedmodule/llmswitch-core/src/native/router-hotpath/native-router-hotpath.ts'),
      'utf8',
    );
    const nativeAnalysis = fs.readFileSync(
      path.join(repoRoot, 'sharedmodule/llmswitch-core/src/native/router-hotpath/native-router-hotpath-analysis.ts'),
      'utf8',
    );
    const requiredExports = fs.readFileSync(
      path.join(repoRoot, 'sharedmodule/llmswitch-core/src/native/router-hotpath/native-router-hotpath-required-exports.ts'),
      'utf8',
    );
    const respToolGovernanceBindings = fs.readFileSync(
      path.join(repoRoot, 'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/resp_process_stage1_tool_governance_blocks/napi_bindings.rs'),
      'utf8',
    );
    const respToolGovernanceReexports = fs.readFileSync(
      path.join(repoRoot, 'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/resp_process_stage1_tool_governance.rs'),
      'utf8',
    );
    const hubPipelineBindings = fs.readFileSync(
      path.join(repoRoot, 'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_blocks/napi_bindings.rs'),
      'utf8',
    );
    const hubPipelineReexports = fs.readFileSync(
      path.join(repoRoot, 'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline.rs'),
      'utf8',
    );

    expect({ existingFiles, existingTests, existingRetiredFiles }).toEqual({
      existingFiles: [],
      existingTests: [],
      existingRetiredFiles: [],
    });
    for (const source of [nativeWrapper, nativeAnalysis, requiredExports]) {
      expect(source).not.toMatch(/decideHeavyInputFastpathJson|decideHeavyInputFastpath|parseDecideHeavyInputFastpathPayload/);
      expect(source).not.toMatch(/applyTargetMetadataJson|applyTargetToSubjectJson|extractTargetModelIdJson/);
      expect(source).not.toMatch(/buildImageAttachmentMetadataJson/);
      expect(source).not.toMatch(/extractWebSearchSemanticsHintJson/);
      expect(source).not.toMatch(/inferSseEventTypeFromDataJson|detectSseProtocolKindJson|validateSseEventTypeJson/);
      expect(source).not.toMatch(/normalizeReasoningInOpenAIPayloadJson/);
      expect(source).not.toMatch(/governRequestJson|governToolNameResponseJson|resolveDefaultToolGovernanceRulesJson/);
      expect(source).not.toMatch(/parseProviderKeyJson|analyzeProviderKey|parseProviderKeyPayload|ProviderKeyParsePayload/);
      expect(source).not.toMatch(/serializeStopMessageStateJson|deserializeStopMessageStateJson/);
      expect(source).not.toMatch(/cleanMalformedRoutingInstructionMarkersJson|runHashlineNativeEditJson/);
      expect(source).not.toMatch(/cleanRoutingInstructionMarkersJson|cleanRoutingInstructionMarkersWithNative/);
      expect(source).not.toMatch(
        /parseAndPreprocessRoutingInstructions|extractClearInstruction|extractStopMessageClearInstruction|applyRoutingInstructionsToStateWithNative/,
      );
    }
    for (const source of [respToolGovernanceBindings, respToolGovernanceReexports, requiredExports]) {
      expect(source).not.toMatch(/collectToolNamesFromCandidateJson|collect_tool_names_from_candidate_json/);
    }
    for (const source of [hubPipelineBindings, hubPipelineReexports, requiredExports]) {
      expect(source).not.toMatch(
        /buildPassthroughGovernanceSkippedNodeJson|resolveHasInstructionRequestedPassthroughJson|resolveActiveProcessModeJson|buildPassthroughAuditJson|annotatePassthroughGovernanceSkipJson|attachPassthroughProviderInputAuditJson|build_passthrough_governance_skipped_node_json|resolve_has_instruction_requested_passthrough_json|resolve_active_process_mode_json|build_passthrough_audit_json|annotate_passthrough_governance_skip_json|attach_passthrough_provider_input_audit_json/,
      );
    }
    const rustLib = fs.readFileSync(
      path.join(repoRoot, 'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/lib.rs'),
      'utf8',
    );
    expect(rustLib).not.toMatch(/clean_malformed_routing_instruction_markers_json|run_hashline_native_edit_json/);
    expect(rustLib).not.toMatch(/clean_routing_instruction_markers_json/);
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
      [
        'sharedmodule/llmswitch-core',
        'src',
        'router',
        'virtual-router',
        'tool-signals.ts',
      ].join('/'),
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

  it('legacy zero-consumer TS native wrapper residues must stay removed', () => {
    const repoRoot = process.cwd();
    const retiredSourceDistBases = [
      'sharedmodule/llmswitch-core/dist/conversion/adapter-context-fields',
      'sharedmodule/llmswitch-core/dist/conversion/bridge-id-utils',
      'sharedmodule/llmswitch-core/dist/conversion/bridge-metadata',
      'sharedmodule/llmswitch-core/dist/conversion/compat/actions/index',
      'sharedmodule/llmswitch-core/dist/conversion/hub/hub-feature',
      'sharedmodule/llmswitch-core/dist/conversion/hub/pipeline/session-identifiers',
      'sharedmodule/llmswitch-core/dist/conversion/jsonish',
      'sharedmodule/llmswitch-core/dist/conversion/metadata-passthrough',
      'sharedmodule/llmswitch-core/dist/conversion/payload-budget',
      'sharedmodule/llmswitch-core/dist/conversion/protocol-state',
      'sharedmodule/llmswitch-core/dist/http/sse-response',
      'sharedmodule/llmswitch-core/dist/servertool/cli-result-guard',
      'sharedmodule/llmswitch-core/dist/servertool/handlers/compaction-detect',
      'sharedmodule/llmswitch-core/dist/sse/shared/constants',
      'sharedmodule/llmswitch-core/dist/sse/shared/serializers/base-serializer',
      'sharedmodule/llmswitch-core/dist/sse/shared/serializers/chat-event-serializer',
      'sharedmodule/llmswitch-core/dist/sse/shared/serializers/index',
      'sharedmodule/llmswitch-core/dist/sse/shared/serializers/types',
      'sharedmodule/llmswitch-core/dist/sse/types/conversion-context',
      'sharedmodule/llmswitch-core/dist/sse/types/stream-state',
      'sharedmodule/llmswitch-core/dist/sse/types/utility-types',
      'sharedmodule/llmswitch-core/dist/tools/apply-patch/json/parse-loose',
      'sharedmodule/llmswitch-core/dist/tools/apply-patch/patch-text/fuzzy-match',
      'sharedmodule/llmswitch-core/dist/tools/apply-patch/regression-capturer',
      'sharedmodule/llmswitch-core/dist/tools/apply-patch/validation/shared',
      'sharedmodule/llmswitch-core/dist/tools/exec-command/regression-capturer',
      'sharedmodule/llmswitch-core/dist/tools/regression-capture',
      'sharedmodule/llmswitch-core/dist/tools/tool-description-utils',
    ].flatMap((base) => [`${base}.js`, `${base}.d.ts`, `${base}.js.map`]);
    const forbiddenFiles = [
      ...retiredSourceDistBases,
      'sharedmodule/llmswitch-core/src/conversion/adapter-context-fields.ts',
      'sharedmodule/llmswitch-core/src/conversion/compat/actions/index.ts',
      'sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-mutable-record-utils.ts',
      'sharedmodule/llmswitch-core/src/conversion/hub/pipeline/target-utils.ts',
      'sharedmodule/llmswitch-core/src/conversion/hub/process/chat-process-governance-finalize.ts',
      'sharedmodule/llmswitch-core/src/conversion/hub/process/chat-process-web-search-intent.ts',
      'sharedmodule/llmswitch-core/src/conversion/hub/process/chat-process-web-search.ts',
      'sharedmodule/llmswitch-core/src/conversion/hub/process/chat-process-web-search-tool-schema.ts',
      'sharedmodule/llmswitch-core/src/conversion/hub/process/chat-process-generic-marker-strip.ts',
      'sharedmodule/llmswitch-core/src/conversion/hub/process/chat-process-node-result.ts',
      'sharedmodule/llmswitch-core/src/conversion/hub/process/client-inject-readiness.ts',
      'sharedmodule/llmswitch-core/src/conversion/hub/response/chat-response-utils.ts',
      'sharedmodule/llmswitch-core/src/conversion/hub/response/provider-response-observation.ts',
      'sharedmodule/llmswitch-core/src/conversion/hub/response/response-runtime-anthropic-helpers.ts',
      'sharedmodule/llmswitch-core/dist/conversion/hub/response/response-runtime-anthropic-helpers.js',
      'sharedmodule/llmswitch-core/dist/conversion/hub/response/response-runtime-anthropic-helpers.d.ts',
      'sharedmodule/llmswitch-core/src/conversion/hub/pipeline/session-identifiers.ts',
      'sharedmodule/llmswitch-core/src/conversion/shared/reasoning-utils.ts',
      'sharedmodule/llmswitch-core/dist/conversion/shared/reasoning-utils.js',
      'sharedmodule/llmswitch-core/dist/conversion/shared/reasoning-utils.d.ts',
      'sharedmodule/llmswitch-core/src/conversion/shared/reasoning-mapping.ts',
      'sharedmodule/llmswitch-core/src/conversion/shared/reasoning-normalizer.ts',
      'sharedmodule/llmswitch-core/src/conversion/shared/tool-argument-repairer.ts',
      'sharedmodule/llmswitch-core/dist/conversion/shared/tool-argument-repairer.js',
      'sharedmodule/llmswitch-core/dist/conversion/shared/tool-argument-repairer.d.ts',
      'sharedmodule/llmswitch-core/dist/conversion/shared/reasoning-mapping.js',
      'sharedmodule/llmswitch-core/dist/conversion/shared/reasoning-mapping.d.ts',
      'sharedmodule/llmswitch-core/dist/conversion/shared/reasoning-normalizer.js',
      'sharedmodule/llmswitch-core/dist/conversion/shared/reasoning-normalizer.d.ts',
      'sharedmodule/llmswitch-core/src/conversion/shared/tool-harvester.ts',
      'sharedmodule/llmswitch-core/dist/conversion/shared/tool-harvester.js',
      'sharedmodule/llmswitch-core/dist/conversion/shared/tool-harvester.d.ts',
      'sharedmodule/llmswitch-core/scripts/tests/coverage-tool-harvester.mjs',
      'sharedmodule/llmswitch-core/src/conversion/shared/streaming-text-extractor.ts',
      'sharedmodule/llmswitch-core/dist/conversion/shared/streaming-text-extractor.js',
      'sharedmodule/llmswitch-core/dist/conversion/shared/streaming-text-extractor.d.ts',
      'sharedmodule/llmswitch-core/scripts/tests/coverage-streaming-text-extractor.mjs',
      'sharedmodule/llmswitch-core/src/conversion/shared/gemini-tool-utils.ts',
      'sharedmodule/llmswitch-core/dist/conversion/shared/gemini-tool-utils.js',
      'sharedmodule/llmswitch-core/dist/conversion/shared/gemini-tool-utils.d.ts',
      'sharedmodule/llmswitch-core/scripts/tests/gemini-tool-schema-sanitize.mjs',
      'tests/sharedmodule/gemini-tool-schema-cleaning.spec.ts',
      'sharedmodule/llmswitch-core/src/servertool/handlers/compaction-detect.ts',
      'sharedmodule/llmswitch-core/src/servertool/handlers/memory/extract-responses-input.ts',
      'sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-stage-timing-measure-blocks.ts',
      'sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-stage-timing-measure-blocks.js',
      'sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-stage-timing-measure-blocks.d.ts',
      'sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-stage-timing-measure-blocks.js.map',
      'sharedmodule/llmswitch-core/src/conversion/hub/pipeline/route-aware-responses-continuation.ts',
      'sharedmodule/llmswitch-core/dist/conversion/hub/pipeline/route-aware-responses-continuation.js',
      'sharedmodule/llmswitch-core/dist/conversion/hub/pipeline/route-aware-responses-continuation.d.ts',
      'tests/sharedmodule/route-aware-responses-continuation.spec.ts',
      'sharedmodule/llmswitch-core/src/conversion/hub/ops/operations.ts',
      'sharedmodule/llmswitch-core/src/conversion/hub/tool-session-compat.ts',
      'sharedmodule/llmswitch-core/src/conversion/hub/types/chat-schema.ts',
      'sharedmodule/llmswitch-core/src/conversion/hub/types/errors.ts',
      'sharedmodule/llmswitch-core/dist/conversion/hub/types/errors.js',
      'sharedmodule/llmswitch-core/dist/conversion/hub/types/errors.d.ts',
      'sharedmodule/llmswitch-core/src/conversion/hub/types/format-envelope.ts',
      'sharedmodule/llmswitch-core/dist/conversion/hub/types/format-envelope.js',
      'sharedmodule/llmswitch-core/dist/conversion/hub/types/format-envelope.d.ts',
      'sharedmodule/llmswitch-core/src/conversion/hub/types/index.ts',
      'sharedmodule/llmswitch-core/dist/conversion/hub/types/index.js',
      'sharedmodule/llmswitch-core/dist/conversion/hub/types/index.d.ts',
      'sharedmodule/llmswitch-core/src/conversion/hub/types/node.ts',
      'sharedmodule/llmswitch-core/dist/conversion/hub/types/node.js',
      'sharedmodule/llmswitch-core/dist/conversion/hub/types/node.d.ts',
      'sharedmodule/llmswitch-core/src/native/router-hotpath/native-virtual-router-bootstrap-routing.ts',
      'sharedmodule/llmswitch-core/dist/native/router-hotpath/native-virtual-router-bootstrap-routing.js',
      'sharedmodule/llmswitch-core/dist/native/router-hotpath/native-virtual-router-bootstrap-routing.d.ts',
      'sharedmodule/llmswitch-core/src/native/router-hotpath/native-virtual-router-stop-message-state-semantics.ts',
      'sharedmodule/llmswitch-core/dist/native/router-hotpath/native-virtual-router-stop-message-state-semantics.js',
      'sharedmodule/llmswitch-core/dist/native/router-hotpath/native-virtual-router-stop-message-state-semantics.d.ts',
      'sharedmodule/llmswitch-core/src/native/router-hotpath/native-hub-pipeline-orchestration-semantics-search-resume.ts',
      'sharedmodule/llmswitch-core/dist/native/router-hotpath/native-hub-pipeline-orchestration-semantics-search-resume.js',
      'sharedmodule/llmswitch-core/dist/native/router-hotpath/native-hub-pipeline-orchestration-semantics-search-resume.d.ts',
      'sharedmodule/llmswitch-core/config/rust-migration-modules.json',
      'sharedmodule/llmswitch-core/docs/rust-migration-gates.md',
      'sharedmodule/llmswitch-core/scripts/check-shadow-coverage-gate.mjs',
      'sharedmodule/llmswitch-core/scripts/lib/rust-migration-manifest.mjs',
      'sharedmodule/llmswitch-core/scripts/promote-shadow-module.mjs',
      'sharedmodule/llmswitch-core/scripts/run-ci-coverage.mjs',
      'sharedmodule/llmswitch-core/scripts/verify-shadow-gate-all.mjs',
      'sharedmodule/llmswitch-core/src/sse/test/gemini-converter.test.ts',
      'sharedmodule/llmswitch-core/src/sse/test/responses-converter-failfast.test.ts',
      'sharedmodule/llmswitch-core/src/sse/test/anthropic-converter.test.ts',
      'sharedmodule/llmswitch-core/src/sse/test/chat-converter.test.ts',
      'sharedmodule/llmswitch-core/src/sse/test/responses-converter.test.ts',
      'sharedmodule/llmswitch-core/src/test/anthropic-tool-selection-from-chat.ts',
      'sharedmodule/llmswitch-core/src/test/anthropic-bridge-closed-loop.ts',
      'sharedmodule/llmswitch-core/src/test/anthropic-chat-request-closed-loop.ts',
      'sharedmodule/llmswitch-core/src/test/anthropic-request-closed-loop.ts',
      'sharedmodule/llmswitch-core/src/test/anthropic-snapshot-closed-loop.ts',
      'sharedmodule/llmswitch-core/src/test/anthropic-sse-closed-loop.ts',
      'sharedmodule/llmswitch-core/src/test/codex-samples-analyzer.ts',
      'sharedmodule/llmswitch-core/src/test/responses-request-closed-loop.ts',
      'sharedmodule/llmswitch-core/src/test/responses-sse-closed-loop.ts',
      'sharedmodule/llmswitch-core/src/test/stats-center.spec.ts',
      'sharedmodule/llmswitch-core/src/sse/types/conversion-context.ts',
      'sharedmodule/llmswitch-core/src/sse/types/stream-state.ts',
      'sharedmodule/llmswitch-core/src/sse/types/utility-types.ts',
      'sharedmodule/llmswitch-core/src/sse/shared/serializers/base-serializer.ts',
      'sharedmodule/llmswitch-core/src/sse/shared/serializers/chat-event-serializer.ts',
      'sharedmodule/llmswitch-core/src/sse/shared/serializers/index.ts',
      'sharedmodule/llmswitch-core/src/sse/shared/serializers/types.ts',
      'sharedmodule/llmswitch-core/src/conversion/payload-budget.ts',
      'sharedmodule/llmswitch-core/src/conversion/protocol-state.ts',
      'sharedmodule/llmswitch-core/src/conversion/shared/reasoning-tool-parser.ts',
      'sharedmodule/llmswitch-core/dist/conversion/shared/reasoning-tool-parser.js',
      'sharedmodule/llmswitch-core/dist/conversion/shared/reasoning-tool-parser.d.ts',
      'sharedmodule/llmswitch-core/src/http/sse-response.ts',
      'sharedmodule/llmswitch-core/dist/servertool/handlers/empty-reply-continue.js',
      'sharedmodule/llmswitch-core/dist/servertool/handlers/empty-reply-continue.d.ts',
      'sharedmodule/llmswitch-core/dist/servertool/handlers/memory/extract-responses-input.js',
      'sharedmodule/llmswitch-core/dist/servertool/handlers/memory/extract-responses-input.d.ts',
      'sharedmodule/llmswitch-core/dist/servertool/handlers/stop-message-auto/visible-text.js',
      'sharedmodule/llmswitch-core/dist/servertool/handlers/stop-message-auto/visible-text.d.ts',
      'sharedmodule/llmswitch-core/src/tools/regression-capture.ts',
      'sharedmodule/llmswitch-core/src/tools/apply-patch/regression-capturer.ts',
      'sharedmodule/llmswitch-core/src/tools/exec-command/regression-capturer.ts',
      'sharedmodule/llmswitch-core/src/conversion/bridge-id-utils.ts',
      'sharedmodule/llmswitch-core/src/conversion/bridge-metadata.ts',
      'sharedmodule/llmswitch-core/src/conversion/jsonish.ts',
      'sharedmodule/llmswitch-core/src/conversion/metadata-passthrough.ts',
      'sharedmodule/llmswitch-core/src/sse/shared/constants.ts',
      'sharedmodule/llmswitch-core/src/tools/apply-patch/json/parse-loose.ts',
      'sharedmodule/llmswitch-core/src/tools/apply-patch/patch-text/fuzzy-match.ts',
      'sharedmodule/llmswitch-core/src/tools/apply-patch/validation/shared.ts',
      'sharedmodule/llmswitch-core/src/tools/tool-description-utils.ts',
      'sharedmodule/llmswitch-core/scripts/tests/coverage-parse-loose-json.mjs',
      'sharedmodule/llmswitch-core/scripts/tests/coverage-reasoning-tool-parser.mjs',
      'sharedmodule/llmswitch-core/scripts/tests/response-apply-patch-loop-guard.mjs',
      'sharedmodule/llmswitch-core/scripts/tests/glm-responses-compat.mjs',
      'sharedmodule/llmswitch-core/scripts/tests/coverage-hub-req-inbound-context-capture-orchestration.mjs',
      'sharedmodule/llmswitch-core/scripts/tests/responses-shell-like-function-call-normalize.mjs',
      'sharedmodule/llmswitch-core/scripts/tests/coverage-hub-req-inbound-context-tool-snapshot.mjs',
      'sharedmodule/llmswitch-core/scripts/tests/coverage-hub-req-inbound-responses-context-snapshot.mjs',
      'sharedmodule/llmswitch-core/scripts/tests/compat-iflow-reasoning-replay-20260206.mjs',
      'sharedmodule/llmswitch-core/scripts/tests/compat-profile-auto-resolve.mjs',
      'sharedmodule/llmswitch-core/scripts/tests/hub-policy-enforce-responses.mjs',
      'sharedmodule/llmswitch-core/scripts/tests/hub-policy-enforce-openai-chat.mjs',
      'sharedmodule/llmswitch-core/scripts/tests/hub-policy-enforce-anthropic.mjs',
      'sharedmodule/llmswitch-core/scripts/tests/hub-policy-enforce-gemini.mjs',
      'sharedmodule/llmswitch-core/scripts/tests/servertool-followup-skip.mjs',
      'sharedmodule/llmswitch-core/scripts/tests/servertool-continue-execution-followup.mjs',
      'sharedmodule/llmswitch-core/scripts/tests/web-search-route-tools-clean.mjs',
      'sharedmodule/llmswitch-core/scripts/tests/servertool-followup-preserve-tools.mjs',
      'sharedmodule/llmswitch-core/scripts/tests/servertool-followup-requires-action.mjs',
      'sharedmodule/llmswitch-core/scripts/tests/web-search-backend-smoke.mjs',
      'sharedmodule/llmswitch-core/scripts/tests/servertool-followup-history-media-single-source.mjs',
      'sharedmodule/llmswitch-core/scripts/tests/coverage-hub-chat-process-entry-client-inject.mjs',
      'sharedmodule/llmswitch-core/scripts/tests/sse-converters-test.mjs',
      'sharedmodule/llmswitch-core/scripts/exp3-responses-sse-to-chat-sse.mjs',
      'sharedmodule/llmswitch-core/scripts/exp4-responses-sse-loop.mjs',
      'sharedmodule/llmswitch-core/scripts/exp2-responses-to-chat.mjs',
      'sharedmodule/llmswitch-core/scripts/tests/coverage-context-diff.mjs',
      'sharedmodule/llmswitch-core/scripts/tests/coverage-recursive-detection-guard.mjs',
      'sharedmodule/llmswitch-core/scripts/tests/p0-alignment-validation.mjs',
      'sharedmodule/llmswitch-core/scripts/tests/sse-parsers-test.mjs',
      'tests/servertool/recursive-detection-guard.spec.ts',
      'sharedmodule/llmswitch-core/docs/responses-sse-experiments.md',
      'sharedmodule/llmswitch-core/docs/SSE_PARSER_ANALYSIS_AND_INTEGRATION_PLAN.md',
      'sharedmodule/llmswitch-core/docs/SYMMETRIC_ADAPTER_ARCHITECTURE.md',
      'tests/sharedmodule/anthropic-client-remap-namespace-fallback.spec.ts',
    ];
    const existing = forbiddenFiles.filter((relativePath) => fs.existsSync(path.join(repoRoot, relativePath)));

    expect(existing).toEqual([]);
  });

  it('retired hub orchestration public NAPI wrappers must not be restored without runtime consumers', () => {
    const repoRoot = process.cwd();
    const scannedFiles = [
      'sharedmodule/llmswitch-core/src/native/router-hotpath/native-hub-pipeline-orchestration-semantics.ts',
      'sharedmodule/llmswitch-core/src/native/router-hotpath/native-hub-pipeline-orchestration-semantics-builders.ts',
      'sharedmodule/llmswitch-core/src/native/router-hotpath/native-hub-pipeline-orchestration-semantics-metadata-policy.ts',
      'sharedmodule/llmswitch-core/src/native/router-hotpath/native-hub-pipeline-orchestration-semantics-protocol.ts',
      'sharedmodule/llmswitch-core/src/native/router-hotpath/native-router-hotpath-required-exports.ts',
      'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline.rs',
      'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_blocks/napi_bindings.rs',
    ];
    const retiredSymbols = [
      'buildHubPipelineResultMetadataWithNative',
      'buildReqOutboundNodeResultWithNative',
      'buildReqInboundNodeResultWithNative',
      'buildReqInboundSkippedNodeWithNative',
      'buildCapturedChatRequestSnapshotWithNative',
      'prepareRuntimeMetadataForServertoolsWithNative',
      'applyHasImageAttachmentFlagWithNative',
      'syncSessionIdentifiersToMetadataWithNative',
      'buildToolGovernanceNodeResultWithNative',
      'resolveRouterMetadataRuntimeFlagsWithNative',
      'extractAdapterContextMetadataFieldsWithNative',
      'resolveAdapterContextMetadataSignalsWithNative',
      'resolveAdapterContextObjectCarriersWithNative',
      'resolveHubPolicyOverrideFromMetadataWithNative',
      'resolveHubShadowCompareConfigWithNative',
      'resolveHubProviderProtocolWithNative',
      'resolveHubClientProtocolWithNative',
      'resolveHubSseProtocolFromMetadataWithNative',
      'resolveOutboundStreamIntentWithNative',
      'applyOutboundStreamPreferenceWithNative',
      'isSearchRouteIdWithNative',
      'isCanonicalWebSearchToolDefinitionWithNative',
      'applyDirectBuiltinWebSearchToolWithNative',
      'liftResponsesResumeIntoSemanticsWithNative',
      'syncResponsesContextFromCanonicalMessagesWithNative',
      'readResponsesResumeFromMetadataWithNative',
      'readResponsesResumeFromRequestSemanticsWithNative',
      'buildHubPipelineResultMetadataJson',
      'buildReqOutboundNodeResultJson',
      'buildReqInboundNodeResultJson',
      'buildReqInboundSkippedNodeJson',
      'buildCapturedChatRequestSnapshotJson',
      'prepareRuntimeMetadataForServertoolsJson',
      'applyHasImageAttachmentFlagJson',
      'syncSessionIdentifiersToMetadataJson',
      'buildToolGovernanceNodeResultJson',
      'resolveRouterMetadataRuntimeFlagsJson',
      'extractAdapterContextMetadataFieldsJson',
      'resolveAdapterContextMetadataSignalsJson',
      'resolveAdapterContextObjectCarriersJson',
      'resolveHubPolicyOverrideJson',
      'resolveHubShadowCompareConfigJson',
      'resolveProviderProtocolJson',
      'resolveHubClientProtocolJson',
      'resolveSseProtocolFromMetadataJson',
      'resolveOutboundStreamIntentJson',
      'applyOutboundStreamPreferenceJson',
      'isSearchRouteIdJson',
      'isCanonicalWebSearchToolDefinitionJson',
      'applyDirectBuiltinWebSearchToolJson',
      'liftResponsesResumeIntoSemanticsJson',
      'syncResponsesContextFromCanonicalMessagesJson',
      'readResponsesResumeFromMetadataJson',
      'readResponsesResumeFromRequestSemanticsJson',
      'build_hub_pipeline_result_metadata_json',
      'build_req_outbound_node_result_json',
      'build_req_inbound_node_result_json',
      'build_req_inbound_skipped_node_json',
      'build_captured_chat_request_snapshot_json',
      'prepare_runtime_metadata_for_servertools_json',
      'apply_has_image_attachment_flag_json',
      'sync_session_identifiers_to_metadata_json',
      'build_tool_governance_node_result_json',
      'resolve_router_metadata_runtime_flags_json',
      'extract_adapter_context_metadata_fields_json',
      'resolve_adapter_context_metadata_signals_json',
      'resolve_adapter_context_object_carriers_json',
      'resolve_hub_policy_override_json',
      'resolve_hub_shadow_compare_config_json',
      'resolve_provider_protocol_json',
      'resolve_hub_client_protocol_json',
      'resolve_sse_protocol_from_metadata_json',
      'resolve_outbound_stream_intent_json',
      'apply_outbound_stream_preference_json',
      'is_search_route_id_json',
      'is_canonical_web_search_tool_definition_json',
      'apply_direct_builtin_web_search_tool_json',
      'lift_responses_resume_into_semantics_json',
      'sync_responses_context_from_canonical_messages_json',
      'read_responses_resume_from_metadata_json',
      'read_responses_resume_from_request_semantics_json',
    ];
    const findings: string[] = [];

    for (const relativePath of scannedFiles) {
      const absolutePath = path.join(repoRoot, relativePath);
      if (!fs.existsSync(absolutePath)) {
        continue;
      }
      const source = fs.readFileSync(absolutePath, 'utf8');
      for (const symbol of retiredSymbols) {
        if (source.includes(symbol)) {
          findings.push(`${relativePath}:${symbol}`);
        }
      }
    }

    expect(findings).toEqual([]);
  });

  it('retired session header helper public NAPI wrappers must stay internal to session identifier extraction', () => {
    const repoRoot = process.cwd();
    const scannedFiles = [
      'sharedmodule/llmswitch-core/src/native/router-hotpath/native-hub-pipeline-session-identifiers-semantics.ts',
      'sharedmodule/llmswitch-core/src/native/router-hotpath/native-router-hotpath-required-exports.ts',
      'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_session_identifiers.rs',
    ];
    const retiredSymbols = [
      'coerceClientHeadersWithNative',
      'findHeaderValueWithNative',
      'pickHeaderWithNative',
      'normalizeHeaderKeyWithNative',
      'coerceClientHeadersJson',
      'findHeaderValueJson',
      'pickHeaderJson',
      'normalizeHeaderKeyJson',
      'coerce_client_headers_json',
      'find_header_value_json',
      'pick_header_json',
      'normalize_header_key_json',
      'coerce_client_headers_public',
      'normalize_header_key_public',
    ];
    const findings: string[] = [];

    for (const relativePath of scannedFiles) {
      const absolutePath = path.join(repoRoot, relativePath);
      if (!fs.existsSync(absolutePath)) {
        continue;
      }
      const source = fs.readFileSync(absolutePath, 'utf8');
      for (const symbol of retiredSymbols) {
        if (source.includes(symbol)) {
          findings.push(`${relativePath}:${symbol}`);
        }
      }
    }

    expect(findings).toEqual([]);
  });

  it('retired mappable semantics public wrapper must stay private to Rust process-mode internals', () => {
    const repoRoot = process.cwd();
    const scannedFiles = [
      'sharedmodule/llmswitch-core/src/native/router-hotpath/native-hub-pipeline-orchestration-semantics.ts',
      'sharedmodule/llmswitch-core/src/native/router-hotpath/native-router-hotpath-required-exports.ts',
      'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline.rs',
      'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_blocks/napi_bindings.rs',
    ];
    const retiredSymbols = [
      'findMappableSemanticsKeysWithNative',
      'findMappableSemanticsKeysJson',
      'find_mappable_semantics_keys_json',
    ];
    const findings: string[] = [];

    for (const relativePath of scannedFiles) {
      const absolutePath = path.join(repoRoot, relativePath);
      if (!fs.existsSync(absolutePath)) {
        continue;
      }
      const source = fs.readFileSync(absolutePath, 'utf8');
      for (const symbol of retiredSymbols) {
        if (source.includes(symbol)) {
          findings.push(`${relativePath}:${symbol}`);
        }
      }
    }

    expect(findings).toEqual([]);
  });

  it('retired chat process sanitize public wrapper must stay private to Rust request governance internals', () => {
    const repoRoot = process.cwd();
    const scannedFiles = [
      'sharedmodule/llmswitch-core/src/native/router-hotpath/native-router-hotpath.ts',
      'sharedmodule/llmswitch-core/src/native/router-hotpath/native-router-hotpath-required-exports.ts',
      'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/lib.rs',
    ];
    const retiredSymbols = [
      'sanitizeChatProcessMessagesWithNative',
      'sanitizeChatProcessMessagesJson',
      'sanitize_chat_process_messages_json',
    ];
    const findings: string[] = [];

    for (const relativePath of scannedFiles) {
      const absolutePath = path.join(repoRoot, relativePath);
      if (!fs.existsSync(absolutePath)) {
        continue;
      }
      const source = fs.readFileSync(absolutePath, 'utf8');
      for (const symbol of retiredSymbols) {
        if (source.includes(symbol)) {
          findings.push(`${relativePath}:${symbol}`);
        }
      }
    }

    expect(findings).toEqual([]);
  });

  it('retired semantic mapper public wrappers and Rust modules must stay deleted', () => {
    const repoRoot = process.cwd();
    const retiredFiles = [
      'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_semantic_mapper_chat.rs',
      'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_provider_response_helpers.rs',
    ];
    const existingRetiredFiles = retiredFiles.filter((relativePath) => fs.existsSync(path.join(repoRoot, relativePath)));
    expect(existingRetiredFiles).toEqual([]);

    const scannedFiles = [
      'sharedmodule/llmswitch-core/src/native/router-hotpath/native-hub-pipeline-semantic-mappers.ts',
      'sharedmodule/llmswitch-core/src/native/router-hotpath/native-router-hotpath-required-exports.ts',
      'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/lib.rs',
      'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_submit_tool_outputs.rs',
    ];
    const retiredSymbols = [
      'mapOpenaiChatToChatWithNative',
      'mapOpenaiChatFromChatWithNative',
      'buildSubmitToolOutputsPayloadWithNative',
      'extractToolSignaturesFromPayloadWithNative',
      'hasNewGovernedServerToolCallsWithNative',
      'responsesPayloadRequiresSubmitToolOutputsWithNative',
      'mapOpenaiChatToChatJson',
      'mapOpenaiChatFromChatJson',
      'buildSubmitToolOutputsPayloadJson',
      'extractToolSignaturesFromPayloadJson',
      'hasNewGovernedServerToolCallsJson',
      'responsesPayloadRequiresSubmitToolOutputsJson',
      'hub_provider_response_helpers',
      'hub_semantic_mapper_chat',
      'map_openai_chat_to_chat_json',
      'map_openai_chat_from_chat_json',
      'build_submit_tool_outputs_payload_json',
      'extract_tool_signatures_from_payload_json',
      'has_new_governed_server_tool_calls_json',
      'responses_payload_requires_submit_tool_outputs_json',
    ];
    const findings: string[] = [];

    for (const relativePath of scannedFiles) {
      const absolutePath = path.join(repoRoot, relativePath);
      if (!fs.existsSync(absolutePath)) {
        continue;
      }
      const source = fs.readFileSync(absolutePath, 'utf8');
      for (const symbol of retiredSymbols) {
        if (source.includes(symbol)) {
          findings.push(`${relativePath}:${symbol}`);
        }
      }
    }

    expect(findings).toEqual([]);
  });

  it('retired req-process standalone public wrappers must stay internal to Rust mainline', () => {
    const repoRoot = process.cwd();
    const scannedFiles = [
      'sharedmodule/llmswitch-core/src/native/router-hotpath/native-hub-pipeline-req-process-semantics.ts',
      'sharedmodule/llmswitch-core/src/native/router-hotpath/native-router-hotpath-required-exports.ts',
      'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/req_process_stage1_tool_governance.rs',
      'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/req_process_stage1_tool_governance_blocks/orchestrator.rs',
      'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/req_process_stage2_route_select.rs',
    ];
    const retiredSymbols = [
      'applyHubOperationsWithNative',
      'applyReqProcessRouteSelectionWithNative',
      'applyHubOperationsJson',
      'applyReqProcessRouteSelectionJson',
      'apply_hub_operations_json',
      'apply_req_process_route_selection_json',
    ];
    const findings: string[] = [];

    for (const relativePath of scannedFiles) {
      const absolutePath = path.join(repoRoot, relativePath);
      if (!fs.existsSync(absolutePath)) {
        continue;
      }
      const source = fs.readFileSync(absolutePath, 'utf8');
      for (const symbol of retiredSymbols) {
        if (source.includes(symbol)) {
          findings.push(`${relativePath}:${symbol}`);
        }
      }
    }

    expect(findings).toEqual([]);
  });

  it('retired VR bootstrap and stop-message public wrappers must stay Rust-internal', () => {
    const repoRoot = process.cwd();
    const scannedFiles = [
      'sharedmodule/llmswitch-core/src/native/router-hotpath/native-virtual-router-bootstrap-providers.ts',
      'sharedmodule/llmswitch-core/src/native/router-hotpath/native-virtual-router-stop-message-semantics.ts',
      'sharedmodule/llmswitch-core/src/native/router-hotpath/native-router-hotpath-required-exports.ts',
      'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/lib.rs',
      'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_stop_message_instruction.rs',
    ];
    const retiredSymbols = [
      'bootstrapProviderProfilesWithNative',
      'bootstrapVirtualRouterProviderProfilesJson',
      'bootstrap_virtual_router_provider_profiles_json_bridge',
      'parseStopMessageInstructionWithNative',
      'StopMessageNativeParseOutput',
      'parseStopMessageInstructionJson',
      '#[napi]\npub(crate) fn parse_stop_message_instruction_json',
      '#[napi]\npub fn parse_stop_message_instruction_json',
    ];
    const findings: string[] = [];

    for (const relativePath of scannedFiles) {
      const absolutePath = path.join(repoRoot, relativePath);
      if (!fs.existsSync(absolutePath)) {
        continue;
      }
      const source = fs.readFileSync(absolutePath, 'utf8');
      for (const symbol of retiredSymbols) {
        if (source.includes(symbol)) {
          findings.push(`${relativePath}:${symbol}`);
        }
      }
    }

    expect(findings).toEqual([]);
  });

  it('retired edge-stage public wrappers must stay deleted from TS and Rust exports', () => {
    const repoRoot = process.cwd();
    const scannedFiles = [
      'sharedmodule/llmswitch-core/src/native/router-hotpath/native-hub-pipeline-edge-stage-semantics.ts',
      'sharedmodule/llmswitch-core/src/native/router-hotpath/native-router-hotpath-required-exports.ts',
      'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/lib.rs',
      'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_resp_outbound_client_semantics.rs',
      'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_resp_outbound_client_semantics_blocks/napi_bindings.rs',
      'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_req_outbound_context_merge.rs',
      'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_resp_outbound_sse_stream.rs',
      'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_req_inbound_format_parse.rs',
      'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_resp_inbound_format_parse.rs',
      'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_chat_envelope_validator.rs',
    ];
    const retiredSymbols = [
      'sanitizeChatCompletionLikeWithNative',
      'normalizeOpenaiChatReasoningOutboundWithNative',
      'stripPrivateFieldsWithNative',
      'resolveCompatProfileWithNative',
      'planSseStreamEffectWithNative',
      'parseReqInboundFormatEnvelopeWithNative',
      'parseRespInboundFormatEnvelopeWithNative',
      'validateChatEnvelopeWithNative',
      'sanitizeChatCompletionLikeJson',
      'normalizeOpenaiChatReasoningOutboundJson',
      'stripPrivateFieldsJson',
      'resolveCompatProfileJson',
      'planSseStreamEffectJson',
      'validateChatEnvelopeJson',
      '#[napi]\npub fn sanitize_chat_completion_like_json',
      '#[napi]\npub fn normalize_openai_chat_reasoning_outbound_json',
      '#[napi]\npub fn strip_private_fields_json',
      '#[napi]\npub fn resolve_compat_profile_json',
      '#[napi]\npub fn plan_sse_stream_effect_json',
      '#[napi]\npub fn validate_chat_envelope_json',
      '#[napi]\npub fn parse_format_envelope_json',
      '#[napi]\npub fn parse_resp_format_envelope_json',
    ];
    const findings: string[] = [];

    for (const relativePath of scannedFiles) {
      const absolutePath = path.join(repoRoot, relativePath);
      if (!fs.existsSync(absolutePath)) {
        continue;
      }
      const source = fs.readFileSync(absolutePath, 'utf8');
      for (const symbol of retiredSymbols) {
        if (source.includes(symbol)) {
          findings.push(`${relativePath}:${symbol}`);
        }
      }
    }

    expect(findings).toEqual([]);
  });

  it('retired SSE stats/timeout public wrappers must stay deleted from TS and Rust exports', () => {
    const repoRoot = process.cwd();
    const scannedFiles = [
      'sharedmodule/llmswitch-core/src/native/router-hotpath/native-hub-pipeline-resp-semantics-inbound-tools.ts',
      'sharedmodule/llmswitch-core/src/native/router-hotpath/native-router-hotpath-required-exports.ts',
      'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_resp_inbound_sse_decode_semantics.rs',
    ];
    const retiredSymbols = [
      'extractDecodeStatsWithNative',
      'resolveSseTimeoutOptionsWithNative',
      'extractDecodeStatsJson',
      'resolveSseTimeoutOptionsJson',
      '#[napi]\npub fn extract_decode_stats_json',
      '#[napi]\npub fn resolve_sse_timeout_options_json',
      'fn read_positive_timeout',
    ];
    const findings: string[] = [];

    for (const relativePath of scannedFiles) {
      const absolutePath = path.join(repoRoot, relativePath);
      if (!fs.existsSync(absolutePath)) {
        continue;
      }
      const source = fs.readFileSync(absolutePath, 'utf8');
      for (const symbol of retiredSymbols) {
        if (source.includes(symbol)) {
          findings.push(`${relativePath}:${symbol}`);
        }
      }
    }

    expect(findings).toEqual([]);
  });

  it('retired chat node-result public builders must stay deleted from TS and Rust exports', () => {
    const repoRoot = process.cwd();
    const scannedFiles = [
      'sharedmodule/llmswitch-core/src/native/router-hotpath/native-chat-process-node-result-semantics.ts',
      'sharedmodule/llmswitch-core/src/native/router-hotpath/native-router-hotpath-required-exports.ts',
      'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/chat_node_result_semantics.rs',
      'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_lib/engine.rs',
      'sharedmodule/llmswitch-core/scripts/tests/coverage-hub-chat-process-node-result.mjs',
    ];
    const retiredSymbols = [
      'buildChatProcessContextMetadataWithNative',
      'applyChatProcessedRequestWithNative',
      'buildChatProcessedDescriptorWithNative',
      'buildChatNodeResultMetadataWithNative',
      'buildChatNodeResultObservationWithNative',
      'buildProcessedRequestFromChatResponseWithNative',
      'restoreResponseContinuationSemanticsWithNative',
      'buildChatProcessContextMetadataJson',
      'applyChatProcessedRequestJson',
      'buildChatProcessedDescriptorJson',
      'buildChatNodeResultMetadataJson',
      'buildChatNodeResultObservationJson',
      'buildProcessedRequestFromChatResponseJson',
      'restoreResponseContinuationSemanticsJson',
      'fn build_context_metadata',
      'fn build_processed_descriptor',
      'fn build_node_result_metadata',
      'fn build_node_result_observation',
      'fn apply_chat_processed_request',
      'fn restore_response_continuation_semantics',
      'fn build_processed_request_from_chat_response',
    ];
    const findings: string[] = [];

    for (const relativePath of scannedFiles) {
      const absolutePath = path.join(repoRoot, relativePath);
      if (!fs.existsSync(absolutePath)) {
        continue;
      }
      const source = fs.readFileSync(absolutePath, 'utf8');
      for (const symbol of retiredSymbols) {
        if (source.includes(symbol)) {
          findings.push(`${relativePath}:${symbol}`);
        }
      }
    }

    expect(findings).toEqual([]);
  });

  it('retired anthropic alias public bridge must stay deleted from TS and Rust exports', () => {
    const repoRoot = process.cwd();
    const scannedFiles = [
      'sharedmodule/llmswitch-core/src/native/router-hotpath/native-chat-process-governance-semantics.ts',
      'sharedmodule/llmswitch-core/src/native/router-hotpath/native-router-hotpath-required-exports.ts',
      'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/lib.rs',
      'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/chat_anthropic_tool_alias.rs',
      'sharedmodule/llmswitch-core/scripts/tests/coverage-hub-chat-process-anthropic-alias.mjs',
    ];
    const retiredSymbols = [
      'buildAnthropicToolAliasMapWithNative',
      'buildAnthropicToolAliasMapJson',
      'mod chat_anthropic_tool_alias',
      'build_anthropic_tool_alias_map_json',
      'function parseAliasMapPayload',
    ];
    const findings: string[] = [];

    for (const relativePath of scannedFiles) {
      const absolutePath = path.join(repoRoot, relativePath);
      if (!fs.existsSync(absolutePath)) {
        continue;
      }
      const source = fs.readFileSync(absolutePath, 'utf8');
      for (const symbol of retiredSymbols) {
        if (source.includes(symbol)) {
          findings.push(`${relativePath}:${symbol}`);
        }
      }
    }

    expect(findings).toEqual([]);
  });

  it('retired request-governance public bridge must stay deleted from TS and Rust exports', () => {
    const repoRoot = process.cwd();
    const retiredFiles = [
      'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/chat_governance_context.rs',
      'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/chat_governance_finalize.rs',
      'sharedmodule/llmswitch-core/scripts/tests/coverage-hub-chat-process-governance-finalize.mjs',
    ];
    const scannedFiles = [
      'sharedmodule/llmswitch-core/src/native/router-hotpath/native-chat-process-governance-semantics.ts',
      'sharedmodule/llmswitch-core/src/native/router-hotpath/native-router-hotpath-required-exports.ts',
      'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/lib.rs',
      'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/chat_continue_execution_directive_injection.rs',
      'sharedmodule/llmswitch-core/scripts/tests/coverage-native-chat-process-governance-semantics.mjs',
      ...retiredFiles,
    ];
    const retiredSymbols = [
      'NativeGovernanceContextPayload',
      'parseGovernanceContextPayload',
      'resolveGovernanceContextWithNative',
      'applyGovernedControlOperationsWithNative',
      'applyGovernedMergeRequestWithNative',
      'mergeGovernanceSummaryIntoMetadataWithNative',
      'finalizeGovernedRequestWithNative',
      'resolveGovernanceContextJson',
      'applyGovernedControlOperationsJson',
      'applyGovernedMergeRequestJson',
      'mergeGovernanceSummaryIntoMetadataJson',
      'finalizeGovernedRequestJson',
      'mod chat_governance_context',
      'mod chat_governance_finalize',
      'resolve_governance_context_json',
      'apply_governed_control_operations_json',
      'apply_governed_merge_request_json',
      'merge_governance_summary_into_metadata_json',
      'finalize_governed_request_json',
      'fn resolve_governed_control_plan',
      'fn resolve_governed_merge_plan',
      'fn apply_governed_control_operations',
      'fn apply_governed_merge_request',
      'GovernedControlPlanOutput',
      'GovernedMergePlanOutput',
    ];
    const existingRetiredFiles = retiredFiles.filter((relativePath) => fs.existsSync(path.join(repoRoot, relativePath)));
    const findings: string[] = [];

    for (const relativePath of scannedFiles) {
      const absolutePath = path.join(repoRoot, relativePath);
      if (!fs.existsSync(absolutePath)) {
        continue;
      }
      const source = fs.readFileSync(absolutePath, 'utf8');
      for (const symbol of retiredSymbols) {
        if (source.includes(symbol)) {
          findings.push(`${relativePath}:${symbol}`);
        }
      }
    }

    expect({ existingRetiredFiles, findings }).toEqual({ existingRetiredFiles: [], findings: [] });
  });

  it('retired response-governance utility public bridges must stay deleted', () => {
    const repoRoot = process.cwd();
    const scannedFiles = [
      'sharedmodule/llmswitch-core/src/native/router-hotpath/native-chat-process-governance-semantics.ts',
      'sharedmodule/llmswitch-core/src/native/router-hotpath/native-router-hotpath-required-exports.ts',
      'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/lib.rs',
      'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/chat_web_search_tool_schema.rs',
      'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/servertool_skeleton/mod.rs',
      'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/servertool_skeleton/finalize_strip.rs',
      'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_lib/engine.rs',
      'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/resp_process_stage1_tool_governance.rs',
      'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/resp_process_stage1_tool_governance_blocks/napi_bindings.rs',
      'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/resp_process_stage1_tool_governance_blocks/orchestrator.rs',
      'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/resp_process_stage1_tool_governance_blocks/napi_utilities.rs',
    ];
    const retiredSymbols = [
      'buildWebSearchToolAppendOperationsWithNative',
      'prepareRespProcessToolGovernancePayloadWithNative',
      'filterOutExecutedServerToolCallsWithNative',
      'resolveRequestedToolNamesWithNative',
      'buildWebSearchToolAppendOperationsJson',
      'prepareRespProcessToolGovernancePayloadJson',
      'filterOutExecutedServerToolCallsJson',
      'resolveRequestedToolNamesJson',
      'build_web_search_tool_append_operations_json',
      'prepare_resp_process_tool_governance_payload_json',
      'filter_out_executed_server_tool_calls_json',
      'resolve_requested_tool_names_json',
      'mod finalize_strip',
      'pub mod finalize_strip',
      'servertool_skeleton::finalize_strip',
      'fn filter_out_executed_servertool_calls',
      'fn resolve_requested_tool_names',
      'fn collect_tool_names_from_candidate',
      'NativeRespProcessToolGovernancePreparationOutput',
      'parseWebSearchOperationsPayload',
      'parseRespProcessToolGovernancePreparationPayload',
    ];
    const findings: string[] = [];

    for (const relativePath of scannedFiles) {
      const absolutePath = path.join(repoRoot, relativePath);
      if (!fs.existsSync(absolutePath)) {
        continue;
      }
      const source = fs.readFileSync(absolutePath, 'utf8');
      for (const symbol of retiredSymbols) {
        if (source.includes(symbol)) {
          findings.push(`${relativePath}:${symbol}`);
        }
      }
    }

    expect(findings).toEqual([]);
  });

  it('retired routing-instruction public helpers must stay deleted from TS and Rust exports', () => {
    const repoRoot = process.cwd();
    const scannedFiles = [
      'sharedmodule/llmswitch-core/src/native/router-hotpath/native-virtual-router-routing-instructions-semantics.ts',
      'sharedmodule/llmswitch-core/src/native/router-hotpath/native-router-hotpath-required-exports.ts',
      'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/lib.rs',
    ];
    const retiredSymbols = [
      'export function cleanRoutingInstructionMarkersWithNative',
      'export function parseAndPreprocessRoutingInstructions',
      'export function extractClearInstruction',
      'export function extractStopMessageClearInstruction',
      'export function applyRoutingInstructionsToStateWithNative',
      'cleanRoutingInstructionMarkersJson',
      '#[napi]\npub fn clean_routing_instruction_markers_json',
    ];
    const findings: string[] = [];

    for (const relativePath of scannedFiles) {
      const absolutePath = path.join(repoRoot, relativePath);
      if (!fs.existsSync(absolutePath)) {
        continue;
      }
      const source = fs.readFileSync(absolutePath, 'utf8');
      for (const symbol of retiredSymbols) {
        if (source.includes(symbol)) {
          findings.push(`${relativePath}:${symbol}`);
        }
      }
    }

    expect(findings).toEqual([]);
  });

  it('retired hub protocol spec public wrappers must stay deleted from TS and Rust exports', () => {
    const repoRoot = process.cwd();
    const scannedFiles = [
      'sharedmodule/llmswitch-core/src/native/router-hotpath/native-hub-bridge-policy-semantics.ts',
      'sharedmodule/llmswitch-core/src/native/router-hotpath/native-router-hotpath-required-exports.ts',
      'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/lib.rs',
      'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_protocol_spec_semantics.rs',
    ];
    const retiredSymbols = [
      'resolveHubProtocolSpecWithNative',
      'resolveHubProtocolAllowlistsWithNative',
      'resolveHubProtocolSpecJson',
      'resolveHubProtocolAllowlistsJson',
      'resolve_hub_protocol_spec_json',
      'resolve_hub_protocol_allowlists_json',
      'NativeProtocolSpec',
      'NativeHubProtocolAllowlists',
    ];
    const findings: string[] = [];

    for (const relativePath of scannedFiles) {
      const absolutePath = path.join(repoRoot, relativePath);
      if (!fs.existsSync(absolutePath)) {
        continue;
      }
      const source = fs.readFileSync(absolutePath, 'utf8');
      for (const symbol of retiredSymbols) {
        if (source.includes(symbol)) {
          findings.push(`${relativePath}:${symbol}`);
        }
      }
    }

    expect(findings).toEqual([]);
  });

  it('retired responses tool-call remap public wrapper must stay deleted', () => {
    const repoRoot = process.cwd();
    const scannedFiles = [
      'sharedmodule/llmswitch-core/src/native/router-hotpath/native-compat-action-semantics.ts',
      'sharedmodule/llmswitch-core/src/native/router-hotpath/native-router-hotpath-required-exports.ts',
      'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/lib.rs',
      'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_bridge_actions/mod.rs',
      'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_bridge_actions/bindings.rs',
    ];
    const retiredSymbols = [
      'remapResponsesToolCallsWithNative',
      'remapResponsesToolCallsJson',
      'remap_responses_tool_calls_json',
    ];
    const findings: string[] = [];

    for (const relativePath of scannedFiles) {
      const absolutePath = path.join(repoRoot, relativePath);
      if (!fs.existsSync(absolutePath)) {
        continue;
      }
      const source = fs.readFileSync(absolutePath, 'utf8');
      for (const symbol of retiredSymbols) {
        if (source.includes(symbol)) {
          findings.push(`${relativePath}:${symbol}`);
        }
      }
    }

    expect(findings).toEqual([]);
  });

  it('retired req outbound context/tool-session public wrappers must stay deleted', () => {
    const repoRoot = process.cwd();
    const scannedFiles = [
      'sharedmodule/llmswitch-core/src/native/router-hotpath/native-hub-pipeline-req-outbound-semantics.ts',
      'sharedmodule/llmswitch-core/src/native/router-hotpath/native-hub-pipeline-inbound-outbound-semantics.ts',
      'sharedmodule/llmswitch-core/src/native/router-hotpath/native-hub-pipeline-req-outbound-semantics-types.ts',
      'sharedmodule/llmswitch-core/src/native/router-hotpath/native-hub-pipeline-req-outbound-semantics-parsers.ts',
      'sharedmodule/llmswitch-core/src/native/router-hotpath/native-router-hotpath-required-exports.ts',
      'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_req_outbound_context_merge.rs',
      'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_req_outbound_format_build.rs',
      'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_tool_session_compat.rs',
    ];
    const retiredSymbols = [
      'resolveReqOutboundContextMergePlanWithNative',
      'buildReqOutboundFormatPayloadWithNative',
      'applyReqOutboundContextSnapshotWithNative',
      'mergeContextToolOutputsWithNative',
      'normalizeContextToolsWithNative',
      'selectToolCallIdStyleWithNative',
      'normalizeToolSessionMessagesWithNative',
      'updateToolSessionHistoryWithNative',
      'shouldAttachReqOutboundContextSnapshotWithNative',
      'resolveReqOutboundContextMergePlanJson',
      'buildFormatRequestJson',
      'applyReqOutboundContextSnapshotJson',
      'mergeContextToolOutputsJson',
      'normalizeContextToolsJson',
      'selectToolCallIdStyleJson',
      'normalizeToolSessionMessagesJson',
      'updateToolSessionHistoryJson',
      'shouldAttachReqOutboundContextSnapshotJson',
      'resolve_req_outbound_context_merge_plan_json',
      'build_format_request_json',
      'apply_req_outbound_context_snapshot_json',
      'merge_context_tool_outputs_json',
      'normalize_context_tools_json',
      'select_tool_call_id_style_json',
      'select_tool_call_id_style',
      'normalize_tool_session_messages_json',
      'update_tool_session_history_json',
      'should_attach_req_outbound_context_snapshot_json',
      'NativeReqOutboundContextMergePlanInput',
      'NativeReqOutboundFormatBuildInput',
      'NativeReqOutboundContextMergePlan',
      'NativeReqOutboundContextSnapshotPatchInput',
      'NativeReqOutboundContextSnapshotPatch',
      'NativeToolSessionCompatInput',
      'NativeToolSessionCompatOutput',
      'NativeToolSessionHistoryUpdateInput',
      'NativeToolSessionHistoryUpdateOutput',
      'parseReqOutboundContextMergePlan',
      'parseReqOutboundFormatBuildOutput',
      'parseReqOutboundContextSnapshotPatch',
      'parseToolSessionCompatOutput',
      'parseToolSessionHistoryUpdateOutput',
    ];
    const findings: string[] = [];

    for (const relativePath of scannedFiles) {
      const absolutePath = path.join(repoRoot, relativePath);
      if (!fs.existsSync(absolutePath)) {
        continue;
      }
      const source = fs.readFileSync(absolutePath, 'utf8');
      for (const symbol of retiredSymbols) {
        if (source.includes(symbol)) {
          findings.push(`${relativePath}:${symbol}`);
        }
      }
    }

    expect(findings).toEqual([]);
  });

  it('legacy shadow-gate migration manifest scripts must stay deleted', () => {
    const repoRoot = process.cwd();
    const rootPkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    const corePkg = JSON.parse(
      fs.readFileSync(path.join(repoRoot, 'sharedmodule/llmswitch-core/package.json'), 'utf8'),
    ) as { scripts?: Record<string, string> };
    const forbiddenScriptPatterns = [
      /verify:shadow-gate/,
      /check-shadow-coverage-gate/,
      /verify-shadow-gate-all/,
      /promote-shadow-module/,
      /rust-migration-modules\.json/,
      /run-ci-coverage/,
    ];
    const findings: string[] = [];

    for (const [pkgName, scripts] of [
      ['package.json', rootPkg.scripts ?? {}],
      ['sharedmodule/llmswitch-core/package.json', corePkg.scripts ?? {}],
    ] as const) {
      for (const [name, command] of Object.entries(scripts)) {
        for (const pattern of forbiddenScriptPatterns) {
          if (pattern.test(name) || pattern.test(command)) {
            findings.push(`${pkgName}:${name}`);
          }
        }
      }
    }

    expect(findings).toEqual([]);
  });

  it('hub stage timing must not restore test-only measure wrapper API', () => {
    const timingSource = fs.readFileSync(
      path.join(process.cwd(), 'sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-stage-timing.ts'),
      'utf8',
    );
    const topSummaryTest = fs.readFileSync(
      path.join(process.cwd(), 'tests/sharedmodule/hub-stage-timing-top-summary.spec.ts'),
      'utf8',
    );
    const findings = collectMatches(timingSource, [
      { label: 'exports test-only measureHubStage wrapper', pattern: /export\s+async\s+function\s+measureHubStage\b/ },
      { label: 'keeps private measure execution template', pattern: /function\s+measureHubStageExecution\b/ },
    ]);

    if (/\bmeasureHubStage\b/.test(topSummaryTest)) {
      findings.push('top summary test consumes measureHubStage wrapper');
    }

    expect(findings).toEqual([]);
    expect(timingSource).toContain('feature_id: hub.stage_timing_observation');
  });

  it('active source and tests must not import removed session identifier wrapper', () => {
    const repoRoot = process.cwd();
    const sourceRoots = [
      path.join(repoRoot, 'src'),
      path.join(repoRoot, 'sharedmodule/llmswitch-core/src'),
      path.join(repoRoot, 'tests'),
    ];
    const findings: string[] = [];

    for (const root of sourceRoots) {
      for (const fullPath of walkFiles(root, ['.ts', '.tsx', '.js', '.jsx', '.d.ts'])) {
        const relativePath = path.relative(repoRoot, fullPath).split(path.sep).join('/');
        if (relativePath === 'tests/sharedmodule/hub-pipeline-stage-residue-audit.spec.ts') {
          continue;
        }
        const source = fs.readFileSync(fullPath, 'utf8');
        if (source.includes('conversion/hub/pipeline/session-identifiers')) {
          findings.push(relativePath);
        }
      }
    }

    expect(findings).toEqual([]);
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
      'sharedmodule/llmswitch-core/scripts/tests/coverage-hub-tool-governance.mjs',
      'sharedmodule/llmswitch-core/scripts/tests/tool-governance-check.mjs',
      'sharedmodule/llmswitch-core/scripts/tests/tool-governance-native-compare.mjs',
      'sharedmodule/llmswitch-core/scripts/tests/response-tool-text-canonicalize-invoke.mjs',
      'sharedmodule/llmswitch-core/scripts/tests/response-tool-text-canonicalize-tool-namespace.mjs',
      'docs/plans/p1-deterministic-fix-plan.md',
      'docs/goals/p1-deterministic-fix-execution-plan.md',
      'docs/plans/next-step-deterministic-fix-execution.md',
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

  it('llmswitch matrix runner must not reference missing test scripts', () => {
    const repoRoot = process.cwd();
    const matrixPath = path.join(
      repoRoot,
      'sharedmodule/llmswitch-core/scripts/tests/run-matrix-ci.mjs',
    );
    const source = fs.readFileSync(matrixPath, 'utf8');
    const referenced = new Set<string>();
    const scriptPattern = /['"`](scripts\/tests\/[^'"`]+\.mjs)['"`]/g;
    let match: RegExpExecArray | null;
    while ((match = scriptPattern.exec(source)) !== null) {
      referenced.add(match[1]);
    }
    const missing = Array.from(referenced)
      .filter((relativePath) => !fs.existsSync(path.join(repoRoot, 'sharedmodule/llmswitch-core', relativePath)))
      .sort();

    expect(missing).toEqual([]);
  });

  it('package scripts must not reference missing test files', () => {
    const repoRoot = process.cwd();
    const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    const pathPattern = /(?:tests|src)\/[^ '"`]+\.(?:spec|test)\.(?:tsx|ts|jsx|js|mjs|cjs)/g;
    const missing: string[] = [];

    for (const [scriptName, command] of Object.entries(packageJson.scripts ?? {})) {
      const paths = command.match(pathPattern) ?? [];
      for (const relativePath of paths) {
        if (!fs.existsSync(path.join(repoRoot, relativePath))) {
          missing.push(`${scriptName}:${relativePath}`);
        }
      }
    }

    expect(missing.sort()).toEqual([]);
  });

  it('root scripts must not call retired responses SSE replay owners', () => {
    const scriptsRoot = path.join(process.cwd(), 'scripts');
    const findings: string[] = [];

    for (const fullPath of walkFiles(scriptsRoot, ['.mjs', '.js'])) {
      const relativePath = path.relative(process.cwd(), fullPath).split(path.sep).join('/');
      const source = fs.readFileSync(fullPath, 'utf8');
      const matches = collectMatches(source, [
        {
          label: 'legacy dist v2 conversion streaming owner import',
          pattern: /dist\/v2\/conversion|streaming['"`),\s]*json-to-responses-sse\.js/,
        },
        {
          label: 'legacy createResponsesSSEStreamFromChatJson helper',
          pattern: /createResponsesSSEStreamFromChatJson/,
        },
      ]);
      for (const match of matches) {
        findings.push(`${relativePath}:${match}`);
      }
    }

    expect(findings).toEqual([]);
  });

  it('legacy TS filters must not expose tool semantics after Rust HubPipeline takeover', () => {
    const filtersRoot = path.join(process.cwd(), 'sharedmodule/llmswitch-core/src/filters');
    const forbiddenModules = [
      'index',
      'engine',
      'types',
      'builtin/add-fields-filter',
      'builtin/blacklist-filter',
      'builtin/whitelist-filter',
      'utils/snapshot-writer',
      'config/openai-openai.fieldmap',
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
    const existing = forbiddenModules
      .flatMap((name) => [`${name}.ts`, `special/${name}.ts`, `${name}.json`])
      .filter((relativePath) => fs.existsSync(path.join(filtersRoot, relativePath)));

    expect(existing).toEqual([]);
  });

  it('legacy config facade and stale coverage scripts must stay deleted', () => {
    const repoRoot = process.cwd();
    const forbiddenFiles = [
      'sharedmodule/llmswitch-core/src/config-unified/enhanced-path-resolver.ts',
      'sharedmodule/llmswitch-core/src/config-unified/unified-config.ts',
      'sharedmodule/llmswitch-core/src/conversion/protocol-field-allowlists.ts',
      'sharedmodule/llmswitch-core/src/conversion/hub/policy/policy-engine.ts',
      'sharedmodule/llmswitch-core/src/conversion/hub/policy/protocol-spec.ts',
      'sharedmodule/llmswitch-core/src/conversion/config/config-manager.ts',
      'sharedmodule/llmswitch-core/src/conversion/config/sample-config.json',
      'sharedmodule/llmswitch-core/src/conversion/config/version-switch.json',
      'sharedmodule/llmswitch-core/src/conversion/args-mapping.ts',
      'sharedmodule/llmswitch-core/src/conversion/codec-registry.ts',
      'sharedmodule/llmswitch-core/src/conversion/schema-validator.ts',
      'sharedmodule/llmswitch-core/src/conversion/media.ts',
      'sharedmodule/llmswitch-core/src/conversion/pipeline',
      'sharedmodule/llmswitch-core/src/conversion/pipeline/index.ts',
      'sharedmodule/llmswitch-core/src/conversion/pipeline/meta/meta-bag.ts',
      'sharedmodule/llmswitch-core/src/conversion/pipeline/schema/index.ts',
      'sharedmodule/llmswitch-core/src/conversion/pipeline/README.md',
      'sharedmodule/llmswitch-core/src/conversion/pipeline/codecs/v2/README.md',
      'sharedmodule/llmswitch-core/src/conversion/pipeline/codecs/v2/anthropic-openai-pipeline.ts',
      'sharedmodule/llmswitch-core/src/conversion/pipeline/codecs/v2/openai-openai-pipeline.ts',
      'sharedmodule/llmswitch-core/src/conversion/pipeline/codecs/v2/responses-openai-pipeline.ts',
      'sharedmodule/llmswitch-core/src/conversion/pipeline/codecs/v2/shared/openai-chat-helpers.ts',
      'sharedmodule/llmswitch-core/src/conversion/pipeline/hooks/adapter-context.ts',
      'sharedmodule/llmswitch-core/src/conversion/pipeline/hooks/protocol-hooks.ts',
      'sharedmodule/llmswitch-core/src/conversion/pipeline/schema/canonical-chat.ts',
      'sharedmodule/llmswitch-core/src/conversion/pipeline/tests/README.md',
      'tests/sharedmodule/responses-openai-pipeline-request-parameters.spec.ts',
      'src/types/llmswitch-core-api-shim.d.ts',
      'tests/sharedmodule/hub-policy-provider-outbound-reasoning-filter.spec.ts',
      'tests/sharedmodule/hub-policy-observe-allowlist.spec.ts',
      'sharedmodule/llmswitch-core/scripts/tests/coverage-request-tool-list-filter.mjs',
      'sharedmodule/llmswitch-core/scripts/tests/gemini-finish-reason.mjs',
      'sharedmodule/llmswitch-core/dist/config-unified/enhanced-path-resolver.js',
      'sharedmodule/llmswitch-core/dist/config-unified/enhanced-path-resolver.d.ts',
      'sharedmodule/llmswitch-core/dist/config-unified/unified-config.js',
      'sharedmodule/llmswitch-core/dist/config-unified/unified-config.d.ts',
      'sharedmodule/llmswitch-core/dist/conversion/protocol-field-allowlists.js',
      'sharedmodule/llmswitch-core/dist/conversion/protocol-field-allowlists.d.ts',
      'sharedmodule/llmswitch-core/dist/conversion/hub/policy/policy-engine.js',
      'sharedmodule/llmswitch-core/dist/conversion/hub/policy/policy-engine.d.ts',
      'sharedmodule/llmswitch-core/dist/conversion/hub/policy/protocol-spec.js',
      'sharedmodule/llmswitch-core/dist/conversion/hub/policy/protocol-spec.d.ts',
      'sharedmodule/llmswitch-core/dist/conversion/config/config-manager.js',
      'sharedmodule/llmswitch-core/dist/conversion/config/config-manager.d.ts',
      'sharedmodule/llmswitch-core/dist/conversion/config/sample-config.json',
      'sharedmodule/llmswitch-core/dist/conversion/codec-registry.js',
      'sharedmodule/llmswitch-core/dist/conversion/codec-registry.d.ts',
      'sharedmodule/llmswitch-core/dist/conversion/schema-validator.js',
      'sharedmodule/llmswitch-core/dist/conversion/schema-validator.d.ts',
      'sharedmodule/llmswitch-core/dist/conversion/config/version-switch.json',
      'sharedmodule/llmswitch-core/dist/conversion/args-mapping.js',
      'sharedmodule/llmswitch-core/dist/conversion/args-mapping.d.ts',
      'sharedmodule/llmswitch-core/dist/conversion/media.js',
      'sharedmodule/llmswitch-core/dist/conversion/media.d.ts',
      'sharedmodule/llmswitch-core/dist/conversion/pipeline',
      'sharedmodule/llmswitch-core/dist/conversion/pipeline/index.js',
      'sharedmodule/llmswitch-core/dist/conversion/pipeline/index.d.ts',
      'sharedmodule/llmswitch-core/dist/conversion/pipeline/meta/meta-bag.js',
      'sharedmodule/llmswitch-core/dist/conversion/pipeline/meta/meta-bag.d.ts',
      'sharedmodule/llmswitch-core/dist/conversion/pipeline/schema/index.js',
      'sharedmodule/llmswitch-core/dist/conversion/pipeline/schema/index.d.ts',
      'sharedmodule/llmswitch-core/dist/filters/index.js',
      'sharedmodule/llmswitch-core/dist/filters/index.d.ts',
      'sharedmodule/llmswitch-core/dist/filters/engine.js',
      'sharedmodule/llmswitch-core/dist/filters/engine.d.ts',
      'sharedmodule/llmswitch-core/dist/filters/types.js',
      'sharedmodule/llmswitch-core/dist/filters/types.d.ts',
      'sharedmodule/llmswitch-core/dist/filters/builtin/add-fields-filter.js',
      'sharedmodule/llmswitch-core/dist/filters/builtin/add-fields-filter.d.ts',
      'sharedmodule/llmswitch-core/dist/filters/builtin/blacklist-filter.js',
      'sharedmodule/llmswitch-core/dist/filters/builtin/blacklist-filter.d.ts',
      'sharedmodule/llmswitch-core/dist/filters/builtin/whitelist-filter.js',
      'sharedmodule/llmswitch-core/dist/filters/builtin/whitelist-filter.d.ts',
      'sharedmodule/llmswitch-core/dist/filters/config/openai-openai.fieldmap.json',
      'sharedmodule/llmswitch-core/dist/filters/utils/snapshot-writer.js',
      'sharedmodule/llmswitch-core/dist/filters/utils/snapshot-writer.d.ts',
    ];
    const existing = forbiddenFiles.filter((relativePath) => fs.existsSync(path.join(repoRoot, relativePath)));

    expect(existing).toEqual([]);
  });

  it('shared openai message normalize must not inject MCP tools or swallow native failures in TS', () => {
    const filePath = path.join(process.cwd(), 'sharedmodule/llmswitch-core/src/conversion/shared/openai-message-normalize.ts');
    const source = fs.readFileSync(filePath, 'utf8');
    const findings = collectMatches(source, [
      { label: 'imports MCP injection helper in TS normalize path', pattern: /injectMcpToolsForChat|mcp-injection/ },
      { label: 'reads MCP env flags in TS normalize path', pattern: /ROUTECODEX_MCP_ENABLE|RCC_MCP_SERVERS|__rcc_disable_mcp_tools/ },
      { label: 'discovers MCP servers from tool result text in TS', pattern: /list_mcp_resources|resourceTemplates|extractFromOutput/ },
      { label: 'keeps non-blocking normalize logger', pattern: /logNormalizeNonBlocking|formatUnknownError/ },
      { label: 'swallows native normalize failure', pattern: /catch\s*\(error\)\s*\{[\s\S]*?chat_messages\.normalize_native/ },
    ]);

    expect(findings).toEqual([]);
  });

  it('HubPipeline runtime ingress hooks must not swallow native lifecycle failures', () => {
    const filePath = path.join(process.cwd(), 'sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline.ts');
    const source = fs.readFileSync(filePath, 'utf8');
    const findings = collectMatches(source, [
      { label: 'keeps non-blocking HubPipeline lifecycle logger', pattern: /logHubPipelineNonBlockingError|failed \(non-blocking\)/ },
      { label: 'swallows native runtime ingress unregister failure', pattern: /catch\s*\([^)]*\)\s*\{[\s\S]*?unregisterProviderRuntimeIngress/ },
      { label: 'keeps deleted provider runtime ingress dispose marker', pattern: /dispose\.provider-runtime-ingress\.unregister/ },
    ]);

    expect(findings).toEqual([]);
  });

  it('HubPipeline type barrel must not export zero-consumer nested config shells', () => {
    const typesSource = fs.readFileSync(
      path.join(process.cwd(), 'sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-types.ts'),
      'utf8',
    );
    const barrelSource = fs.readFileSync(
      path.join(process.cwd(), 'sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline.ts'),
      'utf8',
    );
    const forbidden = [
      'HubPolicyMode',
      'HubPolicyConfig',
      'HubShadowCompareRequestConfig',
      'HubToolSurfaceMode',
      'HubToolSurfaceConfig',
      'HubPipelineRequestMetadata',
    ];
    const findings: string[] = [];
    const exportBlock = barrelSource.match(/export type\s*\{[\s\S]*?\}\s*from\s*["']\.\/hub-pipeline-types\.js["'];/)?.[0] ?? '';

    for (const name of forbidden) {
      const exportedDeclaration = new RegExp(`export\\s+(?:type|interface)\\s+${name}\\b`);
      if (exportedDeclaration.test(typesSource)) {
        findings.push(`exported nested type ${name}`);
      }
      if (exportBlock.includes(name)) {
        findings.push(`barrel re-exports nested type ${name}`);
      }
    }

    expect(findings).toEqual([]);
    expect(typesSource).toContain('export interface HubPipelineConfig');
    expect(typesSource).toContain('export interface HubPipelineRequest');
    expect(typesSource).toContain('export interface HubPipelineResult');
    expect(typesSource).toContain('export interface NormalizedRequest');
    expect(typesSource).toContain('export type ProviderProtocol');
  });

  it('HubPipeline compat types must not restore retired profile/mapping type shells', () => {
    const filePath = path.join(process.cwd(), 'sharedmodule/llmswitch-core/src/conversion/hub/pipeline/compat/compat-types.ts');
    const source = fs.readFileSync(filePath, 'utf8');
    const findings = collectMatches(source, [
      { label: 'restores retired compat profile config', pattern: /CompatProfileConfig|CompatStageConfig/ },
      { label: 'restores retired compat mapping shells', pattern: /MappingInstruction|FilterInstruction|FieldMapping/ },
      { label: 'restores retired compat protocol aliases', pattern: /CompatDirection|CompatNativeProtocolToken|NativeProviderProtocolToken/ },
      { label: 'restores retired action config aliases', pattern: /ShapeFilterConfig|ResponseBlacklistConfig|RequestRulesConfig|AutoThinkingConfig|ResponseNormalizeConfig|ResponseValidateConfig|HarvestToolCallsFromTextConfig|ToolTextRequestGuidanceConfig|DeepSeekWebResponseConfig/ },
    ]);

    expect(findings).toEqual([]);
  });

  it('ChatEnvelope type surface must not export zero-consumer nested semantic shells', () => {
    const filePath = path.join(process.cwd(), 'sharedmodule/llmswitch-core/src/conversion/hub/types/chat-envelope.ts');
    const source = fs.readFileSync(filePath, 'utf8');
    const forbidden = [
      'ChatRole',
      'ChatToolCall',
      'ChatMessage',
      'ChatContinuationScope',
      'ChatContinuationStateOrigin',
      'ChatContinuationPointer',
      'ChatToolContinuation',
      'ChatToolOutput',
      'ChatProtocolMappingDisposition',
      'ChatProtocolMappingAuditEntry',
      'ChatSemanticAudit',
      'ChatToolSemantics',
      'ChatResponsesSemantics',
      'ChatAnthropicSemantics',
      'ChatGeminiSemantics',
    ];
    const findings: string[] = [];

    for (const name of forbidden) {
      const exportedDeclaration = new RegExp(`export\\s+(?:type|interface)\\s+${name}\\b`);
      if (exportedDeclaration.test(source)) {
        findings.push(`exported zero-consumer nested type ${name}`);
      }
    }

    expect(findings).toEqual([]);
    expect(source).toContain('feature_id: hub.chat_envelope_type_surface');
    expect(source).toContain('export interface AdapterContext');
    expect(source).toContain('export interface ChatContinuationSemantics');
    expect(source).toContain('export interface ChatSemantics');
    expect(source).toContain('export interface ChatEnvelope');
  });

  it('StandardizedRequest type surface must not export zero-consumer nested field shells', () => {
    const filePath = path.join(process.cwd(), 'sharedmodule/llmswitch-core/src/conversion/hub/types/standardized.ts');
    const source = fs.readFileSync(filePath, 'utf8');
    const forbidden = [
      'ToolCall',
      'ToolChoice',
      'StandardizedTool',
      'ToolCallResult',
      'StandardizedMessageContent',
      'StandardizedParameters',
      'StandardizedMetadata',
    ];
    const findings: string[] = [];

    for (const name of forbidden) {
      const exportedDeclaration = new RegExp(`export\\s+(?:type|interface)\\s+${name}\\b`);
      if (exportedDeclaration.test(source)) {
        findings.push(`exported zero-consumer standardized nested type ${name}`);
      }
    }

    expect(findings).toEqual([]);
    expect(source).toContain('export interface StandardizedMessage');
    expect(source).toContain('export interface StandardizedRequest');
    expect(source).toContain('export interface ProcessedRequest');
  });

  it('chat process session usage bridge must not restore retired token estimate branch', () => {
    const filePath = path.join(process.cwd(), 'sharedmodule/llmswitch-core/src/conversion/hub/process/chat-process-session-usage.ts');
    const source = fs.readFileSync(filePath, 'utf8');
    const findings = collectMatches(source, [
      { label: 'restores retired session token estimator export', pattern: /estimateSessionBoundTokens/ },
      { label: 'restores retired session delta token estimator', pattern: /estimateDeltaTokens|countRequestTokens/ },
      { label: 'restores retired session usage snapshot reader', pattern: /SessionUsageSnapshot|buildSnapshot/ },
    ]);

    expect(findings).toEqual([]);
  });

  it('chat process session usage bridge must not swallow routing state load failures', () => {
    const filePath = path.join(process.cwd(), 'sharedmodule/llmswitch-core/src/conversion/hub/process/chat-process-session-usage.ts');
    const source = fs.readFileSync(filePath, 'utf8');
    const loadStateBlock = extractFunctionBlock(source, 'loadState');
    expect(loadStateBlock).not.toMatch(/catch\s*\{/);
    expect(loadStateBlock).not.toMatch(/return\s+null\s*;/);
  });

  it('marker lifecycle shared helper must not expose internal TS marker parsers as public API', () => {
    const filePath = path.join(process.cwd(), 'sharedmodule/llmswitch-core/src/conversion/shared/marker-lifecycle.ts');
    const source = fs.readFileSync(filePath, 'utf8');
    const findings = collectMatches(source, [
      { label: 'exports marker match type', pattern: /export\s+interface\s+MarkerSyntaxMatch\b/ },
      { label: 'exports marker strip result type', pattern: /export\s+interface\s+StripMarkerSyntaxResult\b/ },
      { label: 'exports text marker parser', pattern: /export\s+function\s+stripMarkerSyntaxFromText\b/ },
      { label: 'exports content marker parser', pattern: /export\s+function\s+stripMarkerSyntaxFromContent\b/ },
      { label: 'exports message marker parser', pattern: /export\s+function\s+stripMarkerSyntaxFromMessages\b/ },
      { label: 'exports request marker parser', pattern: /export\s+function\s+stripMarkerSyntaxFromRequest\b/ },
    ]);

    expect(findings).toEqual([]);
  });

  it('chat SSE serializer must not expose retired stream wrapper helper', () => {
    const filePath = path.join(process.cwd(), 'sharedmodule/llmswitch-core/src/sse/shared/chat-serializer.ts');
    const source = fs.readFileSync(filePath, 'utf8');
    const findings = collectMatches(source, [
      { label: 'imports stream wrapper primitives for deleted helper', pattern: /import\s+\{[^}]*\b(?:PassThrough|Readable)\b[^}]*\}\s+from\s+['"]node:stream['"]/ },
      { label: 'keeps deleted chat SSE text stream wrapper', pattern: /export\s+function\s+toSSETextStream\b/ },
      { label: 'keeps deleted chat serializer non-blocking logger', pattern: /logChatSerializerNonBlocking\b/ },
      { label: 'keeps deleted generic chat serializer error frame', pattern: /chat sse serialization failed/ },
    ]);

    expect(findings).toEqual([]);
  });

  it('SSE shared utils must not expose retired zero-consumer public helpers', () => {
    const filePath = path.join(process.cwd(), 'sharedmodule/llmswitch-core/src/sse/shared/utils.ts');
    const source = fs.readFileSync(filePath, 'utf8');
    const findings = collectMatches(source, [
      { label: 'imports stream primitive only used by retired helper', pattern: /import\s+\{[^}]*\bReadable\b[^}]*\}\s+from\s+['"]stream['"]/ },
      { label: 'exports retired object helper namespace', pattern: /export\s+class\s+ObjectUtils\b/ },
      { label: 'exports retired array helper namespace', pattern: /export\s+class\s+ArrayUtils\b/ },
      { label: 'exports retired stream helper namespace', pattern: /export\s+class\s+StreamUtils\b/ },
      { label: 'exports retired regex helper constants', pattern: /export\s+const\s+REGEX_PATTERNS\b/ },
      { label: 'exports retired performance helper namespace', pattern: /export\s+class\s+PerformanceUtils\b/ },
    ]);

    expect(findings).toEqual([]);
  });

  it('SSE public barrel must not expose retired bidirectional facade', () => {
    const repoRoot = process.cwd();
    const files = [
      'sharedmodule/llmswitch-core/src/sse/index.ts',
      'sharedmodule/llmswitch-core/src/sse/README-RESPONSES.md',
    ];
    const findings: string[] = [];

    for (const relativePath of files) {
      const source = fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
      const matches = collectMatches(source, [
        { label: 'exports retired bidirectional factory', pattern: /\bcreateBidirectionalConverters\b/ },
        { label: 'exports retired bidirectional singleton', pattern: /\bbidirectionalConverters\b/ },
        { label: 'keeps retired auto-detect conversion facade', pattern: /\bautoConvert\b/ },
      ]);
      for (const match of matches) {
        findings.push(`${relativePath}:${match}`);
      }
    }

    expect(findings).toEqual([]);
  });

  it('responses reasoning registry TS wrapper must not expose Rust-internal reasoning/meta APIs', () => {
    const repoRoot = process.cwd();
    const files = [
      'sharedmodule/llmswitch-core/src/conversion/shared/responses-reasoning-registry.ts',
      'sharedmodule/llmswitch-core/src/native/router-hotpath/native-router-hotpath-required-exports.ts',
      'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/lib.rs',
    ];
    const findings: string[] = [];

    for (const relativePath of files) {
      const source = fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
      const matches = collectMatches(source, [
        { label: 'exports TS responses reasoning payload type', pattern: /export\s+interface\s+ResponsesReasoningPayload\b/ },
        { label: 'exports TS responses output text meta type', pattern: /export\s+interface\s+ResponsesOutputTextMeta\b/ },
        { label: 'exports TS responses reasoning register wrapper', pattern: /export\s+function\s+registerResponsesReasoning\b/ },
        { label: 'exports TS responses reasoning consume wrapper', pattern: /export\s+function\s+consumeResponsesReasoning\b/ },
        { label: 'exports TS output text meta register wrapper', pattern: /export\s+function\s+registerResponsesOutputTextMeta\b/ },
        { label: 'exports TS output text meta consume wrapper', pattern: /export\s+function\s+consumeResponsesOutputTextMeta\b/ },
        { label: 'requires JS responses reasoning register capability', pattern: /registerResponsesReasoningJson\b/ },
        { label: 'requires JS responses reasoning consume capability', pattern: /consumeResponsesReasoningJson\b/ },
        { label: 'requires JS output text meta register capability', pattern: /registerResponsesOutputTextMetaJson\b/ },
        { label: 'requires JS output text meta consume capability', pattern: /consumeResponsesOutputTextMetaJson\b/ },
        { label: 're-exports Rust responses reasoning register NAPI', pattern: /\bregister_responses_reasoning_json\b/ },
        { label: 're-exports Rust responses reasoning consume NAPI', pattern: /\bconsume_responses_reasoning_json\b/ },
        { label: 're-exports Rust output text meta register NAPI', pattern: /\bregister_responses_output_text_meta_json\b/ },
        { label: 're-exports Rust output text meta consume NAPI', pattern: /\bconsume_responses_output_text_meta_json\b/ },
      ]);
      for (const match of matches) {
        findings.push(`${relativePath}:${match}`);
      }
    }

    expect(findings).toEqual([]);
  });

  it('conversion shared thin wrappers must not expose retired zero-consumer public helpers', () => {
    const repoRoot = process.cwd();
    const files = [
      'sharedmodule/llmswitch-core/src/conversion/shared/anthropic-message-utils-core.ts',
      'sharedmodule/llmswitch-core/src/conversion/shared/anthropic-message-utils-openai-response.ts',
      'sharedmodule/llmswitch-core/src/conversion/shared/output-content-normalizer.ts',
      'sharedmodule/llmswitch-core/src/conversion/shared/reasoning-tool-normalizer.ts',
      'sharedmodule/llmswitch-core/src/conversion/shared/responses-tool-utils.ts',
      'sharedmodule/llmswitch-core/src/conversion/shared/tool-mapping.ts',
      'sharedmodule/llmswitch-core/src/conversion/shared/tooling.ts',
      'sharedmodule/llmswitch-core/src/native/router-hotpath/native-shared-conversion-semantics-tool-definitions.ts',
      'sharedmodule/llmswitch-core/src/native/router-hotpath/native-shared-conversion-semantics-shell-utils.ts',
      'sharedmodule/llmswitch-core/src/native/router-hotpath/native-shared-conversion-semantics.ts',
      'sharedmodule/llmswitch-core/src/native/router-hotpath/native-router-hotpath-required-exports.ts',
      'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/lib.rs',
      'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/shared_args_mapping.rs',
      'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/shared_tool_mapping.rs',
    ];
    const findings: string[] = [];
    const retiredFiles = [
      'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/thought_signature_validator.rs',
      'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/thought_signature_validator/tests.rs',
    ].filter((relativePath) => fs.existsSync(path.join(repoRoot, relativePath)));

    for (const relativePath of files) {
      const source = fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
      const matches = collectMatches(source, [
        { label: 'exports unused output extraction result type', pattern: /export\s+interface\s+OutputContentExtractionResult\b/ },
        { label: 'exports unused output extraction wrapper', pattern: /export\s+function\s+extractOutputSegments\b/ },
        { label: 'exports unused content part wrapper', pattern: /export\s+function\s+normalizeContentPart\b/ },
        { label: 'exports unused anthropic tool-use id sanitizer', pattern: /export\s+function\s+sanitizeToolUseId\b/ },
        { label: 'exports unused anthropic system text helper', pattern: /export\s+function\s+requireSystemText\b/ },
        { label: 'exports internal anthropic alias coercion helper', pattern: /export\s+function\s+coerceAnthropicAliasRecord\b/ },
        { label: 'exports file-local anthropic OpenAI options type', pattern: /export\s+interface\s+BuildAnthropicFromOpenAIOptions\b|export\s+type\s+\{\s*BuildAnthropicFromOpenAIOptions\s*\}/ },
        { label: 're-exports internal anthropic tool-name helpers from barrel', pattern: /export\s+\{[^}]*\b(?:denormalizeAnthropicToolName|normalizeAnthropicToolName)\b[^}]*\}\s+from\s+['"]\.\/anthropic-message-utils-core\.js['"]/ },
        { label: 're-exports internal anthropic tools-to-chat helper from barrel', pattern: /export\s+\{[^}]*\bmapAnthropicToolsToChat\b[^}]*\}\s+from\s+['"]\.\/anthropic-message-utils-tool-schema\.js['"]/ },
        { label: 'exports unused reasoning normalization result type', pattern: /export\s+interface\s+ReasoningNormalizationResult\b/ },
        { label: 'exports unused chat response reasoning wrapper', pattern: /export\s+function\s+normalizeChatResponseReasoningTools\b/ },
        { label: 'exports unused tool-call function type', pattern: /export\s+interface\s+ToolCallFunction\b/ },
        { label: 'exports unused tool-call item type', pattern: /export\s+interface\s+ToolCallItem\b/ },
        { label: 'exports file-local call id transformer type', pattern: /export\s+interface\s+CallIdTransformer\b/ },
        { label: 'exports file-local bridge tool map options type', pattern: /export\s+interface\s+BridgeToolMapOptions\b/ },
        { label: 'exports unused stringify args helper', pattern: /export\s+function\s+stringifyArgs\b/ },
        { label: 'exports unused bridge tool to chat single wrapper', pattern: /export\s+function\s+bridgeToolToChatDefinition\b/ },
        { label: 'exports unused bridge tool to chat native bridge', pattern: /bridgeToolToChatDefinitionWithNative\b/ },
        { label: 'keeps unused bridge tool to chat native capability', pattern: /bridgeToolToChatDefinitionJson\b/ },
        { label: 'keeps unused bridge tool to chat rust napi export', pattern: /\bbridge_tool_to_chat_definition_json\b/ },
        { label: 'exports unused chat tool to bridge single wrapper', pattern: /export\s+function\s+chatToolToBridgeDefinition\b/ },
        { label: 'exports unused chat tool to bridge native bridge', pattern: /chatToolToBridgeDefinitionWithNative\b/ },
        { label: 'keeps unused chat tool to bridge native capability', pattern: /chatToolToBridgeDefinitionJson\b/ },
        { label: 'exports unused split command wrapper', pattern: /export\s+function\s+splitCommandString\b/ },
        { label: 'exports unused shell args packing wrapper', pattern: /export\s+function\s+packShellArgs\b/ },
        { label: 'exports unused comma flattening wrapper', pattern: /export\s+function\s+flattenByComma\b/ },
        { label: 'exports unused shell args type', pattern: /export\s+interface\s+ShellArgs\b/ },
        { label: 'exports unused chunk string wrapper', pattern: /export\s+function\s+chunkString\b/ },
        { label: 'exports unused chunk string native bridge', pattern: /chunkStringWithNative\b/ },
        { label: 'keeps unused chunk string native capability', pattern: /chunkStringJson\b/ },
        { label: 'exports unused split command native bridge', pattern: /splitCommandStringWithNative\b/ },
        { label: 'keeps unused split command native capability', pattern: /splitCommandStringJson\b/ },
        { label: 'exports unused shell args packing native bridge', pattern: /packShellArgsWithNative\b/ },
        { label: 'keeps unused shell args packing native capability', pattern: /packShellArgsJson\b/ },
        { label: 'exports unused comma flattening native bridge', pattern: /flattenByCommaWithNative\b/ },
        { label: 'keeps unused comma flattening native capability', pattern: /flattenByCommaJson\b/ },
        { label: 'keeps unused split command rust napi export', pattern: /\bsplit_command_string_json\b/ },
        { label: 'keeps unused shell args packing rust napi export', pattern: /\bpack_shell_args_json\b/ },
        { label: 'keeps unused comma flattening rust napi export', pattern: /\bflatten_by_comma_json\b/ },
        { label: 'keeps unused chunk string rust napi export', pattern: /\bchunk_string_json\b/ },
        { label: 'exports unused thought signature validator bridge', pattern: /hasValidThoughtSignatureWithNative\b/ },
        { label: 'exports unused thinking block sanitizer bridge', pattern: /sanitizeThinkingBlockWithNative\b/ },
        { label: 'exports unused thinking block filter bridge', pattern: /filterInvalidThinkingBlocksWithNative\b/ },
        { label: 'exports unused trailing thinking block bridge', pattern: /removeTrailingUnsignedThinkingBlocksWithNative\b/ },
        { label: 'keeps unused thought signature capability', pattern: /hasValidThoughtSignatureJson\b/ },
        { label: 'keeps unused thinking block sanitizer capability', pattern: /sanitizeThinkingBlockJson\b/ },
        { label: 'keeps unused thinking block filter capability', pattern: /filterInvalidThinkingBlocksJson\b/ },
        { label: 'keeps unused trailing thinking block capability', pattern: /removeTrailingUnsignedThinkingBlocksJson\b/ },
        { label: 'keeps unused thought signature rust napi export', pattern: /\bhas_valid_thought_signature_json\b/ },
        { label: 'keeps unused thinking block sanitizer rust napi export', pattern: /\bsanitize_thinking_block_json\b/ },
        { label: 'keeps unused thinking block filter rust napi export', pattern: /\bfilter_invalid_thinking_blocks_json\b/ },
        { label: 'keeps unused trailing thinking block rust napi export', pattern: /\bremove_trailing_unsigned_thinking_blocks_json\b/ },
        { label: 'exports unused normalizeTools bridge', pattern: /normalizeToolsWithNative\b/ },
        { label: 'keeps unused normalizeTools capability', pattern: /normalizeToolsJson\b/ },
        { label: 'keeps unused normalizeTools rust napi export', pattern: /\bnormalize_tools_json\b/ },
        { label: 'keeps unused standalone normalize_tools helper', pattern: /\bfn\s+normalize_tools\s*\(/ },
        { label: 'keeps unused standalone shell schema helper', pattern: /\bfn\s+ensure_shell_schema\s*\(/ },
        { label: 'keeps unused standalone shell description helper', pattern: /\bfn\s+build_shell_description\s*\(/ },
      ]);
      for (const match of matches) {
        findings.push(`${relativePath}:${match}`);
      }
    }

    expect(retiredFiles).toEqual([]);
    expect(findings).toEqual([]);
  });

  it('legacy shared responses request adapter must stay deleted from active docs and source', () => {
    const adapterPath = path.join(
      process.cwd(),
      'sharedmodule/llmswitch-core/src/conversion/shared/responses-request-adapter.ts',
    );
    const guidePath = path.join(process.cwd(), 'sharedmodule/llmswitch-core/src/guidance/RCC_TOOL_GUIDE.md');
    const guideSource = fs.readFileSync(guidePath, 'utf8');

    expect(fs.existsSync(adapterPath)).toBe(false);
    expect(guideSource).not.toContain('responses-request-adapter');
  });

  it('ignored src-side JS build artifacts must not carry retired tool semantics', () => {
    const repoRoot = process.cwd();
    const forbiddenArtifacts = [
      'sharedmodule/llmswitch-core/src/servertool/followup-seed.js',
      'sharedmodule/llmswitch-core/src/servertool/followup-seed.js.map',
      'sharedmodule/llmswitch-core/src/conversion/responses/responses-openai-bridge/utils.js',
      'sharedmodule/llmswitch-core/src/conversion/responses/responses-openai-bridge/utils.js.map',
      'sharedmodule/llmswitch-core/src/conversion/responses/responses-openai-bridge/utils.d.ts',
      'sharedmodule/llmswitch-core/src/conversion/mcp-injection.js',
      'sharedmodule/llmswitch-core/src/conversion/shared/openai-message-normalize.js',
      'sharedmodule/llmswitch-core/src/conversion/shared/openai-message-normalize.js.map',
      'sharedmodule/llmswitch-core/src/conversion/shared/openai-message-normalize.d.ts',
      'sharedmodule/llmswitch-core/src/native/router-hotpath/native-shared-conversion-semantics-tools.js',
      'sharedmodule/llmswitch-core/src/native/router-hotpath/native-shared-conversion-semantics-tools.js.map',
      'sharedmodule/llmswitch-core/src/native/router-hotpath/native-shared-conversion-semantics-tools.d.ts',
    ];
    const existing = forbiddenArtifacts.filter((relativePath) => fs.existsSync(path.join(repoRoot, relativePath)));

    expect(existing).toEqual([]);
  });

  it('conversion shared source-side emit artifacts must stay deleted after proof', () => {
    const repoRoot = process.cwd();
    const forbiddenArtifacts = [
      'sharedmodule/llmswitch-core/src/conversion/bridge-actions.d.ts',
      'sharedmodule/llmswitch-core/src/conversion/bridge-instructions.d.ts',
      'sharedmodule/llmswitch-core/src/conversion/bridge-message-utils.d.ts',
      'sharedmodule/llmswitch-core/src/conversion/bridge-policies.d.ts',
      'sharedmodule/llmswitch-core/src/conversion/codecs/gemini-openai-codec.d.ts',
      'sharedmodule/llmswitch-core/src/conversion/compaction-detect.d.ts',
      'sharedmodule/llmswitch-core/src/conversion/mcp-injection.d.ts',
      'sharedmodule/llmswitch-core/src/conversion/responses/responses-host-policy.d.ts',
      'sharedmodule/llmswitch-core/src/conversion/responses/responses-openai-bridge.d.ts',
      'sharedmodule/llmswitch-core/src/conversion/responses/responses-openai-bridge/response-payload.d.ts',
      'sharedmodule/llmswitch-core/src/conversion/responses/responses-openai-bridge/types.d.ts',
      'sharedmodule/llmswitch-core/src/conversion/responses/responses-openai-bridge/types.js',
      'sharedmodule/llmswitch-core/src/conversion/runtime-metadata.d.ts',
      'sharedmodule/llmswitch-core/src/conversion/shared/openai-message-normalize-contract.d.ts',
      'sharedmodule/llmswitch-core/src/conversion/shared/openai-message-normalize-contract.js',
      'sharedmodule/llmswitch-core/src/conversion/shared/openai-message-normalize-control-text.d.ts',
      'sharedmodule/llmswitch-core/src/conversion/shared/openai-message-normalize-control-text.js',
      'sharedmodule/llmswitch-core/src/conversion/shared/openai-message-normalize-tool-history.d.ts',
      'sharedmodule/llmswitch-core/src/conversion/shared/openai-message-normalize-tool-history.js',
      'sharedmodule/llmswitch-core/src/conversion/shared/reasoning-tool-normalizer.d.ts',
      'sharedmodule/llmswitch-core/src/conversion/shared/responses-conversation-store-native.d.ts',
      'sharedmodule/llmswitch-core/src/conversion/shared/responses-conversation-store-types.d.ts',
      'sharedmodule/llmswitch-core/src/conversion/shared/responses-conversation-store-types.js',
      'sharedmodule/llmswitch-core/src/conversion/shared/responses-conversation-store.d.ts',
      'sharedmodule/llmswitch-core/src/conversion/shared/responses-conversation-store.js',
      'sharedmodule/llmswitch-core/src/conversion/shared/responses-reasoning-registry.d.ts',
      'sharedmodule/llmswitch-core/src/conversion/shared/responses-response-utils.d.ts',
      'sharedmodule/llmswitch-core/src/conversion/shared/responses-tool-utils.d.ts',
      'sharedmodule/llmswitch-core/src/conversion/shared/tool-mapping.d.ts',
      'sharedmodule/llmswitch-core/src/conversion/types.d.ts',
      'sharedmodule/llmswitch-core/src/conversion/types.js',
      'sharedmodule/llmswitch-core/src/conversion/types/bridge-message-types.js',
    ];
    const existing = forbiddenArtifacts.filter((relativePath) => fs.existsSync(path.join(repoRoot, relativePath)));

    expect(existing).toEqual([]);
  });

  it('src-side JS source maps must not remain tracked generated artifacts', () => {
    const trackedSourceMaps = execFileSync(
      'git',
      ['ls-files', ':(glob)sharedmodule/llmswitch-core/src/**/*.js.map'],
      { cwd: process.cwd(), encoding: 'utf8' }
    )
      .split('\n')
      .filter((relativePath) => relativePath && fs.existsSync(path.join(process.cwd(), relativePath)));

    expect(trackedSourceMaps).toEqual([]);
  });

  it('llmswitch-core src must not keep side-by-side TS emit artifacts', () => {
    const generatedArtifacts = walkFiles(
      path.join(process.cwd(), 'sharedmodule/llmswitch-core/src'),
      ['.js', '.d.ts', '.js.map'],
    ).map((fullPath) => path.relative(process.cwd(), fullPath).split(path.sep).join('/'));

    expect(generatedArtifacts.sort()).toEqual([]);
  });

  it('Hub and Virtual Router source truth dirs must not keep side-by-side TS emit artifacts', () => {
    const artifactRoots = [
      'sharedmodule/llmswitch-core/src/conversion/hub',
      [
        'sharedmodule/llmswitch-core',
        'src',
        'router',
        'virtual-router',
      ].join('/'),
    ];
    const generatedArtifacts: string[] = [];

    for (const relativeRoot of artifactRoots) {
      for (const fullPath of walkFiles(path.join(process.cwd(), relativeRoot), ['.js', '.d.ts', '.js.map'])) {
        generatedArtifacts.push(path.relative(process.cwd(), fullPath).split(path.sep).join('/'));
      }
    }

    expect(generatedArtifacts.sort()).toEqual([]);
  });

  it('servertool source truth dir must not keep side-by-side TS emit artifacts', () => {
    const generatedArtifacts = walkFiles(
      path.join(process.cwd(), 'sharedmodule/llmswitch-core/src/servertool'),
      ['.js', '.d.ts', '.js.map'],
    ).map((fullPath) => path.relative(process.cwd(), fullPath).split(path.sep).join('/'));

    expect(generatedArtifacts.sort()).toEqual([]);
  });

  it('active Rust closeout docs must not target retired stage wrapper APIs', () => {
    const activeDocs = [
      'docs/CHAT_PROCESS_PROTOCOL_AND_PIPELINE.md',
      'docs/audit/p0-hub-stage-residue-matrix.md',
      'docs/goals/hubpipeline-rust-closeout-goal-prompt.md',
      'docs/goals/hubpipeline-rust-closeout-master-plan.md',
    ];
    const findings: string[] = [];

    for (const relativePath of activeDocs) {
      const source = fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');
      const matches = collectMatches(source, [
        { label: 'runHubPipelineStageJson', pattern: /runHubPipelineStageJson/ },
        { label: 'run_hub_pipeline_stage_json', pattern: /run_hub_pipeline_stage_json/ },
        { label: 'runHubPipelineStageWithNative', pattern: /runHubPipelineStageWithNative/ },
        { label: 'runRespProcessStage1ToolGovernance', pattern: /runRespProcessStage1ToolGovernance/ },
        {
          label: 'resp_process_stage1_tool_governance-ts-wrapper',
          pattern: /src\/conversion\/hub\/pipeline\/stages\/resp_process\/resp_process_stage1_tool_governance\/index\.ts/,
        },
      ]);
      findings.push(...matches.map((match) => `${relativePath}:${match}`));
    }

    expect(findings).toEqual([]);
  });

  it('servertool pending-session TS persistence must not inspect tool semantics or swallow load failures', () => {
    const filePath = path.join(process.cwd(), 'sharedmodule/llmswitch-core/src/servertool/pending-session.ts');
    const source = fs.readFileSync(filePath, 'utf8');
    const findings = collectMatches(source, [
      { label: 'imports chat tool-history inspector into TS persistence', pattern: /inspectOpenAiChatToolHistory/ },
      { label: 'imports synthetic tool-call id predicate into TS persistence', pattern: /isSyntheticRouteCodexToolCallId/ },
      { label: 'validates pending injection tool semantics in TS persistence', pattern: /validatePendingInjection/ },
      { label: 'reads tool_call ids for semantic filtering in TS persistence', pattern: /afterToolCallIds[\s\S]{0,240}synthetic|tool_call_id[\s\S]{0,240}message contract/ },
      { label: 'silently swallows pending-session load failures', pattern: /catch\s*\{\s*return null;\s*\}/ },
    ]);

    expect(findings).toEqual([]);
  });

  it('legacy chat-process pending tool-sync TS helper and tests must stay removed', () => {
    const repoRoot = process.cwd();
    const forbiddenFiles = [
      'sharedmodule/llmswitch-core/src/conversion/hub/process/chat-process-pending-tool-sync.ts',
      'sharedmodule/llmswitch-core/src/conversion/hub/process/chat-process-pending-tool-sync.js',
      'sharedmodule/llmswitch-core/src/conversion/hub/process/chat-process-pending-tool-sync.d.ts',
      'tests/sharedmodule/chat-process-pending-tool-sync.spec.ts',
    ];
    const existing = forbiddenFiles.filter((relativePath) => fs.existsSync(path.join(repoRoot, relativePath)));

    expect(existing).toEqual([]);
  });

  it('shared normalize and bridge wrappers must not run TS tool-history inspectors', () => {
    const repoRoot = process.cwd();
    const files = [
      'sharedmodule/llmswitch-core/src/conversion/shared/openai-message-normalize.ts',
      'sharedmodule/llmswitch-core/src/conversion/bridge-message-utils.ts',
      'sharedmodule/llmswitch-core/src/conversion/responses/responses-openai-bridge.ts',
    ];
    const findings: string[] = [];
    for (const relativePath of files) {
      const source = fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
      for (const match of collectMatches(source, [
        { label: 'runs TS chat tool-history inspector', pattern: /inspectOpenAiChatToolHistory\s*\(/ },
        { label: 'runs TS bridge tool-history inspector', pattern: /inspectBridgeInputToolHistory\s*\(/ },
      ])) {
        findings.push(`${relativePath}:${match}`);
      }
    }

    expect(findings).toEqual([]);
  });

  it('responses bridge wrappers must not run TS synthetic control-text inspectors', () => {
    const filePath = path.join(process.cwd(), 'sharedmodule/llmswitch-core/src/conversion/responses/responses-openai-bridge.ts');
    const source = fs.readFileSync(filePath, 'utf8');
    const findings = collectMatches(source, [
      { label: 'runs TS synthetic bridge input inspector', pattern: /inspectSyntheticRouteCodexBridgeInput\s*\(/ },
      { label: 'runs TS synthetic assistant message inspector', pattern: /inspectSyntheticRouteCodexAssistantMessages\s*\(/ },
      { label: 'keeps TS synthetic bridge assertion helper', pattern: /assertNoSyntheticOrMalformedBridgeInput|assertNoSyntheticAssistantMessages/ },
    ]);

    expect(findings).toEqual([]);
  });

  it('servertool orchestration policy must not run TS synthetic control-text recursion', () => {
    const filePath = path.join(process.cwd(), 'sharedmodule/llmswitch-core/src/servertool/orchestration-policy-block.ts');
    const source = fs.readFileSync(filePath, 'utf8');
    const findings = collectMatches(source, [
      { label: 'imports TS synthetic control text helper', pattern: /isSyntheticRouteCodexControlText/ },
      { label: 'recurses over Object.values in TS synthetic scan', pattern: /Object\.values\([\s\S]*containsSyntheticRouteCodexControlText/ },
      { label: 'recurses over arrays in TS synthetic scan', pattern: /\.some\(\(entry\) => containsSyntheticRouteCodexControlText\(entry\)\)/ },
    ]);

    expect(findings).toEqual([]);
  });

  it('servertool adapter context must not backfill captured tools with TS semantics', () => {
    const filePath = path.join(process.cwd(), 'src/server/runtime/http-server/executor/servertool-adapter-context.ts');
    const source = fs.readFileSync(filePath, 'utf8');
    const findings = collectMatches(source, [
      { label: 'ts-read-tool-name', pattern: /function\s+readToolName\s*\(/ },
      { label: 'ts-replace-captured-tools', pattern: /capturedChatRequest\.tools\s*=/ },
      { label: 'ts-client-tool-name-set', pattern: /new\s+Set\([^\n]*clientToolsRaw\.map\(readToolName\)/ },
      { label: 'ts-existing-tool-name-map', pattern: /existingTools\.map\(readToolName\)/ },
    ]);

    expect(findings).toEqual([]);
  });

  it('servertool response SSE projection must use post-governance client semantic truth', () => {
    const filePath = path.join(process.cwd(), 'sharedmodule/llmswitch-core/src/conversion/hub/response/provider-response.ts');
    const source = fs.readFileSync(filePath, 'utf8');
    const findings = collectMatches(source, [
      { label: 'uses stale native streamEffect payload after servertool governance', pattern: /streamEffect\.payload/ },
      { label: 'keeps streamPipe payload as response truth in TS shell', pattern: /payload:\s*streamPayload|streamPayload\s+as\s+JsonObject/ },
      { label: 'scans raw Rust effectPlan kinds in TS shell', pattern: /effectPlan\.effects\.filter\(\(effect\)\s*=>\s*effect\?\.(?:kind|kind\s*===)/ },
      { label: 'ts-post-servertool-responses-endpoint-branch', pattern: /includes\(['"]\/v1\/responses['"]\)/ },
      { label: 'ts-post-servertool-responses-projection-owner', pattern: /buildResponsesPayloadFromChatWithNative/ },
    ]);

    expect(source).toContain('normalizeProviderResponseEffectPlanWithNative');
    expect(source).toContain('planProviderResponseServertoolRuntimeActionsWithNative');
    expect(source).toContain('projectPostServertoolHubRespOutbound04ClientSemanticWithNative');
    expect(source).toContain('const respProcessEffect = await executeProviderResponseNativeServertoolEffects');
    expect(source).toContain("hubRespOutbound04ClientSemantic = respProcessEffect.stage === 'HubRespChatProcess03Governed'");
    expect(source).toContain('codec.convertJsonToSse(hubRespOutbound04ClientSemantic');
    expect(findings).toEqual([]);
  });

  it('stop_message schema budget must not be restored from servertool loop repeat count', () => {
    const runtimeUtilsPath = path.join(
      process.cwd(),
      'sharedmodule/llmswitch-core/src/servertool/handlers/stop-message-auto/runtime-utils.ts',
    );
    const nativeWrapperPath = path.join(
      process.cwd(),
      'sharedmodule/llmswitch-core/src/native/router-hotpath/native-servertool-core-semantics.ts',
    );
    const rustLookupPath = path.join(
      process.cwd(),
      'sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/persisted_lookup.rs',
    );
    const handlerPath = path.join(
      process.cwd(),
      'sharedmodule/llmswitch-core/src/servertool/handlers/stop-message-auto.ts',
    );
    const runtimeUtilsSource = fs.readFileSync(runtimeUtilsPath, 'utf8');
    const nativeWrapperSource = fs.readFileSync(nativeWrapperPath, 'utf8');
    const rustLookupSource = fs.readFileSync(rustLookupPath, 'utf8');
    const handlerSource = fs.readFileSync(handlerPath, 'utf8');
    const runtimeStateBlock = extractFunctionBlock(runtimeUtilsSource, 'resolveRuntimeStopMessageState');
    const runtimeStageBlock = extractFunctionBlock(runtimeUtilsSource, 'readRuntimeStopMessageStageMode');
    const followupFlowBlock = extractFunctionBlock(runtimeUtilsSource, 'readServerToolFollowupFlowId');

    expect(rustLookupSource).toContain('pub fn resolve_runtime_stop_message_state');
    expect(rustLookupSource).toContain('pub fn read_servertool_followup_flow_id');
    expect(rustLookupSource).toContain('STOP_MESSAGE_FOLLOWUP_FLOW_ID');
    expect(rustLookupSource).toContain('loop_state.get("maxRepeats")');
    expect(rustLookupSource).not.toContain('loop_state.get("repeatCount")');
    expect(nativeWrapperSource).toContain('resolveRuntimeStopMessageStateWithNative');
    expect(nativeWrapperSource).toContain('readServertoolFollowupFlowIdWithNative');
    expect(runtimeStateBlock).toContain('resolveRuntimeStopMessageStateWithNative(runtimeMetadata)');
    expect(runtimeStageBlock).toContain('readRuntimeStopMessageStageModeWithNative(runtimeMetadata)');
    expect(followupFlowBlock).toContain('readServertoolFollowupFlowIdWithNative(runtimeMetadata)');
    expect(handlerSource).toContain('if (followupFlowId && followupFlowId !== FLOW_ID)');
    expect(handlerSource).toContain("reason: 'skip_servertool_followup_hop'");
    expect(handlerSource).not.toContain('stop_message_followup_policy');
    expect(handlerSource).not.toContain('preserve_eligibility');

    const runtimeFindings = collectMatches(`${runtimeStateBlock}\n${runtimeStageBlock}\n${followupFlowBlock}`, [
      { label: 'runtime stop snapshot ignores servertool loop state', pattern: /return\s+resolveStopMessageSnapshot\(state\);/ },
      { label: 'runtime stop state TS reads loop state', pattern: /serverToolLoopState|loopState\.maxRepeats|stopMessageState|stopMessageUsed|stopMessageText/ },
      { label: 'runtime stop stage TS normalizes state', pattern: /stopMessageStageMode|toLowerCase\(\)/ },
      { label: 'servertool followup flow id TS reads loop state', pattern: /serverToolLoopState|\.flowId|toNonEmptyText/ },
    ]);
    const handlerFindings = collectMatches(handlerSource, [
      { label: 'followup hop preserves stop_message eligibility', pattern: /preserve_eligibility|stop_message_followup_policy|stopMessageFollowupPolicy/ },
    ]);
    expect([...runtimeFindings, ...handlerFindings]).toEqual([]);
  });
});
