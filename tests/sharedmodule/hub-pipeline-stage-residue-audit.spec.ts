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

  it('req inbound semantic lift must not own continuation or resume restore semantics', () => {
    const crateRoot = path.join(
      process.cwd(),
      'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src',
    );
    const source = fs.readFileSync(path.join(crateRoot, 'hub_req_inbound_semantic_lift.rs'), 'utf8');
    const findings = collectMatches(source, [
      { label: 'builds continuation in req_inbound', pattern: /build_.*continuation|continuationOwner|continuationScope|toolContinuation/ },
      { label: 'stores responses resume in req_inbound', pattern: /responses_resume|responsesResume|responses\.insert|toolOutputsDetailed|mapped_tool_outputs/ },
      { label: 'maps resumed tool outputs in req_inbound', pattern: /ResumeToolOutput|map_resume_tool_outputs|payload\.insert\("toolOutputs"/ },
      { label: 'reads session scope for continuation in req_inbound', pattern: /session_id|conversation_id/ },
    ]);

    expect(source).toContain('clientToolsRaw');
    expect(source).toContain('toolNameAliasMap');
    expect(findings).toEqual([]);
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

  it('lmstudio responses input stringify residue must be physically removed', () => {
    const actionPath = path.join(
      process.cwd(),
      'sharedmodule/llmswitch-core/src/conversion/compat/actions/lmstudio-responses-input-stringify.ts',
    );
    const profilePath = path.join(
      process.cwd(),
      'sharedmodule/llmswitch-core/src/conversion/compat/profiles/chat-lmstudio.json',
    );

    expect(fs.existsSync(actionPath)).toBe(false);
    const profileSource = fs.readFileSync(profilePath, 'utf8');
    expect(profileSource).not.toContain('lmstudio_responses_input_stringify');
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

  it('zero-consumer shared conversion host wrappers must stay retired while Rust exports remain required', () => {
    const hostPath = path.join(process.cwd(), 'src/modules/llmswitch/bridge/native-exports.ts');
    const requiredExportsPath = path.join(process.cwd(), 'sharedmodule/llmswitch-core/native-hotpath-required-exports.json');
    const hostSource = fs.readFileSync(hostPath, 'utf8');
    const requiredExports = JSON.parse(fs.readFileSync(requiredExportsPath, 'utf8')) as string[];
    const retiredHostWrappers = [
      'mapChatToolsToBridgeJson',
      'injectMcpToolsForChatJson',
      'injectMcpToolsForResponsesJson',
      'buildAnthropicResponseFromChatJson',
      'stripResponsesStoredContextInputMediaNative',
    ];
    const requiredRustExports = [
      'mapChatToolsToBridgeJson',
      'injectMcpToolsForChatJson',
      'injectMcpToolsForResponsesJson',
      'buildAnthropicResponseFromChatJson',
      'stripResponsesStoredContextInputMediaJson',
    ];

    const findings = retiredHostWrappers
      .filter((symbol) => new RegExp(`export\\s+(?:async\\s+)?function\\s+${symbol}\\b`).test(hostSource));
    expect(findings).toEqual([]);
    expect(requiredExports).toEqual(expect.arrayContaining(requiredRustExports));
  });

  it('zero-consumer router-direct media forwarding shell must stay physically deleted', () => {
    const shellPath = path.join(
      process.cwd(),
      'src/server/runtime/http-server/router-direct-media-capability.ts',
    );

    expect(fs.existsSync(shellPath)).toBe(false);
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
    const hostPath = path.join(
      process.cwd(),
      'src/modules/llmswitch/bridge/provider-response-converter-host.ts',
    );
    const effectsPath = path.join(
      process.cwd(),
      'src/modules/llmswitch/bridge/provider-response-effects.ts',
    );
    const hostSource = fs.readFileSync(hostPath, 'utf8');
    const effectsSource = fs.readFileSync(effectsPath, 'utf8');
    const effectPlanRustSource = fs.readFileSync(path.join(
      process.cwd(),
      'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_lib/effect_plan.rs',
    ), 'utf8');

    expect(hostSource).toContain('executeHubPipelineWithNative');
    expect(hostSource).toContain('runProviderResponseRustHubPipeline');
    expect(hostSource).toContain('executeProviderResponseNativeOutboundEffects');
    expect(hostSource).toContain('executeProviderResponseNativeServertoolEffects');
    expect(hostSource).toContain('executeProviderResponseNativeRuntimeStateEffect');
    expect(hostSource).toContain('Server-side tool execution has been removed');
    expect(hostSource).toContain('const nativeResponsePlan = runProviderResponseRustHubPipeline(nativeOptions);');
    expect(hostSource).not.toContain('nativeResponsePlan.effectPlan.effects');
    expect(hostSource).not.toContain('__nativeResponsePlan');
    expect(hostSource).not.toContain('runtimeStateWrite');
    expect(hostSource).not.toContain('servertoolRuntimeActions');
    expect(effectsSource).toContain('nativeResponsePlan.effectPlan.effects');
    expect(effectsSource).toContain('__nativeResponsePlan');
    expect(effectsSource).toContain('runtimeStateWrite');
    expect(effectsSource).toContain('servertoolRuntimeActions');
    expect(effectsSource).toContain('executeProviderResponseNativeOutboundEffects');
    expect(effectsSource).toContain('executeProviderResponseNativeServertoolEffects');
    expect(effectsSource).toContain('executeProviderResponseNativeRuntimeStateEffect');
    expect(effectPlanRustSource).toContain('server-side tool execution has been removed');
    expect(effectPlanRustSource).toContain('CLI-owned tools must be projected by Rust');
    expect(effectsSource).not.toContain('server-side tool execution has been removed');
    expect(effectsSource).toContain('planProviderResponseServertoolRetirementEffectWithNative');
    expect(effectsSource).not.toContain('servertoolRuntimeActions.length > 0');
    expect(effectsSource).not.toContain("firstAction?.stopGateway");
    expect(effectsSource).not.toContain("reason: 'rust stop gateway control signal'");
    expect(hostSource).not.toContain('planProviderResponseServertoolRuntimeActionsWithNative');
    expect(hostSource).not.toContain('resolveProviderResponsePostServertoolEffectWithNative');
    expect(hostSource).not.toContain('runServertoolResponseStageOrchestrationShell');
    expect(hostSource).not.toContain('projectPostServertoolHubRespOutbound04ClientSemanticWithNative');
    expect(hostSource).not.toContain('shouldRunProviderResponseRustHubPipeline');
    expect(hostSource).not.toContain('if (nativeResponsePlan)');
    expect(hostSource).not.toContain('return false;');
    expect(hostSource).not.toContain('runRespInboundStage2FormatParse');
    expect(hostSource).not.toContain('runRespInboundStage3SemanticMap');
    expect(hostSource).not.toContain('runRespProcessStage1ToolGovernance');
    expect(hostSource).not.toContain('runRespProcessStage2Finalize');
    expect(hostSource).not.toContain('runRespProcessStage3ServerToolOrchestration');
    expect(hostSource).not.toContain('runRespOutboundStage1ClientRemap');
    expect(hostSource).not.toContain('OpenAIChatResponseMapper');
    expect(hostSource).not.toContain('PROVIDER_RESPONSE_REGISTRY');
    expect(hostSource).not.toContain('hasNewGovernedServerToolCalls(');
    expect(hostSource).not.toContain('if (options.providerInvoker || options.reenterPipeline || options.clientInjectDispatch) {\n    return false;');
    expect(hostSource).not.toContain('runtime.clock');
    expect(hostSource).not.toContain('runtime.webSearch');
    expect(hostSource).not.toContain('runtime.servertool');
    const providerResponseSplitSource = `${hostSource}\n${effectsSource}`;
    expect(providerResponseSplitSource).not.toContain('effectPlan.effects.length !== 1');
    const servertoolRuntimeActionFindings = collectMatches(providerResponseSplitSource, [
      { label: 'ts-servertool-action-reenter-branch', pattern: /effect\.action\s*===\s*['"]requireReenterPipeline['"]/ },
      { label: 'ts-servertool-action-runtime-branch', pattern: /effect\.action\s*===\s*['"]requireRuntimeExecutor['"]/ },
      { label: 'ts-servertool-missing-reenter-error-owner', pattern: /SERVERTOOL_FOLLOWUP_FAILED/ },
      { label: 'ts-servertool-missing-runtime-error-owner', pattern: /SERVERTOOL_HANDLER_FAILED/ },
      { label: 'ts-servertool-unsupported-action-owner', pattern: /unsupported action/ },
      { label: 'ts-servertool-action-payload-reader', pattern: /function\s+readServertoolRuntimeActionChatPayload\s*\(/ },
    ]);
    expect(servertoolRuntimeActionFindings).toEqual([]);
  });

  it('provider response TS shell must be classified as native IO shell only', () => {
    const filePath = path.join(
      process.cwd(),
      'src/modules/llmswitch/bridge/provider-response-converter-host.ts',
    );
    const nativeCallsPath = path.join(
      process.cwd(),
      'src/modules/llmswitch/bridge/provider-response-native-calls.ts',
    );
    const effectsPath = path.join(
      process.cwd(),
      'src/modules/llmswitch/bridge/provider-response-effects.ts',
    );
    const manifestPath = path.join(process.cwd(), 'docs/loops/rustification/minimal-ts-surface.json');
    const source = fs.readFileSync(filePath, 'utf8');
    const nativeCallsSource = fs.readFileSync(nativeCallsPath, 'utf8');
    const effectsSource = fs.readFileSync(effectsPath, 'utf8');
    const effectPlanRustSource = fs.readFileSync(path.join(
      process.cwd(),
      'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_lib/effect_plan.rs',
    ), 'utf8');
    const splitSources = `${source}\n${nativeCallsSource}\n${effectsSource}`;
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
      entries?: Array<{
        path?: string;
        classification?: string;
        ownerFeature?: string;
        forbiddenSemantics?: string[];
      }>;
    };
    const manifestEntry = manifest.entries?.find((entry) => entry.path === 'src/modules/llmswitch/bridge/provider-response-converter-host.ts');
    const findings = collectMatches(source, [
      { label: 'ts-local-provider-response-plan-type-owner', pattern: /interface\s+ProviderResponsePlan\b|type\s+ProviderResponsePlan\b/ },
      { label: 'ts-local-response-shape-detector', pattern: /function\s+(?:detect|is|has)[A-Za-z0-9_]*ProviderResponse[A-Za-z0-9_]*\s*\(/ },
      { label: 'ts-local-responses-endpoint-semantic-branch', pattern: /entryEndpoint[\s\S]{0,120}(?:includes|===)\s*\(?['"]\/v1\/responses['"]/ },
      { label: 'ts-local-provider-protocol-branch', pattern: /providerProtocol\s*===\s*['"][a-z0-9-]+['"]/ },
      { label: 'ts-local-effect-kind-switch', pattern: /switch\s*\([^)]*(?:effect|runtimeEffect)[^)]*(?:kind|action)[^)]*\)/ },
      { label: 'ts-local-effect-kind-if-branch', pattern: /(?:effect|runtimeEffect)\.(?:kind|action)\s*===/ },
      { label: 'ts-local-client-payload-builder', pattern: /function\s+build[A-Za-z0-9_]*(?:Client|Responses|Chat)[A-Za-z0-9_]*Payload\s*\(/ },
      { label: 'ts-local-fallback-owner', pattern: /\bfallback\b|\bcompat\b|best[- ]?effort/i },
    ]);

    expect(manifest.entries ?? []).toEqual([]);
    expect(manifestEntry).toBeUndefined();
    expect(source).toContain('executeHubPipelineWithNative');
    expect(source).not.toContain('normalizeProviderResponseEffectPlanWithNative');
    expect(nativeCallsSource).toContain('normalizeProviderResponseEffectPlanWithNative');
    expect(source).toContain('materializeProviderResponseSsePayloadWithNative');
    expect(source).not.toContain('publishResponsesRecordPlanWithNative');
    expect(nativeCallsSource).toContain('publishResponsesRecordPlanWithNative');
    expect(source).toContain('buildSseFramesFromJsonWithNative');
    expect(effectPlanRustSource).toContain('server-side tool execution has been removed');
    expect(splitSources).not.toContain('server-side tool execution has been removed');
    expect(splitSources).not.toContain('runServertoolResponseStageOrchestrationShell');
    expect(findings).toEqual([]);
  });

  it('provider response SSE marker materialization must stay Rust-owned', () => {
    const filePath = path.join(
      process.cwd(),
      'src/modules/llmswitch/bridge/provider-response-converter-host.ts',
    );
    const source = fs.readFileSync(filePath, 'utf8');
    const findings = collectMatches(source, [
      { label: 'exports internal provider SSE materializer', pattern: /export\s+async\s+function\s+materializeProviderResponseSsePayload\b/ },
      { label: 'ts-sse-body-text-reader', pattern: /function\s+readProviderResponseSseText\s*\(/ },
      { label: 'ts-sse-marker-classifier', pattern: /function\s+isProviderResponseSseMarker\s*\(/ },
      { label: 'ts-sse-marker-signal', pattern: /function\s+hasProviderSseMarkerSignal\s*\(/ },
      { label: 'ts-provider-sse-read-error-wrapper', pattern: /function\s+buildProviderSseStreamReadError\s*\(/ },
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
      { label: 'declares zero-consumer provider response options type shell', pattern: /(?:export\s+)?interface\s+ProviderResponseConversionOptions\b/ },
      { label: 'declares zero-consumer provider response result type shell', pattern: /(?:export\s+)?interface\s+ProviderResponseConversionResult\b/ },
    ]);

    expect(source).toContain('materializeProviderResponseSsePayloadWithNative');
    expect(source).toContain('async function materializeProviderResponseSsePayload');
    expect(source).toContain('buildProviderSseStreamReadErrorDescriptorWithNative');
    expect(source).toContain('readProviderResponseSseStreamText');
    expect(source).toContain('export async function convertProviderResponse');
    expect(findings).toEqual([]);
  });

  it('provider response executor helper shells must use the provider response native host', () => {
    const repoRoot = process.cwd();
    const sharedSource = fs.readFileSync(
      path.join(repoRoot, 'src/server/runtime/http-server/executor/provider-response-shared-pure-blocks.ts'),
      'utf8',
    );
    const validationSource = fs.readFileSync(
      path.join(repoRoot, 'src/server/runtime/http-server/executor/provider-response-tool-validation-blocks.ts'),
      'utf8',
    );
    const hostSource = fs.readFileSync(
      path.join(repoRoot, 'src/modules/llmswitch/bridge/provider-response-converter-host.ts'),
      'utf8',
    );
    const nativeCallsSource = fs.readFileSync(
      path.join(repoRoot, 'src/modules/llmswitch/bridge/provider-response-native-calls.ts'),
      'utf8',
    );
    const nativeHostSource = fs.readFileSync(
      path.join(repoRoot, 'src/modules/llmswitch/bridge/provider-response-native-host.ts'),
      'utf8',
    );
    const metadataProtocolTestSource = fs.readFileSync(
      path.join(repoRoot, 'tests/sharedmodule/provider-response.metadata-center-provider-protocol.spec.ts'),
      'utf8',
    );

    expect(sharedSource).toContain('../../../../modules/llmswitch/bridge/provider-response-converter-host.js');
    expect(validationSource).toContain('../../../../modules/llmswitch/bridge/provider-response-converter-host.js');
    expect(sharedSource).not.toContain('../../../../modules/llmswitch/bridge/native-exports.js');
    expect(validationSource).not.toContain('../../../../modules/llmswitch/bridge/native-exports.js');
    expect(hostSource).toContain("from './provider-response-native-host.js'");
    expect(hostSource).not.toContain("from './native-exports.js'");
    expect(nativeHostSource).toContain("from './native-exports.js'");
    expect(nativeHostSource).toContain('getProviderResponseNativeBindingSync');
    expect(metadataProtocolTestSource).toContain('src/modules/llmswitch/bridge/provider-response-native-host.js');
    expect(metadataProtocolTestSource).not.toContain('src/modules/llmswitch/bridge/native-exports.js');
    expect(hostSource).toContain("from './provider-response-native-calls.js'");
    expect(hostSource).not.toContain('asFlatRecordJson');
    expect(hostSource).not.toContain('validateCanonicalClientToolCallJson');
    expect(nativeCallsSource).toContain('asFlatRecordJson');
    expect(nativeCallsSource).toContain('validateCanonicalClientToolCallJson');
  });

  it('provider response helper shell must stay deleted after host bridge direct native wiring', () => {
    const repoRoot = process.cwd();
    const retiredHelperPath = path.join(
      repoRoot,
      'sharedmodule/llmswitch-core/src/conversion/hub/response/provider-response-helpers.ts',
    );
    const source = fs.readFileSync(
      path.join(repoRoot, 'src/modules/llmswitch/bridge/provider-response-converter-host.ts'),
      'utf8'
    );
    const nativeCallsSource = fs.readFileSync(
      path.join(repoRoot, 'src/modules/llmswitch/bridge/provider-response-native-calls.ts'),
      'utf8',
    );
    const findings = collectMatches(source, [
      { label: 'ts-client-facing-request-id-fallback', pattern: /:\s*context\.requestId\b/ },
      { label: 'ts-client-protocol-openai-chat-default', pattern: /(?:return\s*\{\s*clientProtocol\s*:\s*['"]openai-chat['"]|clientProtocol\s*=\s*['"]openai-chat['"]|clientProtocol\s*:\s*['"]openai-chat['"]\s*[,}])/ },
      { label: 'ts-client-protocol-branching-default', pattern: /resolved\.clientProtocol\s*===/ },
      { label: 'ts-display-model-trim-defaulting', pattern: /resolved\.displayModel\.trim\(\)/ },
      { label: 'exports zero-consumer client protocol type', pattern: /export\s+type\s+ClientProtocol\b/ },
      { label: 'exports zero-consumer context signals interface', pattern: /export\s+interface\s+ProviderResponseContextSignals\b/ },
    ]);

    expect(fs.existsSync(retiredHelperPath)).toBe(false);
    expect(source).toContain('resolveProviderResponseContextSignals');
    expect(source).toContain('resolveProviderResponseContextHelpersWithNative');
    expect(source).not.toContain('resolveProviderResponseContextHelpersJson');
    expect(nativeCallsSource).toContain('resolveProviderResponseContextHelpersJson');
    expect(source).not.toContain("'native/router-hotpath/native-hub-pipeline-resp-semantics'");
    expect(source).not.toContain('conversion/hub/response/provider-response-helpers');
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

  it('zero-consumer responses request-from-chat host wrapper must stay deleted', () => {
    const repoRoot = process.cwd();
    const hostSource = fs.readFileSync(
      path.join(repoRoot, 'src/modules/llmswitch/bridge/native-exports.ts'),
      'utf8',
    );
    const scriptSources = [
      'scripts/tools/responses-provider-replay.mjs',
      'sharedmodule/llmswitch-core/scripts/tests/cross-protocol-matrix.mjs',
      'sharedmodule/llmswitch-core/scripts/tests/responses-context-snapshot-no-tool-control.mjs',
      'sharedmodule/llmswitch-core/scripts/tests/responses-create-parameters-single-source.mjs',
      'sharedmodule/llmswitch-core/scripts/tests/responses-freeform-tool-args.mjs',
      'sharedmodule/llmswitch-core/scripts/tests/responses-local-image-path-autoload.mjs',
      'sharedmodule/llmswitch-core/scripts/tests/responses-request-no-parameters-wrapper.mjs',
      'sharedmodule/llmswitch-core/scripts/tests/responses-tool-choice-single-source.mjs',
      'sharedmodule/llmswitch-core/scripts/tests/responses-overlong-function-name-regression.mjs',
      'sharedmodule/llmswitch-core/scripts/tests/responses-roundtrip.mjs',
    ].map((relativePath) => fs.readFileSync(path.join(repoRoot, relativePath), 'utf8'));

    expect(hostSource).not.toContain('export function buildResponsesRequestFromChatNative');
    expect(hostSource).toContain('buildResponsesRequestFromChatJson?:');
    for (const source of scriptSources) {
      expect(source).toContain('responses-codec-direct-native.mjs');
      expect(source).not.toContain('nativeExports.buildResponsesRequestFromChatNative');
      expect(source).not.toContain('responsesBridge.buildResponsesRequestFromChatNative');
      expect(source).not.toContain('mod.buildResponsesRequestFromChatNative');
      expect(source).not.toContain("dist', 'modules', 'llmswitch', 'bridge', 'native-exports.js");
      expect(source).not.toContain('dist/modules/llmswitch/bridge/native-exports.js');
    }
  });

  it('responses-to-chat compatibility shell must use its narrow native host', () => {
    const repoRoot = process.cwd();
    const shellSource = fs.readFileSync(
      path.join(repoRoot, 'src/utils/responses-to-chat.ts'),
      'utf8',
    );
    const hostSource = fs.readFileSync(
      path.join(repoRoot, 'src/modules/llmswitch/bridge/responses-to-chat-host.ts'),
      'utf8',
    );

    expect(shellSource).toContain('../modules/llmswitch/bridge/responses-to-chat-host.js');
    expect(shellSource).not.toContain('../modules/llmswitch/bridge/native-exports.js');
    expect(hostSource).toContain("from './native-exports.js'");
    expect(hostSource).toContain('convertResponsesRequestToChatNative');
  });

  it('manager routing-state store shell must use its narrow native host', () => {
    const repoRoot = process.cwd();
    const shellSource = fs.readFileSync(
      path.join(repoRoot, 'src/manager/modules/routing/native-routing-state-store.ts'),
      'utf8',
    );
    const hostSource = fs.readFileSync(
      path.join(repoRoot, 'src/modules/llmswitch/bridge/routing-state-store-host.ts'),
      'utf8',
    );

    expect(shellSource).toContain('../../../modules/llmswitch/bridge/routing-state-store-host.js');
    expect(shellSource).not.toContain('../../../modules/llmswitch/bridge/native-exports.js');
    expect(hostSource).toContain("from './native-exports.js'");
    expect(hostSource).toContain('getRouterHotpathJsonBindingSync');
  });

  it('traffic-governor shell must use its narrow native host', () => {
    const repoRoot = process.cwd();
    const shellSource = fs.readFileSync(
      path.join(repoRoot, 'src/modules/traffic-governor/index.ts'),
      'utf8',
    );
    const hostSource = fs.readFileSync(
      path.join(repoRoot, 'src/modules/llmswitch/bridge/traffic-governor-host.ts'),
      'utf8',
    );

    expect(shellSource).toContain('../llmswitch/bridge/traffic-governor-host.js');
    expect(shellSource).not.toContain('../llmswitch/bridge/native-exports.js');
    expect(shellSource).not.toContain('../../modules/llmswitch/bridge/native-exports.js');
    expect(hostSource).toContain("from './native-exports.js'");
    expect(hostSource).toContain('getRouterHotpathJsonBindingSync');
  });

  it('mimoweb provider text-tool harvest must use its narrow native host', () => {
    const repoRoot = process.cwd();
    const providerSource = fs.readFileSync(
      path.join(repoRoot, 'src/providers/core/runtime/mimoweb/mimoweb-provider.ts'),
      'utf8',
    );
    const hostSource = fs.readFileSync(
      path.join(repoRoot, 'src/modules/llmswitch/bridge/mimoweb-tool-harvest-host.ts'),
      'utf8',
    );

    expect(providerSource).toContain('../../../../modules/llmswitch/bridge/mimoweb-tool-harvest-host.js');
    expect(providerSource).not.toContain('../../../../modules/llmswitch/bridge/native-exports.js');
    expect(hostSource).toContain("from './native-exports.js'");
    expect(hostSource).toContain('normalizeAssistantTextToToolCallsJson');
  });

  it('http request executor provider outbound sanitize must use its narrow native host', () => {
    const repoRoot = process.cwd();
    const executorSource = fs.readFileSync(
      path.join(repoRoot, 'src/providers/core/runtime/http-request-executor.ts'),
      'utf8',
    );
    const responsesProviderSource = fs.readFileSync(
      path.join(repoRoot, 'src/providers/core/runtime/responses-provider.ts'),
      'utf8',
    );
    const hostSource = fs.readFileSync(
      path.join(repoRoot, 'src/modules/llmswitch/bridge/provider-outbound-sanitize-host.ts'),
      'utf8',
    );

    expect(executorSource).toContain('../../../modules/llmswitch/bridge/provider-outbound-sanitize-host.js');
    expect(executorSource).not.toContain('../../../modules/llmswitch/bridge/native-exports.js');
    expect(responsesProviderSource).toContain('../../../modules/llmswitch/bridge/provider-outbound-sanitize-host.js');
    expect(responsesProviderSource).not.toContain('../../../modules/llmswitch/bridge/native-exports.js');
    expect(hostSource).toContain("from './native-exports.js'");
    expect(hostSource).toContain('sanitizeProviderOutboundPayload');
    expect(hostSource).toContain('normalizeResponsesDirectCurrentRequestPayload');
  });

  it('request executor route availability must use its narrow native host', () => {
    const repoRoot = process.cwd();
    const executorSource = fs.readFileSync(
      path.join(repoRoot, 'src/server/runtime/http-server/executor/request-executor-core-utils.ts'),
      'utf8',
    );
    const hostSource = fs.readFileSync(
      path.join(repoRoot, 'src/modules/llmswitch/bridge/route-availability-host.ts'),
      'utf8',
    );

    expect(executorSource).toContain('../../../../modules/llmswitch/bridge/route-availability-host.js');
    expect(executorSource).not.toContain('../../../../modules/llmswitch/bridge/native-exports.js');
    expect(hostSource).toContain("from './native-exports.js'");
    expect(hostSource).toContain('evaluateSingletonRoutePoolExhaustionNative');
    expect(hostSource).toContain('planPrimaryExhaustedToDefaultPoolNative');
    expect(hostSource).toContain('resolveErrorErr05RouteAvailabilityDecisionNative');
  });

  it('handler request-executor unified semantics test must mock narrow native hosts only', () => {
    const repoRoot = process.cwd();
    const testSource = fs.readFileSync(
      path.join(repoRoot, 'tests/server/handlers/handler-request-executor.unified-semantics.e2e.spec.ts'),
      'utf8',
    );

    expect(testSource).not.toContain('src/modules/llmswitch/bridge/native-exports.js');
    expect(testSource).not.toContain('src/modules/llmswitch/bridge/native-exports.ts');
    expect(testSource).not.toContain('src/modules/llmswitch/bridge/native-exports\'');
    expect(testSource).toContain('responses-request-handler-host');
    expect(testSource).toContain('responses-client-projection-host');
    expect(testSource).toContain('sse-projection-host');
    expect(testSource).toContain('snapshot-hooks-host');
    expect(testSource).toContain('executor-metadata-host');
    expect(testSource).toContain('route-availability-host');
    expect(testSource).toContain('provider-outbound-sanitize-host');
  });

  it('request executor retry execution decision must use its narrow native host', () => {
    const repoRoot = process.cwd();
    const executorSource = fs.readFileSync(
      path.join(repoRoot, 'src/server/runtime/http-server/executor/request-executor-retry-execution-plan.ts'),
      'utf8',
    );
    const hostSource = fs.readFileSync(
      path.join(repoRoot, 'src/modules/llmswitch/bridge/error-execution-decision-host.ts'),
      'utf8',
    );

    expect(executorSource).toContain('../../../../modules/llmswitch/bridge/error-execution-decision-host.js');
    expect(executorSource).not.toContain('../../../../modules/llmswitch/bridge/native-exports.js');
    expect(hostSource).toContain("from './native-exports.js'");
    expect(hostSource).toContain("from './route-availability-host.js'");
    expect(hostSource).toContain('resolveProviderRetryExecutionPolicyNative');
    expect(hostSource).toContain('resolveErrorErr05RouteAvailabilityDecisionNative');
  });

  it('request retry helper rate-limit matching must use the error decision host', () => {
    const repoRoot = process.cwd();
    const retrySource = fs.readFileSync(
      path.join(repoRoot, 'src/server/runtime/http-server/executor/request-retry-helpers.ts'),
      'utf8',
    );
    const hostSource = fs.readFileSync(
      path.join(repoRoot, 'src/modules/llmswitch/bridge/error-execution-decision-host.ts'),
      'utf8',
    );

    expect(retrySource).toContain('../../../../modules/llmswitch/bridge/error-execution-decision-host.js');
    expect(retrySource).not.toContain('../../../../modules/llmswitch/bridge/native-exports.js');
    expect(retrySource).not.toContain('RATE_LIMIT_ERROR_CODE_HINTS');
    expect(retrySource).not.toContain('RATE_LIMIT_MESSAGE_HINTS');
    expect(hostSource).toContain('isRateLimitLikeErrorJson');
  });

  it('request executor pipeline attempt route-pool helpers must use their narrow host', () => {
    const repoRoot = process.cwd();
    const attemptSource = fs.readFileSync(
      path.join(repoRoot, 'src/server/runtime/http-server/executor/request-executor-pipeline-attempt.ts'),
      'utf8',
    );
    const hostSource = fs.readFileSync(
      path.join(repoRoot, 'src/modules/llmswitch/bridge/request-executor-pipeline-attempt-host.ts'),
      'utf8',
    );

    expect(attemptSource).toContain('../../../../modules/llmswitch/bridge/request-executor-pipeline-attempt-host.js');
    expect(attemptSource).not.toContain('../../../../modules/llmswitch/bridge/native-exports.js');
    expect(hostSource).toContain("from './native-exports.js'");
    expect(hostSource).toContain('normalizeExplicitRoutePoolNative');
    expect(hostSource).toContain('mergeObservedRoutePoolChainNative');
  });

  it('request executor pipeline native helpers must stay behind routing integrations host', () => {
    const repoRoot = process.cwd();
    const executorSource = fs.readFileSync(
      path.join(repoRoot, 'src/server/runtime/http-server/executor-pipeline.ts'),
      'utf8',
    );
    const routingSource = fs.readFileSync(
      path.join(repoRoot, 'src/modules/llmswitch/bridge/routing-integrations.ts'),
      'utf8',
    );
    const hostSource = fs.readFileSync(
      path.join(repoRoot, 'src/modules/llmswitch/bridge/routing-native-host.ts'),
      'utf8',
    );
    const stageRecorderTestSource = fs.readFileSync(
      path.join(repoRoot, 'tests/server/runtime/http-server/executor/executor-pipeline.stage-recorder.spec.ts'),
      'utf8',
    );

    expect(executorSource).toContain('../../../modules/llmswitch/bridge/routing-integrations.js');
    expect(executorSource).not.toContain('../../../modules/llmswitch/bridge/native-exports.js');
    expect(routingSource).toContain("from './routing-native-host.js'");
    expect(routingSource).not.toContain("from './native-exports.js'");
    expect(hostSource).toContain("from './native-exports.js'");
    expect(hostSource).toContain('buildRequestStageRuntimeControlWritePlanNative');
    expect(hostSource).toContain('resolveEntryProtocolFromEndpointNative');
    expect(stageRecorderTestSource).toContain('src/modules/llmswitch/bridge/routing-integrations.js');
    expect(stageRecorderTestSource).not.toContain('src/modules/llmswitch/bridge/native-exports.js');
  });

  it('executor metadata native helpers must use the executor metadata host', () => {
    const repoRoot = process.cwd();
    const executorSource = fs.readFileSync(
      path.join(repoRoot, 'src/server/runtime/http-server/executor-metadata.ts'),
      'utf8',
    );
    const hostSource = fs.readFileSync(
      path.join(repoRoot, 'src/modules/llmswitch/bridge/executor-metadata-host.ts'),
      'utf8',
    );
    const metadataCenterContractSource = fs.readFileSync(
      path.join(repoRoot, 'tests/server/runtime/http-server/request-executor.metadata-center.contract.spec.ts'),
      'utf8',
    );

    expect(executorSource).toContain('../../../modules/llmswitch/bridge/executor-metadata-host.js');
    expect(executorSource).not.toContain('../../../modules/llmswitch/bridge/native-exports.js');
    expect(hostSource).toContain("from './native-exports.js'");
    expect(hostSource).toContain('extractSessionIdentifiersFromMetadataNative');
    expect(hostSource).toContain('extractServertoolCliResultRouteHintFromRequestNative');
    expect(metadataCenterContractSource).toContain('src/modules/llmswitch/bridge/executor-metadata-host.js');
    expect(metadataCenterContractSource).toContain('src/modules/llmswitch/bridge/request-executor-pipeline-attempt-host.js');
    expect(metadataCenterContractSource).toContain('src/modules/llmswitch/bridge/route-availability-host.js');
    expect(metadataCenterContractSource).toContain('src/modules/llmswitch/bridge/provider-response-converter-host.js');
    expect(metadataCenterContractSource).not.toContain('src/modules/llmswitch/bridge/native-exports.js');
    expect(metadataCenterContractSource).not.toContain('src/modules/llmswitch/bridge/native-exports');
  });

  it('server response handler Responses client projection uses its narrow native host', () => {
    const repoRoot = process.cwd();
    const handlerSource = fs.readFileSync(
      path.join(repoRoot, 'src/server/handlers/handler-response-utils.ts'),
      'utf8',
    );
    const hostSource = fs.readFileSync(
      path.join(repoRoot, 'src/modules/llmswitch/bridge/responses-client-projection-host.ts'),
      'utf8',
    );

    expect(handlerSource).toContain('../../modules/llmswitch/bridge/responses-client-projection-host.js');
    expect(handlerSource).not.toContain('../../modules/llmswitch/bridge/native-exports.js');
    expect(hostSource).toContain("from './native-exports.js'");
    expect(hostSource).toContain('buildResponsesPayloadFromChatNative');
    expect(hostSource).toContain('planResponsesJsonClientDispatchNative');
    expect(hostSource).toContain('projectResponsesClientPayloadForClientNative');
  });

  it('server response handler tests mock narrow native hosts instead of broad native exports', () => {
    const repoRoot = process.cwd();
    const testPaths = [
      'tests/server/handlers/handler-response-utils.force-sse-json-responses.spec.ts',
      'tests/server/handlers/handler-response-utils.prestart-client-close-guard.spec.ts',
      'tests/server/handlers/handler-response-utils.request-context-resolution.spec.ts',
      'tests/server/handlers/handler-response-utils.responses-keepalive-protocol.spec.ts',
      'tests/server/handlers/handler-response-utils.sse-usage-log.spec.ts',
      'tests/server/handlers/responses-handler.submit-tool-outputs.responses-provider.spec.ts',
      'tests/server/handlers/responses-handler.submit-tool-outputs.sse-error.spec.ts',
      'tests/server/handlers/sse-projection-timeout.blackbox.spec.ts',
    ];

    for (const relativePath of testPaths) {
      const source = fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
      expect(source).not.toContain('src/modules/llmswitch/bridge/native-exports');
      expect(source).toContain('src/modules/llmswitch/bridge/responses-client-projection-host.js');
      expect(source).toContain('src/modules/llmswitch/bridge/sse-projection-host.js');
    }
  });

  it('responses submit_tool_outputs handler tests mock continuation owner hosts, not broad native exports', () => {
    const repoRoot = process.cwd();
    const responsesProviderSource = fs.readFileSync(
      path.join(repoRoot, 'tests/server/handlers/responses-handler.submit-tool-outputs.responses-provider.spec.ts'),
      'utf8',
    );
    const sseErrorSource = fs.readFileSync(
      path.join(repoRoot, 'tests/server/handlers/responses-handler.submit-tool-outputs.sse-error.spec.ts'),
      'utf8',
    );

    expect(responsesProviderSource).toContain('src/modules/llmswitch/bridge/responses-request-handler-host.js');
    expect(responsesProviderSource).toContain('src/modules/llmswitch/bridge/executor-metadata-host.js');
    expect(responsesProviderSource).toContain('src/modules/llmswitch/bridge/config-integrations.js');
    expect(responsesProviderSource).not.toContain('src/modules/llmswitch/bridge/native-exports');
    expect(responsesProviderSource).not.toContain('createNativeExportsMock');

    expect(sseErrorSource).toContain('src/modules/llmswitch/bridge/responses-request-bridge.js');
    expect(sseErrorSource).toContain('src/modules/llmswitch/bridge/executor-metadata-host.js');
    expect(sseErrorSource).toContain('src/modules/llmswitch/bridge/config-integrations.js');
    expect(sseErrorSource).not.toContain('src/modules/llmswitch/bridge/native-exports');
    expect(sseErrorSource).not.toContain('createNativeExportsMock');
  });

  it('provider and manager runtime tests mock owner native hosts instead of broad native exports', () => {
    const repoRoot = process.cwd();
    const testCases = [
      {
        path: 'tests/providers/runtime/responses-provider.direct-passthrough.spec.ts',
        hosts: [
          'src/modules/llmswitch/bridge/provider-outbound-sanitize-host.js',
          'src/modules/llmswitch/bridge/responses-to-chat-host.js',
        ],
      },
      {
        path: 'tests/manager/routing/native-routing-state-store.spec.ts',
        hosts: [
          'src/modules/llmswitch/bridge/routing-state-store-host.js',
        ],
      },
    ];

    for (const testCase of testCases) {
      const source = fs.readFileSync(path.join(repoRoot, testCase.path), 'utf8');
      expect(source).not.toContain('src/modules/llmswitch/bridge/native-exports');
      for (const host of testCase.hosts) {
        expect(source).toContain(host);
      }
    }
  });

  it('responses request bridge uses request-handler host instead of broad native exports', () => {
    const repoRoot = process.cwd();
    const bridgeSource = fs.readFileSync(
      path.join(repoRoot, 'src/modules/llmswitch/bridge/responses-request-bridge.ts'),
      'utf8',
    );
    const hostSource = fs.readFileSync(
      path.join(repoRoot, 'src/modules/llmswitch/bridge/responses-request-handler-host.ts'),
      'utf8',
    );
    const testPaths = [
      'tests/modules/llmswitch/bridge/responses-request-bridge.metadata-center.spec.ts',
      'tests/modules/llmswitch/bridge/responses-request-bridge.request-context-normalization.spec.ts',
      'tests/modules/llmswitch/bridge/responses-request-bridge.tool-history-errorsample.spec.ts',
    ];

    expect(bridgeSource).toContain("from './responses-request-handler-host.js'");
    expect(bridgeSource).not.toContain("from './native-exports.js'");
    expect(hostSource).toContain("from './native-exports.js'");
    expect(hostSource).toContain('planResponsesHandlerEntry');
    expect(hostSource).toContain('captureReqInboundResponsesContextSnapshotJson');
    for (const relativePath of testPaths) {
      const source = fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
      expect(source).not.toContain('src/modules/llmswitch/bridge/native-exports');
      expect(source).toContain('src/modules/llmswitch/bridge/responses-request-handler-host.js');
    }
  });

  it('runtime integrations use owner native hosts instead of broad native exports', () => {
    const repoRoot = process.cwd();
    const runtimeSource = fs.readFileSync(
      path.join(repoRoot, 'src/modules/llmswitch/bridge/runtime-integrations.ts'),
      'utf8',
    );
    const snapshotTestSource = fs.readFileSync(
      path.join(repoRoot, 'tests/modules/llmswitch/bridge/runtime-integrations.snapshot.spec.ts'),
      'utf8',
    );

    expect(runtimeSource).not.toContain('from "./native-exports.js"');
    expect(runtimeSource).not.toContain("from './native-exports.js'");
    expect(runtimeSource).toContain("from \"./snapshot-hooks-host.js\"");
    expect(runtimeSource).toContain("from './sse-runtime-host.js'");
    expect(runtimeSource).toContain("from './provider-runtime-ingress-host.js'");
    expect(snapshotTestSource).not.toContain('src/modules/llmswitch/bridge/native-exports');
    expect(snapshotTestSource).toContain('src/modules/llmswitch/bridge/snapshot-hooks-host.js');
  });

  it('routing integrations use routing native host instead of broad native exports', () => {
    const repoRoot = process.cwd();
    const routingSource = fs.readFileSync(
      path.join(repoRoot, 'src/modules/llmswitch/bridge/routing-integrations.ts'),
      'utf8',
    );
    const routingTestSource = fs.readFileSync(
      path.join(repoRoot, 'tests/modules/llmswitch/bridge/routing-integrations.native-error.spec.ts'),
      'utf8',
    );
    const runtimeIngressTestSource = fs.readFileSync(
      path.join(repoRoot, 'tests/sharedmodule/hub-pipeline-runtime-ingress.spec.ts'),
      'utf8',
    );
    const metadataCenterTestSource = fs.readFileSync(
      path.join(repoRoot, 'tests/sharedmodule/hub-pipeline.metadata-center-provider-protocol.spec.ts'),
      'utf8',
    );

    expect(routingSource).not.toContain("from './native-exports.js'");
    expect(routingSource).toContain("from './routing-native-host.js'");
    expect(routingTestSource).not.toContain('src/modules/llmswitch/bridge/native-exports');
    expect(routingTestSource).toContain('src/modules/llmswitch/bridge/routing-native-host.js');
    expect(runtimeIngressTestSource).not.toContain('src/modules/llmswitch/bridge/native-exports');
    expect(runtimeIngressTestSource).toContain('src/modules/llmswitch/bridge/routing-native-host.js');
    expect(metadataCenterTestSource).not.toContain('src/modules/llmswitch/bridge/native-exports');
    expect(metadataCenterTestSource).toContain('src/modules/llmswitch/bridge/routing-native-host.js');
  });

  it('SSE event payload wrapper shells must stay deleted after direct Rust NAPI tests', () => {
    const repoRoot = process.cwd();
    const retiredPaths = [
      'sharedmodule/llmswitch-core/src/native/router-hotpath/native-chat-sse-event-payload.ts',
      'sharedmodule/llmswitch-core/src/native/router-hotpath/native-anthropic-sse-event-payload.ts',
      'sharedmodule/llmswitch-core/src/native/router-hotpath/native-gemini-sse-event-payload.ts',
      'sharedmodule/llmswitch-core/src/native/router-hotpath/native-responses-sse-event-payload.ts',
    ];
    const existingRetiredPaths = retiredPaths.filter((relativePath) => fs.existsSync(path.join(repoRoot, relativePath)));
    const sourceRoots = [
      path.join(repoRoot, 'src'),
      path.join(repoRoot, 'sharedmodule/llmswitch-core/src'),
    ];
    const references: string[] = [];

    for (const root of sourceRoots) {
      for (const fullPath of walkFiles(root, ['.ts', '.tsx', '.js', '.jsx', '.d.ts'])) {
        const relativePath = path.relative(repoRoot, fullPath).split(path.sep).join('/');
        if (retiredPaths.includes(relativePath)) {
          continue;
        }
        const source = fs.readFileSync(fullPath, 'utf8');
        for (const retiredPath of retiredPaths) {
          const withoutExtension = retiredPath.replace(/\.ts$/, '');
          const basename = path.basename(withoutExtension);
          if (source.includes(withoutExtension) || source.includes(basename)) {
            references.push(`${relativePath} -> ${basename}`);
          }
        }
      }
    }

    expect(existingRetiredPaths).toEqual([]);
    expect(references).toEqual([]);
  });

  it('standardized bridge runtime shell must stay physically deleted', () => {
    expect(
      fs.existsSync(path.join(process.cwd(), 'sharedmodule/llmswitch-core/src/conversion/hub/standardized-bridge.ts')),
    ).toBe(false);
  });

  it('anthropic response runtime must not restore response semantics in TS', () => {
    const filePath = path.join(
      process.cwd(),
      'sharedmodule/llmswitch-core/src/conversion/hub/response/response-runtime-anthropic.ts',
    );

    expect(fs.existsSync(filePath)).toBe(false);
    expect(fs.existsSync(
      path.join(process.cwd(), 'sharedmodule/llmswitch-core/src/conversion/hub/response/response-runtime.ts'),
    )).toBe(false);
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
    const retiredPath = path.join(
      process.cwd(),
      'sharedmodule/llmswitch-core/src/conversion/shared/responses-response-utils.ts',
    );
    const retiredNativePath = path.join(
      process.cwd(),
      'sharedmodule/llmswitch-core/src/native/router-hotpath/native-shared-conversion-semantics.ts',
    );
    const hostNativeSource = fs.readFileSync(
      path.join(process.cwd(), 'src/modules/llmswitch/bridge/native-exports.ts'),
      'utf8',
    );

    expect(fs.existsSync(retiredPath)).toBe(false);
    expect(fs.existsSync(retiredNativePath)).toBe(false);
    expect(fs.existsSync(path.join(process.cwd(), 'sharedmodule/llmswitch-core/src/conversion/responses/responses-openai-bridge.ts'))).toBe(false);
    expect(hostNativeSource).not.toContain('buildChatResponseFromResponsesNative');
  });

  it('native exports must not restore the Phase 3 servertool wrapper fan-out', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src/modules/llmswitch/bridge/native-exports.ts'),
      'utf8',
    );
    const forbidden = [
      'SERVERTOOL ORCHESTRATION WRAPPERS',
      'SERVERTOOL CORE BRIDGE WRAPPERS',
      'servertool-core bridge:',
      'export function inspectStopGatewaySignalWithNative',
      'export function resolveRuntimeStopMessageStateWithNative',
      'export function planServertoolEnginePreflightWithNative',
      'export function resolveServertoolExecutionLoopInitialDecisionWithNative',
      'planStoplessCliProjectionContextWithNative',
      'runServertoolResponseStageWithNative',
      'buildServertoolDispatchPlanInputWithNative',
      'readServertoolPrimaryAutoHookIdsWithNative',
      'webSearchIsGeminiEngineWithNative',
      'visionBuildAnalysisPayloadWithNative',
    ];

    for (const token of forbidden) {
      expect(source).not.toContain(token);
    }
  });

  it('responses response payload bridge must call native pipeline without TS wrapper or swallowed errors', () => {
    const retiredPath = path.join(
      process.cwd(),
      'sharedmodule/llmswitch-core/src/conversion/responses/responses-openai-bridge/response-payload.ts',
    );
    const hostNative = fs.readFileSync(
      path.join(process.cwd(), 'src/modules/llmswitch/bridge/native-exports.ts'),
      'utf8',
    );
    const findings = collectMatches(hostNative, [
      { label: 'uses TS bridge action state wrapper', pattern: /createBridgeActionState/ },
      { label: 'uses TS bridge action pipeline wrapper', pattern: /runBridgeActionPipeline\(/ },
      { label: 'keeps response outbound bridge action owner in TS', pattern: /runBridgeActionPipelineWithNative/ },
      { label: 'swallows response outbound bridge action errors', pattern: /bridge action pipeline failed/ },
      { label: 'keeps ignored bridge logging failure catch', pattern: /ignore logging failures/ },
    ]);

    expect(fs.existsSync(retiredPath)).toBe(false);
    expect(fs.existsSync(path.join(process.cwd(), 'sharedmodule/llmswitch-core/src/conversion/responses/responses-openai-bridge.ts'))).toBe(false);
    expect(hostNative).toContain('buildResponsesPayloadFromChatNative');
    expect(findings).toEqual([]);
  });

  it('responses response payload reasoning normalization must be native fail-fast', () => {
    const retiredPath = path.join(
      process.cwd(),
      'sharedmodule/llmswitch-core/src/conversion/responses/responses-openai-bridge/response-payload.ts',
    );
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src/modules/llmswitch/bridge/native-exports.ts'),
      'utf8',
    );
    const findings = collectMatches(source, [
      { label: 'uses shared TS reasoning normalizer wrapper', pattern: /normalizeMessageReasoningTools\b/ },
      { label: 'keeps response reasoning pre-normalization owner in TS', pattern: /normalizeMessageReasoningToolsWithNative/ },
      { label: 'keeps chat response reasoning pre-normalization owner in TS', pattern: /normalizeChatResponseReasoningToolsWithNative/ },
      { label: 'keeps best-effort reasoning swallow comment', pattern: /best-effort reasoning normalization/ },
      { label: 'swallows reasoning normalization errors', pattern: /catch\s*\{\s*\/\/ best-effort reasoning normalization/s },
    ]);

    expect(fs.existsSync(retiredPath)).toBe(false);
    expect(fs.existsSync(path.join(process.cwd(), 'sharedmodule/llmswitch-core/src/conversion/responses/responses-openai-bridge.ts'))).toBe(false);
    expect(source).toContain('buildResponsesPayloadFromChatNative');
    expect(findings).toEqual([]);
  });

  it('responses request bridge must not own action filtering policy in TS', () => {
    const filePath = path.join(
      process.cwd(),
      'sharedmodule/llmswitch-core/src/conversion/responses/responses-openai-bridge.ts',
    );
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it('responses bridge utils facade must stay physically deleted and main bridge must call native helpers', () => {
    const retiredPath = path.join(
      process.cwd(),
      'sharedmodule/llmswitch-core/src/conversion/responses/responses-openai-bridge/utils.ts',
    );
    const source = fs.readFileSync(
      path.join(process.cwd(), 'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_bridge_actions/history.rs'),
      'utf8',
    );
    expect(fs.existsSync(retiredPath)).toBe(false);
    expect(fs.existsSync(path.join(process.cwd(), 'sharedmodule/llmswitch-core/src/conversion/responses/responses-openai-bridge.ts'))).toBe(false);
    expect(source).toContain('pick_responses_request_parameters');
    expect(source).toContain('pick_responses_tool_passthrough_fields');
    expect(source).toContain('extract_responses_metadata_extra_fields');
    expect(source).toContain('strip_responses_tool_control_fields');
    expect(source).toContain('merge_retained_responses_request_parameters');
  });

  it('responses bridge files must not import deleted TS bridge wrappers', () => {
    const files: string[] = [];
    expect(fs.existsSync(path.join(
      process.cwd(),
      'sharedmodule/llmswitch-core/src/conversion/responses/responses-openai-bridge/response-payload.ts',
    ))).toBe(false);
    expect(fs.existsSync(path.join(
      process.cwd(),
      'sharedmodule/llmswitch-core/src/conversion/responses/responses-openai-bridge.ts',
    ))).toBe(false);
    const findings = files.flatMap((relativePath) => {
      const source = fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');
      return collectMatches(source, [
        { label: `${relativePath} imports TS bridge-policies wrapper`, pattern: /bridge-policies\.js/ },
      ]);
    });

    expect(findings).toEqual([]);
  });

  it('responses retention registry wrapper must fail fast on native errors', () => {
    const retiredPath = path.join(
      process.cwd(),
      'sharedmodule/llmswitch-core/src/conversion/shared/responses-reasoning-registry.ts',
    );
    expect(fs.existsSync(retiredPath)).toBe(false);
    const retiredRespWrapperPath = path.join(
      process.cwd(),
      'sharedmodule/llmswitch-core/src/native/router-hotpath/native-hub-pipeline-resp-semantics-outbound-tools.ts',
    );
    expect(fs.existsSync(retiredRespWrapperPath)).toBe(false);
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

  it('retired hub pipeline orchestration protocol wrapper must stay test-only', () => {
    const productionWrapperPath = path.join(
      process.cwd(),
      'sharedmodule/llmswitch-core/src/native/router-hotpath/native-hub-pipeline-orchestration-semantics-protocol.ts',
    );
    const helperPath = path.join(
      process.cwd(),
      'tests/sharedmodule/helpers/hub-pipeline-orchestration-direct-native.ts',
    );
    const requiredExportsPath = path.join(
      process.cwd(),
      'sharedmodule/llmswitch-core/native-hotpath-required-exports.json',
    );
    const wrapperSource = fs.readFileSync(helperPath, 'utf8');
    const requiredExportsSource = fs.readFileSync(requiredExportsPath, 'utf8');

    expect(fs.existsSync(productionWrapperPath)).toBe(false);
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

  it('retired provider runtime ingress TS wrapper must stay deleted', () => {
    const retiredPath = path.join(
      process.cwd(),
      'sharedmodule/llmswitch-core/src/native/router-hotpath/native-provider-runtime-ingress.ts',
    );

    expect(fs.existsSync(retiredPath)).toBe(false);
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

  it('compat engine runtime shell must stay physically deleted', () => {
    const repoRoot = process.cwd();
    const retiredTypePath = path.join(
      repoRoot,
      'sharedmodule/llmswitch-core/src/conversion/hub/pipeline/compat/compat-types.ts',
    );
    const enginePath = path.join(
      repoRoot,
      'sharedmodule/llmswitch-core/src/conversion/hub/pipeline/compat/compat-engine.ts',
    );

    expect(fs.existsSync(retiredTypePath)).toBe(false);
    expect(fs.existsSync(enginePath)).toBe(false);
    expect(
      fs.existsSync(path.join(repoRoot, 'sharedmodule/llmswitch-core/src/conversion/hub/pipeline/compat/native-adapter-context.ts')),
    ).toBe(false);
  });

  it('public conversion barrel and root TypeScript barrel must stay deleted', () => {
    const conversionIndexPath = path.join(
      process.cwd(),
      'sharedmodule/llmswitch-core/src/conversion/index.ts',
    );
    const rootIndexPath = path.join(process.cwd(), 'sharedmodule/llmswitch-core/src/index.ts');
    const rootIndexSource = fs.existsSync(rootIndexPath) ? fs.readFileSync(rootIndexPath, 'utf8') : '';

    const findings = [
      ...collectMatches(rootIndexSource, [
        {
          label: 'restores conversion barrel',
          pattern: /conversion\/index/,
        },
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
    ];

    expect(fs.existsSync(conversionIndexPath)).toBe(false);
    expect(fs.existsSync(path.join(process.cwd(), 'sharedmodule/llmswitch-core/src/native/router-hotpath/native-chat-request-filter-semantics.ts'))).toBe(false);
    expect(rootIndexSource).not.toContain("export { convertProviderResponse } from './conversion/hub/response/provider-response.js';");
    expect(rootIndexSource).not.toContain("export * from './telemetry/stats-center.js';");
    expect(rootIndexSource).not.toContain("export * from './native/router-hotpath/native-virtual-router-bootstrap-config.js';");
    expect(rootIndexSource).not.toContain("export * from './native/router-hotpath/native-provider-runtime-ingress.js';");
    expect(rootIndexSource).not.toContain("export * from './native/router-hotpath/native-router-hotpath-loader.js';");
    expect(rootIndexSource).not.toContain("export * from './native/router-hotpath/virtual-router-contracts.js';");
    expect(rootIndexSource).not.toContain('runStandardChatRequestFilters');
    expect(fs.existsSync(path.join(process.cwd(), 'sharedmodule/llmswitch-core/src/conversion/shared/chat-request-filters.ts'))).toBe(false);
    expect(fs.existsSync(path.join(process.cwd(), 'sharedmodule/llmswitch-core/src/conversion/snapshot-utils.ts'))).toBe(false);
    expect(fs.existsSync(rootIndexPath)).toBe(false);
    expect(findings).toEqual([]);
  });

  it('format-adapters public surface must stay deleted after StageRecorder type owner merge', () => {
    const repoRoot = process.cwd();
    const retiredPath = path.join(repoRoot, 'sharedmodule/llmswitch-core/src/conversion/hub/format-adapters/index.ts');

    const liveSourceRoots = [
      path.join(repoRoot, 'sharedmodule/llmswitch-core/src'),
      path.join(repoRoot, 'tests'),
      path.join(repoRoot, 'scripts'),
    ];
    const staleImports: string[] = [];
    for (const root of liveSourceRoots) {
      for (const fullPath of walkFiles(root, ['.ts', '.tsx', '.js', '.mjs'])) {
        const source = fs.readFileSync(fullPath, 'utf8');
        if (/from\s+['"][^'"]*(?:conversion\/hub\/format-adapters|format-adapters\/index\.js)['"]/.test(source)) {
          staleImports.push(path.relative(repoRoot, fullPath));
        }
      }
    }

    expect(fs.existsSync(retiredPath)).toBe(false);
    expect(staleImports).toEqual([]);
    expect(fs.existsSync(path.join(repoRoot, 'sharedmodule/llmswitch-core/src/servertool/types.d.ts'))).toBe(false);
  });

  it('HubPipeline zero-consumer pipeline type shell must stay physically deleted', () => {
    const retiredPath = path.join(
      process.cwd(),
      'sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-types.ts',
    );

    expect(fs.existsSync(retiredPath)).toBe(false);
  });

  it('hub json type surface must stay physically deleted', () => {
    const filePath = path.join(process.cwd(), 'sharedmodule/llmswitch-core/src/conversion/hub/types/json.d.ts');

    expect(fs.existsSync(filePath)).toBe(false);
  });

  it('bridge instructions TS facade must stay physically deleted', () => {
    const filePath = path.join(process.cwd(), 'sharedmodule/llmswitch-core/src/conversion/bridge-instructions.ts');

    expect(fs.existsSync(filePath)).toBe(false);
  });

  it('provider protocol error TS facade must stay physically deleted', () => {
    const filePath = path.join(process.cwd(), 'sharedmodule/llmswitch-core/src/conversion/provider-protocol-error.ts');

    expect(fs.existsSync(filePath)).toBe(false);
  });

  it('servertool progress file shell must not retain zero-consumer event type shell', () => {
    const progressFilePath = path.join(process.cwd(), 'sharedmodule/llmswitch-core/src/servertool/log/progress-file.ts');

    expect(fs.existsSync(progressFilePath)).toBe(false);
  });

  it('servertool progress log block must not retain zero-consumer event type shell', () => {
    expect(
      fs.existsSync(path.join(process.cwd(), 'sharedmodule/llmswitch-core/src/servertool/progress-log-block.ts')),
    ).toBe(false);
  });

  it('stats center shell must stay physically deleted', () => {
    expect(
      fs.existsSync(path.join(process.cwd(), 'sharedmodule/llmswitch-core/src/telemetry/stats-center.ts')),
    ).toBe(false);
  });

  it('runtime user data paths shell must not export legacy read-only helpers', () => {
    expect(
      fs.existsSync(path.join(process.cwd(), 'sharedmodule/llmswitch-core/src/runtime/user-data-paths.ts')),
    ).toBe(false);
  });

  it('sharedmodule snapshot recorder runtime shell must stay physically deleted', () => {
    expect(
      fs.existsSync(path.join(process.cwd(), 'sharedmodule/llmswitch-core/src/conversion/hub/snapshot-recorder.ts')),
    ).toBe(false);
  });

  it('snapshot native production wrapper must stay physically deleted', () => {
    expect(
      fs.existsSync(path.join(process.cwd(), 'sharedmodule/llmswitch-core/src/native/router-hotpath/native-snapshot-hooks.ts')),
    ).toBe(false);
  });

  it('host snapshot stage recorder must only expose factory bridge API', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src/modules/llmswitch/bridge/snapshot-recorder.ts'),
      'utf8',
    );
    const hostSource = fs.readFileSync(
      path.join(process.cwd(), 'src/modules/llmswitch/bridge/snapshot-hooks-host.ts'),
      'utf8',
    );
    const snapshotTestSource = fs.readFileSync(
      path.join(process.cwd(), 'tests/sharedmodule/snapshot-recorder-native-plan.spec.ts'),
      'utf8',
    );
    const retiredCoverageScript = path.join(
      process.cwd(),
      'sharedmodule/llmswitch-core/scripts/tests/coverage-hub-snapshot-hooks-utils-recorder.mjs',
    );
    const findings = collectMatches(source, [
      { label: 'exports internal recorder options', pattern: /export\s+interface\s+SnapshotStageRecorderOptions\b/ },
      { label: 'exports internal recorder class', pattern: /export\s+class\s+SnapshotStageRecorder\b/ },
    ]);

    expect(findings).toEqual([]);
    expect(fs.existsSync(retiredCoverageScript)).toBe(false);
    expect(source).toContain('export async function createSnapshotRecorder');
    expect(source).toContain("from './snapshot-hooks-host.js'");
    expect(source).not.toContain("from './native-exports.js'");
    expect(hostSource).toContain("from './native-exports.js'");
    expect(hostSource).toContain('getSnapshotHooksNativeBindingSync');
    expect(snapshotTestSource).toContain('src/modules/llmswitch/bridge/snapshot-hooks-host.js');
    expect(snapshotTestSource).not.toContain('src/modules/llmswitch/bridge/native-exports.js');
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
    const conversionIndexPath = path.join(sourceRoot, 'index.ts');
    const conversionIndexSource = fs.existsSync(conversionIndexPath)
      ? fs.readFileSync(conversionIndexPath, 'utf8')
      : '';
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

    expect(files).toEqual([]);
  });

  it('legacy hub feature runtime switch must be physically removed', () => {
    const repoRoot = process.cwd();
    const deletedFiles = [
      'sharedmodule/llmswitch-core/src/conversion/hub/hub-feature.ts',
      'sharedmodule/llmswitch-core/src/conversion/hub/hub-feature.js',
      'sharedmodule/llmswitch-core/src/conversion/hub/hub-feature.d.ts',
    ].filter((relativePath) => fs.existsSync(path.join(repoRoot, relativePath)));
    expect(deletedFiles).toEqual([]);
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

  it('bridge action wrapper file must stay physically deleted after native pipeline takeover', () => {
    const filePath = path.join(process.cwd(), 'sharedmodule/llmswitch-core/src/conversion/bridge-actions.ts');
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it('bridge policy wrapper file must stay physically deleted after native pipeline takeover', () => {
    const filePath = path.join(process.cwd(), 'sharedmodule/llmswitch-core/src/conversion/bridge-policies.ts');
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it('bridge policy wrapper must not retain TS action descriptor parsers', () => {
    const filePath = path.join(
      process.cwd(),
      'sharedmodule/llmswitch-core/src/native/router-hotpath/native-hub-bridge-policy-semantics.ts'
    );
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it('servertool followup must not add standalone TS helper files during Rust closeout', () => {
    const legacyFiles = [
      'sharedmodule/llmswitch-core/src/servertool/followup-captured-tool-outputs.ts',
      'sharedmodule/llmswitch-core/src/servertool/backend-route-origin-delta.ts',
    ];
    const existingFiles = legacyFiles.filter((relativePath) => fs.existsSync(path.join(process.cwd(), relativePath)));

    expect(existingFiles).toEqual([]);
  });

  it('servertool followup seed must not retain TS payload or tool semantics', () => {
    const filePath = path.join(process.cwd(), 'sharedmodule/llmswitch-core/src/servertool/backend-route-seed.ts');
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it('servertool followup dispatch and backend route shells must not coerce tool semantics in TS', () => {
    const deletedFiles = [
      'sharedmodule/llmswitch-core/src/servertool/backend-route-shape-guard.ts',
      'sharedmodule/llmswitch-core/src/servertool/backend-route-response-block.ts',
      'sharedmodule/llmswitch-core/src/servertool/backend-route-reenter-block.ts',
      'sharedmodule/llmswitch-core/src/servertool/backend-route-runtime-block.ts',
      'tests/server/handlers/responses-handler.servertool-backend-route.dual-port.blackbox.spec.ts',
    ];
    const files = [
      'src/server/runtime/http-server/executor/servertool-followup-dispatch.ts',
    ];
    const existingDeletedFiles = deletedFiles.filter((relativePath) => fs.existsSync(path.join(process.cwd(), relativePath)));
    const findings = files.flatMap((relativePath) => {
      const filePath = path.join(process.cwd(), relativePath);
      if (!fs.existsSync(filePath)) {
        return [];
      }
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
    const deletedFiles = [
      'sharedmodule/llmswitch-core/src/servertool/handlers/web-search.ts',
      'sharedmodule/llmswitch-core/src/servertool/handlers/followup-sanitize.ts',
    ];
    const files = [
      'sharedmodule/llmswitch-core/src/servertool/handlers/vision-eligibility.ts',
    ];
    const existingDeletedFiles = deletedFiles.filter((relativePath) => fs.existsSync(path.join(process.cwd(), relativePath)));
    const findings = files.flatMap((relativePath) => {
      const filePath = path.join(process.cwd(), relativePath);
      if (!fs.existsSync(filePath)) {
        return [];
      }
      const source = fs.readFileSync(filePath, 'utf8');
      return collectMatches(source, [
        { label: `${relativePath}: appends Responses tool_outputs in TS`, pattern: /tool_outputs\s*=|tool_outputs\s*\?/ },
        { label: `${relativePath}: emits tool_call_id in TS`, pattern: /tool_call_id\s*:/ },
        { label: `${relativePath}: scans or mutates assistant tool_calls in TS`, pattern: /messageRow\.tool_calls|delete\s+messageRow\.tool_calls|\.filter\(\(call\)/ },
      ]);
    });

    expect({ existingDeletedFiles, findings }).toEqual({ existingDeletedFiles: [], findings: [] });
  });

  it('request executor request-semantics leaf wrapper must stay physically deleted', () => {
    const filePath = path.join(
      process.cwd(),
      'src/server/runtime/http-server/executor/request-executor-request-semantics.ts',
    );
    expect(fs.existsSync(filePath)).toBe(false);
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
      { label: 'checks required_action in TS', pattern: /required_action/ },
      { label: 'checks tool-result-like response content in TS', pattern: /tool_result|function_call_output|tool_message/ },
    ]);

    expect(findings).toEqual([]);
  });

  it('server response handler must not classify response tool continuation in TS', () => {
    const filePath = path.join(process.cwd(), 'src/server/runtime/http-server/index.ts');
    const source = fs.readFileSync(filePath, 'utf8');
    const helperStart = source.indexOf('private async persistOrClearResponsesDirectContinuation');
    expect(helperStart).toBeGreaterThanOrEqual(0);
    const helperEnd = source.indexOf('private async buildRouterDirectResult', helperStart);
    expect(helperEnd).toBeGreaterThan(helperStart);
    const helperBody = source.slice(helperStart, helperEnd);
    const findings = collectMatches(helperBody, [
      { label: 'exports TS response continuation classifier', pattern: /export function isToolCallContinuationResponseForHttp/ },
      { label: 'exports TS response continuation probe inspector', pattern: /export function inspectResponsesContinuationProbeForHttp/ },
      { label: 'derives tool_calls finish reason in TS', pattern: /deriveFinishReason\([^)]*\)\s*===\s*['"]tool_calls['"]/ },
      { label: 'checks required_action in TS', pattern: /required_action/ },
      { label: 'checks output function calls in TS', pattern: /function_call/ },
    ]);
    expect(helperBody).toContain('isToolCallContinuationResponseNative(args.responseBody)');
    expect(findings).toEqual([]);
  });

  it('server response handler SSE contract probe must not classify response tool semantics in TS', () => {
    const retiredFilePath = path.join(process.cwd(), 'src/modules/llmswitch/bridge/responses-stream-semantics.ts');
    const sseFiles = [
      'src/server/handlers/handler-response-sse.ts',
    ];
    const findings: string[] = [];
    for (const relativePath of sseFiles) {
      const source = fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');
      findings.push(...collectMatches(source, [
        { label: `${relativePath}: restores SSE contract probe owner`, pattern: /updateResponsesContractProbeFromSseChunkForHttp|inspectResponsesTerminalStateFromSseChunkForHttp/ },
        { label: `${relativePath}: imports native probe semantics directly`, pattern: /updateResponsesContractProbeFromSseChunkNative|buildResponsesTerminalSseFramesFromProbeNative/ },
        { label: `${relativePath}: checks required_action in TS SSE probe`, pattern: /required_action|response\.required_action/ },
        { label: `${relativePath}: maps output call_id in TS SSE probe`, pattern: /call_id|output_item/ },
        { label: `${relativePath}: deduplicates output items in TS SSE probe`, pattern: /alreadyExists|existingCallId|existingId/ },
      ]));
    }
    expect(fs.existsSync(retiredFilePath)).toBe(false);
    expect(findings).toEqual([]);
  });

  it('server response handler terminal probe frames must not be owned by SSE transport', () => {
    const retiredFilePath = path.join(process.cwd(), 'src/modules/llmswitch/bridge/responses-stream-semantics.ts');
    const sseFiles = [
      'src/modules/llmswitch/bridge/native-exports.ts',
      'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/lib.rs',
      'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/shared_responses_response_utils.rs',
    ];
    const findings: string[] = [];
    for (const relativePath of sseFiles) {
      const source = fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');
      findings.push(...collectMatches(source, [
        { label: `${relativePath}: terminal probe frame builder`, pattern: /buildResponsesTerminalSseFramesFromProbe/ },
        { label: `${relativePath}: terminal probe public NAPI builder`, pattern: /buildResponsesTerminalSseFramesFromProbeJson|build_responses_terminal_sse_frames_from_probe_json/ },
        { label: `${relativePath}: terminal probe state inspector`, pattern: /inspectResponsesTerminalStateFromSseChunk/ },
      ]));
    }
    expect(fs.existsSync(retiredFilePath)).toBe(false);
    expect(findings).toEqual([]);
  });

  it('server response handler Responses apply_patch client projection must stay native-owned', () => {
    const filePath = path.join(process.cwd(), 'src/server/handlers/handler-response-utils.ts');
    const source = fs.readFileSync(filePath, 'utf8');
    const findings = collectMatches(source, [
      { label: 'ts apply_patch function-call conversion helper', pattern: /convertApplyPatchFunctionCallsToCustomToolCalls/ },
      { label: 'ts apply_patch freeform argument parser', pattern: /normalizeApplyPatchFreeformInputForClient|JSON\.parse\(argumentsText\)/ },
      { label: 'ts apply_patch freeform tool detector', pattern: /isResponsesApplyPatchFreeformTool|record\.name\s*===\s*['"]apply_patch['"]/ },
      { label: 'ts apply_patch SSE map-state owner', pattern: /new Map\(\)|new Set\(\)/ },
      { label: 'ts SSE projection fallback writes original frame', pattern: /catch[\s\S]{0,260}writeClientSseFrame\(frame,\s*errorLabel/ },
      { label: 'ts frame heuristic decides projection necessity', pattern: /frame\.includes\(['"]apply_patch['"]\)|frame\.includes\(['"]function_call['"]\)|frame\.includes\(['"]required_action['"]\)/ },
    ]);
    expect(source).toContain('prepareResponsesJsonClientDispatchPlanForHttp');
    expect(findings).toEqual([]);
  });

  it('server response handler client-visible response restore must stay native-owned', () => {
    const filePath = path.join(process.cwd(), 'src/server/handlers/handler-response-utils.ts');
    const source = fs.readFileSync(filePath, 'utf8');
    const findings = collectMatches(source, [
      { label: 'ts client visible restore context type', pattern: /ClientVisibleResponseRestoreContext/ },
      { label: 'ts client visible restore context builder', pattern: /buildClientVisibleResponseRestoreContext/ },
      { label: 'ts client visible response payload restore helper', pattern: /restoreClientVisibleResponsePayload/ },
      { label: 'ts extracts client model for response restore', pattern: /extractClientModelId/ },
      { label: 'ts restores reasoning effort in client response', pattern: /reasoningEffort|reasoning\.effort|currentReasoning\.effort/ },
    ]);
    expect(source).toContain('prepareResponsesJsonClientDispatchPlanForHttp');
    expect(findings).toEqual([]);
  });

  it('responses JSON client dispatch plan must be native-owned', () => {
    const filePath = path.join(process.cwd(), 'src/server/handlers/handler-response-utils.ts');
    const source = fs.readFileSync(filePath, 'utf8');
    const findings = collectMatches(source, [
      { label: 'ts direct continuation dispatch branch', pattern: /continuationOwner\s*={0,2}={1,2}\s*['"]direct['"]/ },
      { label: 'ts JSON client dispatch action synthesis', pattern: /action:\s*['"](?:direct_passthrough|project_client_payload)['"]/ },
    ]);

    expect(source).toContain('planResponsesJsonClientDispatchNative');
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
    const findings = collectMatches(source, [
      { label: 'TS derives finish repair from required_action', pattern: /deriveFinishReason\(|buildResponsesTerminalSseFramesFromProbeNative|isResponsesRequiredActionFrame|response\.required_action/ },
    ]);

    expect(findings).toEqual([]);
  });

  it('servertool followup response block must not classify tool-bearing client payloads in TS', () => {
    const filePath = path.join(
      process.cwd(),
      'sharedmodule/llmswitch-core/src/servertool/backend-route-response-block.ts',
    );
    expect(fs.existsSync(filePath)).toBe(false);
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

  it('bridge snapshot recorder tool failures shell must stay physically deleted', () => {
    const filePath = path.join(process.cwd(), 'src/modules/llmswitch/bridge/snapshot-recorder-tool-failures.ts');
    expect(fs.existsSync(filePath)).toBe(false);
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

  it('servertool orchestration blocks helper must stay physically deleted', () => {
    const filePath = path.join(process.cwd(), 'sharedmodule/llmswitch-core/src/servertool/orchestration-blocks.ts');
    expect(fs.existsSync(filePath)).toBe(false);
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
    expect(fs.existsSync(path.join(pipelineRoot, 'hub-pipeline-execute-request-stage.ts'))).toBe(false);
    const helperSource = fs.readFileSync(
      path.join(process.cwd(), 'tests/sharedmodule/helpers/request-stage-direct-native.ts'),
      'utf8',
    );
    expect(helperSource).toContain('runHubPipelineLibWithNative');
    expect(helperSource).toContain('buildRequestStageMetadataDispatchWithNative');
    const findings = collectMatches(helperSource, [
      { label: 'requires request stage hooks', pattern: /requireRequestStageHooks/ },
      { label: 'passes hooks into request stage', pattern: /hooks:/ },
      { label: 'createSemanticMapper residue', pattern: /createSemanticMapper/ },
      { label: 'createFormatAdapter residue', pattern: /createFormatAdapter/ },
      { label: 'SemanticMapper type residue', pattern: /\bSemanticMapper\b/ },
      { label: 'mapper toChat call residue', pattern: /\.toChat\s*\(/ },
      { label: 'mapper fromChat call residue', pattern: /\.fromChat\s*\(/ },
    ]);

    expect(findings).toEqual([]);
  });

  it('request-stage bridge must not retain legacy metadataCenter or __rt compatibility residue', () => {
    const retiredFilePath = path.join(
      process.cwd(),
      'sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-execute-request-stage.ts',
    );
    expect(fs.existsSync(retiredFilePath)).toBe(false);
    const source = fs.readFileSync(
      path.join(process.cwd(), 'tests/sharedmodule/helpers/request-stage-direct-native.ts'),
      'utf8',
    );
    expect(source).toContain('buildRequestStageMetadataDispatchWithNative');
    expect(source).toContain('buildRequestStageRuntimeControlWritePlanWithNative');
    expect(source).toContain('buildRequestStageNativeResultPlanWithNative');
    const findings = collectMatches(source, [
      { label: 'legacy __metadataCenter fallback residue', pattern: /__metadataCenter/ },
      { label: 'legacy __rt read/write residue', pattern: /metadata\.__rt|__rt\s*=/ },
      { label: 'legacy runtime whitelist helper residue', pattern: /projectLegacyRuntimeControlWhitelist|readRuntimeMetadataControl/ },
      { label: 'TS request-stage legacy metadata stripper residue', pattern: /stripLegacyMetadataResidue|Object\.entries\(metadata\)/ },
      { label: 'TS request-stage metadata snapshot builder residue', pattern: /buildMetadataCenterSnapshot|runtimeControlSnapshot|excludedProviderKeys\s*=\s*Array\.isArray/ },
      { label: 'TS request-stage runtime_control object narrowing residue', pattern: /function\s+asFlatRecord\s*\(|Object\.keys\(runtimeControl\)/ },
      { label: 'TS request-stage native success discriminator residue', pattern: /nativePlan\.success/ },
      { label: 'TS request-stage malformed request status projection residue', pattern: /MALFORMED_REQUEST/ },
      { label: 'TS request-stage provider payload shape validation residue', pattern: /returned invalid provider payload/ },
    ]);

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
      'sharedmodule/llmswitch-core/src/native/router-hotpath/native-hub-pipeline-resp-semantics-types.ts',
      'sharedmodule/llmswitch-core/src/native/router-hotpath/native-hub-bridge-action-semantics-types.ts',
      'sharedmodule/llmswitch-core/src/conversion/types/text-markup-normalizer.ts',
      'sharedmodule/llmswitch-core/src/native/router-hotpath/native-router-hotpath-analysis.ts',
      'sharedmodule/llmswitch-core/src/native/router-hotpath/native-router-hotpath.ts',
    ];

    const existingFiles = legacyFiles.filter((relativePath) => fs.existsSync(path.join(pipelineRoot, relativePath)));
    const existingTests = legacyTests.filter((relativePath) => fs.existsSync(path.join(testRoot, relativePath)));
    const existingRetiredFiles = retiredFiles.filter((relativePath) => fs.existsSync(path.join(repoRoot, relativePath)));
    const requiredExports = fs.readFileSync(
      path.join(repoRoot, 'sharedmodule/llmswitch-core/native-hotpath-required-exports.json'),
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
    for (const source of [requiredExports]) {
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

    expect(existingFiles).toEqual([]);
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
    const retiredEntry = path.join(pipelineRoot, 'hub-pipeline-execute-chat-process-entry.ts');
    expect(fs.existsSync(retiredEntry)).toBe(false);
    expect(fs.existsSync(path.join(pipelineRoot, 'hub-pipeline-execute-request-stage.ts'))).toBe(false);
    const mainlineSource = fs.readFileSync(
      path.join(process.cwd(), 'tests/sharedmodule/helpers/request-stage-direct-native.ts'),
      'utf8',
    );

    expect(mainlineSource).toContain('runHubPipelineLibWithNative');
    const findings = [
      ...collectMatches(mainlineSource, [
        { label: 'requires request stage hooks', pattern: /requireRequestStageHooks/ },
        { label: 'executes TS route outbound', pattern: /executeRouteAndBuildOutbound/ },
        { label: 'runs TS governance phase', pattern: /executeChatProcessGovernancePhase/ },
        { label: 'creates TS semantic mapper', pattern: /createSemanticMapper/ },
        { label: 'imports TS route outbound file', pattern: /hub-pipeline-route-and-outbound\.js/ },
      ]).map((match) => `hub-pipeline-execute-request-stage.ts:${match}`),
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
      'sharedmodule/llmswitch-core/src/conversion/hub/metadata-center-runtime-control-writer.ts',
      'sharedmodule/llmswitch-core/dist/conversion/hub/metadata-center-runtime-control-writer.js',
      'sharedmodule/llmswitch-core/dist/conversion/hub/metadata-center-runtime-control-writer.d.ts',
      'sharedmodule/llmswitch-core/dist/conversion/hub/metadata-center-runtime-control-writer.js.map',
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
    const retiredAggregateWrapperPath =
      'sharedmodule/llmswitch-core/src/native/router-hotpath/native-hub-pipeline-orchestration-semantics.ts';
    const retiredMetadataPolicyWrapperPath =
      'sharedmodule/llmswitch-core/src/native/router-hotpath/native-hub-pipeline-orchestration-semantics-metadata-policy.ts';
    const retiredBuildersWrapperPath =
      'sharedmodule/llmswitch-core/src/native/router-hotpath/native-hub-pipeline-orchestration-semantics-builders.ts';
    const scannedFiles = [
      'tests/sharedmodule/helpers/hub-pipeline-orchestration-direct-native.ts',
      'sharedmodule/llmswitch-core/native-hotpath-required-exports.json',
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

    expect(fs.existsSync(path.join(repoRoot, retiredAggregateWrapperPath))).toBe(false);
    expect(fs.existsSync(path.join(repoRoot, retiredMetadataPolicyWrapperPath))).toBe(false);
    expect(fs.existsSync(path.join(repoRoot, retiredBuildersWrapperPath))).toBe(false);

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
    const retiredSessionIdentifierWrapperPath =
      'sharedmodule/llmswitch-core/src/native/router-hotpath/native-hub-pipeline-session-identifiers-semantics.ts';
    const scannedFiles = [
      'sharedmodule/llmswitch-core/native-hotpath-required-exports.json',
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

    expect(fs.existsSync(path.join(repoRoot, retiredSessionIdentifierWrapperPath))).toBe(false);

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
    const retiredAggregateWrapperPath =
      'sharedmodule/llmswitch-core/src/native/router-hotpath/native-hub-pipeline-orchestration-semantics.ts';
    const scannedFiles = [
      'sharedmodule/llmswitch-core/native-hotpath-required-exports.json',
      'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline.rs',
      'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_blocks/napi_bindings.rs',
    ];
    const retiredSymbols = [
      'findMappableSemanticsKeysWithNative',
      'findMappableSemanticsKeysJson',
      'find_mappable_semantics_keys_json',
    ];
    const findings: string[] = [];

    expect(fs.existsSync(path.join(repoRoot, retiredAggregateWrapperPath))).toBe(false);

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
      'sharedmodule/llmswitch-core/native-hotpath-required-exports.json',
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
      'sharedmodule/llmswitch-core/src/native/router-hotpath/native-hub-pipeline-semantic-mappers.ts',
      'sharedmodule/llmswitch-core/src/native/router-hotpath/native-rcc-fence-semantics.ts',
    ];
    const existingRetiredFiles = retiredFiles.filter((relativePath) => fs.existsSync(path.join(repoRoot, relativePath)));
    expect(existingRetiredFiles).toEqual([]);

    const scannedFiles = [
      'sharedmodule/llmswitch-core/native-hotpath-required-exports.json',
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
    const retiredReqProcessWrapperPath =
      'sharedmodule/llmswitch-core/src/native/router-hotpath/native-hub-pipeline-req-process-semantics.ts';
    const scannedFiles = [
      'sharedmodule/llmswitch-core/native-hotpath-required-exports.json',
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

    expect(fs.existsSync(path.join(repoRoot, retiredReqProcessWrapperPath))).toBe(false);

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
    expect(fs.existsSync(path.join(
      repoRoot,
      'sharedmodule/llmswitch-core/src/native/router-hotpath/native-virtual-router-bootstrap-providers.ts',
    ))).toBe(false);
    expect(fs.existsSync(path.join(
      repoRoot,
      'sharedmodule/llmswitch-core/src/native/router-hotpath/native-virtual-router-stop-message-semantics.ts',
    ))).toBe(false);
    const scannedFiles = [
      'sharedmodule/llmswitch-core/native-hotpath-required-exports.json',
      'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/lib.rs',
      'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_stop_message_instruction.rs',
      'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_stop_message_actions.rs',
    ];
    const retiredSymbols = [
      'bootstrapProviderProfilesWithNative',
      'bootstrapVirtualRouterProviderProfilesJson',
      'bootstrap_virtual_router_provider_profiles_json_bridge',
      'bootstrapVirtualRouterRoutingJson',
      'bootstrap_virtual_router_routing_json_bridge',
      'bootstrapVirtualRouterConfigMetaJson',
      'bootstrap_virtual_router_config_meta_json_bridge',
      'parseStopMessageInstructionWithNative',
      'StopMessageNativeParseOutput',
      'parseStopMessageInstructionJson',
      'applyStopMessageInstructionJson',
      '#[napi]\npub(crate) fn parse_stop_message_instruction_json',
      '#[napi]\npub fn parse_stop_message_instruction_json',
      '#[napi]\npub fn apply_stop_message_instruction_json',
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
    const retiredWrapperPath = path.join(
      repoRoot,
      'sharedmodule/llmswitch-core/src/native/router-hotpath/native-hub-pipeline-edge-stage-semantics.ts'
    );
    const scannedFiles = [
      'sharedmodule/llmswitch-core/src/native/router-hotpath/native-hub-pipeline-edge-stage-semantics.ts',
      'sharedmodule/llmswitch-core/native-hotpath-required-exports.json',
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

    expect(fs.existsSync(retiredWrapperPath)).toBe(false);
    expect(findings).toEqual([]);
  });

  it('retired SSE stats/timeout public wrappers must stay deleted from TS and Rust exports', () => {
    const repoRoot = process.cwd();
    const scannedFiles = [
      'sharedmodule/llmswitch-core/src/native/router-hotpath/native-hub-pipeline-resp-semantics-inbound-tools.ts',
      'sharedmodule/llmswitch-core/native-hotpath-required-exports.json',
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
      'sharedmodule/llmswitch-core/native-hotpath-required-exports.json',
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
      'sharedmodule/llmswitch-core/native-hotpath-required-exports.json',
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

  it('resp native parser facade must stay physically deleted', () => {
    const repoRoot = process.cwd();
    const parserPath = path.join(
      repoRoot,
      'sharedmodule/llmswitch-core/src/native/router-hotpath/native-hub-pipeline-resp-semantics-parsers.ts'
    );
    const inboundSplitPath = path.join(
      repoRoot,
      'sharedmodule/llmswitch-core/src/native/router-hotpath/native-hub-pipeline-resp-semantics-inbound-tools.ts'
    );
    const outboundSplitPath = path.join(
      repoRoot,
      'sharedmodule/llmswitch-core/src/native/router-hotpath/native-hub-pipeline-resp-semantics-outbound-tools.ts'
    );
    const aggregatePath = path.join(
      repoRoot,
      'sharedmodule/llmswitch-core/src/native/router-hotpath/native-hub-pipeline-resp-semantics.ts'
    );
    const source = fs.readFileSync(
      path.join(repoRoot, 'tests/sharedmodule/helpers/resp-semantics-direct-native.ts'),
      'utf8'
    );
    const outboundSource = source;
    const forbiddenPatterns = [
      { label: 'imports deleted parser facade', pattern: /native-hub-pipeline-resp-semantics-parsers/u },
      { label: 'alias map key/value normalization', pattern: /Object\.entries\([\s\S]{0,240}trimmedKey/u },
      { label: 'context diagnostics numeric flooring', pattern: /estimatedPromptTokens[\s\S]{0,240}Math\.floor/u },
      { label: 'SSE descriptor code enum validation', pattern: /code\s*!==\s*['"]SSE_DECODE_ERROR['"]/u },
      { label: 'provider SSE descriptor stage validation', pattern: /requestExecutorProviderErrorStage\s*!==\s*['"]provider\.sse_decode['"]/u },
      { label: 'Responses host policy target trimming', pattern: /targetProtocol[\s\S]{0,180}\.trim\(\)/u },
      { label: 'Responses SSE state array element validation', pattern: /\.every\(\(value\)\s*=>\s*typeof value === ['"]string['"]\)/u },
      { label: 'Anthropic stop reason normalization', pattern: /normalized:\s*row\.normalized\.trim\(\)\.toLowerCase\(\)/u },
      { label: 'provider tool summary name filtering', pattern: /toolNames[\s\S]{0,260}\.filter\(\(name\)/u },
      { label: 'provider context protocol enum validation', pattern: /clientProtocol\s*!==\s*['"]openai-chat['"]/u },
    ];
    const findings = forbiddenPatterns
      .filter(({ pattern }) => pattern.test(source) || pattern.test(outboundSource))
      .map(({ label }) => label);

    expect(fs.existsSync(parserPath)).toBe(false);
    expect(fs.existsSync(inboundSplitPath)).toBe(false);
    expect(fs.existsSync(outboundSplitPath)).toBe(false);
    expect(fs.existsSync(aggregatePath)).toBe(false);
    expect(findings).toEqual([]);
  });

  it('req outbound native parser facade must stay physically deleted', () => {
    const repoRoot = process.cwd();
    const parserPath = path.join(
      repoRoot,
      'sharedmodule/llmswitch-core/src/native/router-hotpath/native-hub-pipeline-req-outbound-semantics-parsers.ts'
    );
    const aggregateWrapperPath = path.join(
      repoRoot,
      'sharedmodule/llmswitch-core/src/native/router-hotpath/native-hub-pipeline-req-outbound-semantics.ts'
    );
    const source = fs.readFileSync(path.join(repoRoot, 'tests/sharedmodule/helpers/compat-engine-direct-native.ts'), 'utf8');
    const forbiddenPatterns = [
      { label: 'imports deleted parser facade', pattern: /native-hub-pipeline-req-outbound-semantics-parsers/u },
      { label: 'payload object validation', pattern: /const payloadRaw = row\.payload/u },
      { label: 'appliedProfile trimming', pattern: /appliedProfileRaw[\s\S]{0,180}\.trim\(\)/u },
      { label: 'nativeApplied boolean validation', pattern: /typeof nativeAppliedRaw !== ['"]boolean['"]/u },
      { label: 'local compat output rebuild', pattern: /return\s*\{\s*payload,[\s\S]{0,180}nativeApplied/u },
      { label: 'zero-consumer boolean parser surface', pattern: /function parseBoolean\(/u },
    ];
    const findings = forbiddenPatterns
      .filter(({ pattern }) => pattern.test(source))
      .map(({ label }) => label);

    expect(fs.existsSync(parserPath)).toBe(false);
    expect(fs.existsSync(aggregateWrapperPath)).toBe(false);
    expect(findings).toEqual([]);
  });

  it('req inbound native parser facade and aggregate wrapper must stay physically deleted', () => {
    const repoRoot = process.cwd();
    const parserPath = path.join(
      repoRoot,
      'sharedmodule/llmswitch-core/src/native/router-hotpath/native-hub-pipeline-req-inbound-semantics-parsers.ts'
    );
    const toolsWrapperPath = path.join(
      repoRoot,
      'sharedmodule/llmswitch-core/src/native/router-hotpath/native-hub-pipeline-req-inbound-semantics-tools.ts'
    );
    const aggregateWrapperPath = path.join(
      repoRoot,
      'sharedmodule/llmswitch-core/src/native/router-hotpath/native-hub-pipeline-req-inbound-semantics.ts'
    );

    expect(fs.existsSync(parserPath)).toBe(false);
    expect(fs.existsSync(toolsWrapperPath)).toBe(false);
    expect(fs.existsSync(aggregateWrapperPath)).toBe(false);
  });

  it('exec_command hardcoded guard rules must be native-owned', () => {
    const repoRoot = process.cwd();
    const validatorPath = path.join(repoRoot, 'sharedmodule/llmswitch-core/src/tools/exec-command/validator.ts');
    expect(fs.existsSync(validatorPath)).toBe(false);

    const requiredExportsSource = fs.readFileSync(
      path.join(repoRoot, 'sharedmodule/llmswitch-core/native-hotpath-required-exports.json'),
      'utf8'
    );
    expect(requiredExportsSource).toContain('"normalizeExecCommandArgsJson"');
    expect(requiredExportsSource).toContain('"validateCanonicalClientToolCallJson"');
    expect(requiredExportsSource).toContain('"validateExecCommandGuardJson"');

    const forbiddenValidatorPatterns = [
      { label: 'git reset hard TS regex', pattern: /GIT_RESET_HARD_PATTERN/u },
      { label: 'git checkout TS regex', pattern: /GIT_CHECKOUT_PATTERN/u },
      { label: 'git checkout TS evaluator', pattern: /function evaluateGitCheckoutScope/u },
      { label: 'shell token splitter for checkout scope', pattern: /function splitShellTokens/u },
      { label: 'TS shell wrapper shape detector', pattern: /function detectInvalidShellWrapperShape/u },
      { label: 'TS shell wrapper repair helper', pattern: /function repairZeroAmbiguityShellWrapper/u },
      { label: 'TS wrapped shell extraction policy helper', pattern: /function extractWrappedShellCommand/u },
      { label: 'TS policy rule loader', pattern: /function loadPolicyRules/u },
      { label: 'TS policy regex rule type', pattern: /type ExecCommandGuardRule/u },
      { label: 'TS policy regex construction', pattern: /new RegExp\(pattern/u },
      { label: 'TS policy violation evaluator', pattern: /function detectPolicyRuleViolation/u },
      { label: 'TS policy violation orchestrator', pattern: /function detectPolicyViolation/u },
      { label: 'hardcoded git reset reason in TS', pattern: /forbidden_git_reset_hard/u },
      { label: 'hardcoded git checkout reason in TS', pattern: /forbidden_git_checkout_scope/u },
    ];
    const scanRoots = [
      'sharedmodule/llmswitch-core/src/tools',
      'tests/sharedmodule/helpers',
      'scripts/helpers',
    ];
    const findings = [
      ...scanRoots.flatMap((root) => {
        const rootPath = path.join(repoRoot, root);
        if (!fs.existsSync(rootPath)) return [];
        return walkFiles(rootPath, ['.ts', '.js', '.mjs'])
          .flatMap((filePath) => {
            const source = fs.readFileSync(filePath, 'utf8');
            const relativePath = path.relative(repoRoot, filePath);
            return forbiddenValidatorPatterns
              .filter(({ pattern }) => pattern.test(source))
              .map(({ label }) => `${relativePath}:${label}`);
          });
      }),
    ];

    expect(findings).toEqual([]);
  });

  it('tool registry aggregate TS shell must stay physically deleted', () => {
    const repoRoot = process.cwd();
    const shellPath = path.join(repoRoot, 'sharedmodule/llmswitch-core/src/tools/tool-registry.ts');
    const refRoots = [
      'sharedmodule/llmswitch-core/src',
      'scripts',
      'tests',
      'docs/architecture',
    ];
    const findings: string[] = [];
    for (const root of refRoots) {
      const rootPath = path.join(repoRoot, root);
      if (!fs.existsSync(rootPath)) continue;
      for (const filePath of walkFiles(rootPath, ['.ts', '.js', '.mjs', '.md', '.yml', '.json'])) {
        const relativePath = path.relative(repoRoot, filePath);
        if (
          relativePath === 'tests/sharedmodule/hub-pipeline-stage-residue-audit.spec.ts'
          || relativePath === 'tests/fixtures/errorsamples/goal-request-user-input-real-samples/provider-request.goal.nested-after-fix.json'
          || relativePath === 'tests/fixtures/errorsamples/metadata-center-baseline/request.json'
          || relativePath === 'tests/fixtures/errorsamples/metadata-center-replay-nested-after-fix/request.json'
        ) continue;
        const source = fs.readFileSync(filePath, 'utf8');
        if (source.includes('tools/tool-registry') || source.includes('tool-registry.ts')) {
          findings.push(relativePath);
        }
      }
    }

    expect(fs.existsSync(shellPath)).toBe(false);
    expect(findings).toEqual([]);
  });

  it('exec_command argument normalization must be native-owned', () => {
    const repoRoot = process.cwd();
    const shellPath = path.join(repoRoot, 'sharedmodule/llmswitch-core/src/tools/exec-command/normalize.ts');
    expect(fs.existsSync(shellPath)).toBe(false);

    const requiredExportsSource = fs.readFileSync(
      path.join(repoRoot, 'sharedmodule/llmswitch-core/native-hotpath-required-exports.json'),
      'utf8'
    );
    expect(requiredExportsSource).toContain('"normalizeExecCommandArgsJson"');
    const forbiddenPatterns = [
      { label: 'local command key list', pattern: /COMMAND_KEYS/u },
      { label: 'local command field detector', pattern: /hasCommandField/u },
      { label: 'local unwrap implementation', pattern: /unwrapExecArgsShape/u },
      { label: 'local primitive coercion', pattern: /asPrimitiveString/u },
      { label: 'local numeric coercion', pattern: /asFiniteNumber/u },
      { label: 'local string array join', pattern: /asStringArray/u },
      { label: 'local toon deletion', pattern: /dropToon/u },
      { label: 'local repair find meta call', pattern: /repairFindMeta/u },
      { label: 'local escalated permission mapping', pattern: /with_escalated_permissions/u },
      { label: 'local alias field mapping', pattern: /timeoutMs|max_tokens|yield_ms|wait_ms|workDir/u },
    ];
    const helperRoots = [
      'tests/sharedmodule/helpers',
      'scripts/helpers',
    ];
    const findings = helperRoots.flatMap((root) => {
      const rootPath = path.join(repoRoot, root);
      if (!fs.existsSync(rootPath)) return [];
      return walkFiles(rootPath, ['.ts', '.js', '.mjs']).flatMap((filePath) => {
        const relativePath = path.relative(repoRoot, filePath);
        if (
          relativePath === 'tests/sharedmodule/helpers/responses-openai-bridge-direct-native.ts'
          || relativePath === 'tests/sharedmodule/helpers/native-shared-conversion-direct-native.ts'
        ) {
          return [];
        }
        const source = fs.readFileSync(filePath, 'utf8');
        return forbiddenPatterns
          .filter(({ pattern }) => pattern.test(source))
          .map(({ label }) => `${relativePath}:${label}`);
      });
    });

    expect(findings).toEqual([]);
  });

  it('retired virtual router hit-log TS facade must stay deleted and native-owned', () => {
    const repoRoot = process.cwd();
    const retiredPath = 'sharedmodule/llmswitch-core/src/runtime/virtual-router-hit-log.ts';

    expect(fs.existsSync(path.join(repoRoot, retiredPath))).toBe(false);

    const requiredNativeExports = [
      'createVirtualRouterHitRecordJson',
      'toVirtualRouterHitEventJson',
      'formatVirtualRouterHitJson',
      'formatContinuationScopeJson',
      'parseVirtualRouterHitProviderKeyJson',
      'describeTargetProviderJson',
      'resolveRouteColorStr',
      'resolveSessionColorStr',
      'resolveSessionLogColorKeyJson',
      'buildHitReasonJson',
      'planVirtualRouterRouteHostEffectsJson',
      'finalizeVirtualRouterRouteHostEffectsJson',
    ];
    const nativeSource = [
      fs.readFileSync(
        path.join(repoRoot, 'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/lib.rs'),
        'utf8'
      ),
      fs.readFileSync(
        path.join(repoRoot, 'sharedmodule/llmswitch-core/native-hotpath-required-exports.json'),
        'utf8'
      ),
    ].join('\n');
    for (const exportName of requiredNativeExports) {
      expect(nativeSource).toContain(exportName);
    }

    const forbiddenPatterns = [
      { label: 'local stop-message summary', pattern: /function summarizeStopMessageRuntime/u },
      { label: 'local hit-log routing-state flattener', pattern: /function flattenRoutingState/u },
      { label: 'local hit-log stopMessageText field spread', pattern: /stopMessageText:\s*state\.stopMessageText/u },
      { label: 'local hit-log stopMessageMaxRepeats field spread', pattern: /stopMessageMaxRepeats:\s*state\.stopMessageMaxRepeats/u },
      { label: 'local hit-log omit normalization', pattern: /function normalizeHitLogOmit/u },
      { label: 'local provider key parser', pattern: /providerKey\.trim\(\)|\.split\('\\.'\)/u },
      { label: 'local target provider descriptor', pattern: /const aliasLabel|parsed\.keyAlias|parsed\.modelId/u },
      { label: 'local route color map', pattern: /multimodal:\s*'\\x1b|thinking:\s*'\\x1b/u },
      { label: 'local session color hash', pattern: /function hashSessionLogColorToken/u },
      { label: 'local session color map state', pattern: /SESSION_LOG_COLOR_ASSIGNMENTS|SESSION_LOG_COLOR_USAGE/u },
      { label: 'local context usage summary', pattern: /function describeContextUsage/u },
      { label: 'local hit reason builder', pattern: /reasoning\.split\(['"]\|['"]\)|routeUsed === 'tools'|context:\$\{contextDetail\}/u },
      { label: 'local formatted line timestamp', pattern: /padStart\(2,\s*'0'\)|toLocaleTimeString/u },
      { label: 'local stopMessage label formatter', pattern: /stopMessage:\$\{parts\.join/u },
      { label: 'local route host-effects planner', pattern: /function createVirtualRouterRouteHostEffectsLocal/u },
      { label: 'local route hit-log emitter', pattern: /function emitVirtualRouterHitLogLocal/u },
      { label: 'local route hit-log request id resolver', pattern: /function resolveVirtualRouterLogRequestIdLocal/u },
      { label: 'local route stop label force decision', pattern: /forceStopStatusLabel\s*=\s*Boolean/u },
    ];
    const scannedFiles = [
      'src/utils/session-log-color.ts',
      'src/modules/llmswitch/bridge/routing-integrations.ts',
      'sharedmodule/llmswitch-core/package.json',
    ];
    expect(fs.existsSync(path.join(repoRoot, 'src/types/rcc-llmswitch-core.d.ts'))).toBe(false);
    const findings = scannedFiles.flatMap((relativePath) => {
      const source = fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
      return [
        ...forbiddenPatterns
          .filter(({ pattern }) => pattern.test(source))
          .map(({ label }) => `${relativePath}:${label}`),
        ...(source.includes(retiredPath) || source.includes('rcc-llmswitch-core/v2/runtime/virtual-router-hit-log')
          ? [`${relativePath}:retired hit-log facade reference`]
          : []),
      ];
    });

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
      'sharedmodule/llmswitch-core/native-hotpath-required-exports.json',
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
      'sharedmodule/llmswitch-core/native-hotpath-required-exports.json',
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

  it('retired servertool utility public bridges must stay deleted', () => {
    const repoRoot = process.cwd();
    const retiredFiles = [
      'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/chat_continue_execution_directive_injection.rs',
    ];
    const scannedFiles = [
      'sharedmodule/llmswitch-core/src/native/router-hotpath/native-chat-process-servertool-orchestration-semantics.ts',
      'sharedmodule/llmswitch-core/native-hotpath-required-exports.json',
      'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/chat_servertool_orchestration.rs',
      'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/lib.rs',
      'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/servertool_skeleton_config.rs',
    ];
    const retiredSymbols = [
      'tryPlanChatServerToolBundleWithNative',
      'resolveServertoolFollowupFlowProfileWithNative',
      'runApplyPatchWithNative',
      'webSearchResolveToolNameWithNative',
      'webSearchParseToolArgumentsWithNative',
      'webSearchFindArrayWithNative',
      'buildContinueExecutionOperationsWithNative',
      'planContinueExecutionOperationsWithNative',
      'injectContinueExecutionDirectiveWithNative',
      'isStopMessageStateActiveWithNative',
      'resolveHasActiveStopMessageForContinueExecutionWithNative',
      'isCanonicalChatCompletionPayloadWithNative',
      'NativeContinueExecutionPlan',
      'NativeContinueDirectiveInjection',
      'parseBooleanInjectionPlan',
      'parseContinueExecutionPlan',
      'parseContinueDirectiveInjection',
      'parseReviewOperations',
      'ServertoolFollowupFlowProfilePayload',
      'parseServertoolFollowupFlowProfilePayload',
      'planChatServertoolOrchestrationBundleJson',
      'resolveServertoolFollowupFlowProfileJson',
      'webSearchFindArrayJson',
      'runApplyPatchJson',
      'buildContinueExecutionOperationsJson',
      'planContinueExecutionOperationsJson',
      'injectContinueExecutionDirectiveJson',
      'isStopMessageStateActiveJson',
      'resolveHasActiveStopMessageForContinueExecutionJson',
      'isCanonicalChatCompletionPayloadJson',
      'chat_continue_execution_directive_injection',
      '#[napi]\npub fn plan_chat_servertool_orchestration_bundle_json',
      '#[napi]\npub fn resolve_servertool_followup_flow_profile_json',
      '#[napi]\npub fn web_search_find_array_json',
      '#[napi]\npub fn run_apply_patch_json',
      '#[napi]\npub fn build_continue_execution_operations_json',
      '#[napi]\npub fn plan_continue_execution_operations_json',
      '#[napi]\npub fn inject_continue_execution_directive_json',
      '#[napi]\npub fn is_stop_message_state_active_json',
      '#[napi]\npub fn resolve_has_active_stop_message_for_continue_execution_json',
      '#[napi]\npub fn is_canonical_chat_completion_payload_json',
    ];
    const existingRetiredFiles = retiredFiles.filter((relativePath) => fs.existsSync(path.join(repoRoot, relativePath)));
    const findings: string[] = existingRetiredFiles.map((relativePath) => `${relativePath}:file exists`);

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

  it('retired req_inbound standalone public bridges must stay deleted', () => {
    const repoRoot = process.cwd();
    const retiredFiles = [
      'sharedmodule/llmswitch-core/scripts/tests/coverage-hub-req-inbound-semantic-lift.mjs',
      'sharedmodule/llmswitch-core/src/native/router-hotpath/native-hub-pipeline-req-inbound-semantics.ts',
      'sharedmodule/llmswitch-core/src/native/router-hotpath/native-hub-pipeline-req-inbound-semantics-types.ts',
      'sharedmodule/llmswitch-core/src/native/router-hotpath/native-hub-pipeline-req-inbound-semantics-tools.ts',
      'sharedmodule/llmswitch-core/src/native/router-hotpath/native-hub-pipeline-inbound-outbound-semantics.ts',
    ];
    const scannedFiles = [
      'sharedmodule/llmswitch-core/src/native/router-hotpath/native-hub-pipeline-req-inbound-semantics-parsers.ts',
      'sharedmodule/llmswitch-core/native-hotpath-required-exports.json',
      'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_req_inbound_context_capture.rs',
      'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_req_inbound_semantic_lift.rs',
      'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_req_inbound_tool_call_normalization.rs',
      'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/req_process_stage1_tool_governance_blocks/servertool_injection.rs',
      'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/shared_json_utils.rs',
      'sharedmodule/llmswitch-core/scripts/tests/run-matrix-ci.mjs',
    ];
    const retiredSymbols = [
      'mapReqInboundResumeToolOutputsDetailedWithNative',
      'resolveClientInjectReadyWithNative',
      'normalizeContextCaptureLabelWithNative',
      'shouldRunHubChatProcessWithNative',
      'isShellLikeToolNameTokenWithNative',
      'resolveReqInboundServerToolFollowupSnapshotWithNative',
      'augmentReqInboundContextSnapshotWithNative',
      'normalizeReqInboundToolCallIdStyleWithNative',
      'mapResumeToolOutputsDetailedWithNative',
      'resolveServerToolFollowupSnapshotWithNative',
      'augmentContextSnapshotWithNative',
      'normalizeToolCallIdStyleCandidateWithNative',
      'NativeResumeToolOutput',
      'parseResumeToolOutputs',
      'parse_json_bool',
      'parseBoolean',
      'mapResumeToolOutputsDetailedJson',
      'resolveServerToolFollowupSnapshotJson',
      'augmentContextSnapshotJson',
      'normalizeToolCallIdStyleCandidateJson',
      'isShellLikeToolNameTokenJson',
      'resolveClientInjectReadyJson',
      'normalizeContextCaptureLabelJson',
      'shouldRunHubChatProcessJson',
      'map_resume_tool_outputs_detailed_json',
      'is_shell_like_tool_name_token_json',
      'resolve_client_inject_ready_json',
      'resolve_server_tool_followup_snapshot_json',
      'augment_context_snapshot_json',
      'normalize_tool_call_id_style_candidate_json',
      'normalize_context_capture_label_json',
      'should_run_hub_chat_process_json',
      'normalize_req_inbound_reasoning_payload_json',
      'should_normalize_reasoning_payload_json',
      'normalize_reasoning_payload_v2_json',
      'apply_req_inbound_semantic_lift_json',
      'coverage-hub-req-inbound-semantic-lift',
    ];
    const existingRetiredFiles = retiredFiles.filter((relativePath) => fs.existsSync(path.join(repoRoot, relativePath)));
    const findings: string[] = existingRetiredFiles.map((relativePath) => `${relativePath}:file exists`);

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
    expect(fs.existsSync(path.join(
      repoRoot,
      'sharedmodule/llmswitch-core/src/native/router-hotpath/native-virtual-router-routing-instructions-semantics.ts',
    ))).toBe(false);
    const scannedFiles = [
      'sharedmodule/llmswitch-core/native-hotpath-required-exports.json',
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
      'sharedmodule/llmswitch-core/native-hotpath-required-exports.json',
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
      'sharedmodule/llmswitch-core/native-hotpath-required-exports.json',
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

  it('native compat action aggregate TS shell must stay physically deleted', () => {
    const repoRoot = process.cwd();
    const shellPath = path.join(
      repoRoot,
      'sharedmodule/llmswitch-core/src/native/router-hotpath/native-compat-action-semantics.ts'
    );
    const refRoots = [
      'sharedmodule/llmswitch-core/src',
      'src',
      'scripts',
      'tests',
      'docs/architecture',
    ];
    const findings: string[] = [];
    for (const root of refRoots) {
      const rootPath = path.join(repoRoot, root);
      if (!fs.existsSync(rootPath)) continue;
      for (const filePath of walkFiles(rootPath, ['.ts', '.js', '.mjs', '.md', '.yml', '.json'])) {
        const relativePath = path.relative(repoRoot, filePath);
        if (
          relativePath === 'tests/sharedmodule/hub-pipeline-stage-residue-audit.spec.ts'
          || relativePath.startsWith('tests/fixtures/')
        ) continue;
        const source = fs.readFileSync(filePath, 'utf8');
        if (source.includes('native-compat-action-semantics')) {
          findings.push(relativePath);
        }
      }
    }

    expect(fs.existsSync(shellPath)).toBe(false);
    expect(findings).toEqual([]);
  });

  it('retired req outbound context/tool-session public wrappers must stay deleted', () => {
    const repoRoot = process.cwd();
    const retiredFiles = [
      'sharedmodule/llmswitch-core/src/native/router-hotpath/native-hub-pipeline-req-outbound-semantics-types.ts',
      'sharedmodule/llmswitch-core/src/native/router-hotpath/native-hub-pipeline-req-outbound-semantics.ts',
    ];
    const scannedFiles = [
      'sharedmodule/llmswitch-core/native-hotpath-required-exports.json',
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
    const existingRetiredFiles = retiredFiles.filter((relativePath) => fs.existsSync(path.join(repoRoot, relativePath)));
    const findings: string[] = existingRetiredFiles.map((relativePath) => `${relativePath}:file exists`);

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
    expect(
      fs.existsSync(path.join(process.cwd(), 'sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-stage-timing.ts')),
    ).toBe(false);
    expect(
      fs.existsSync(path.join(process.cwd(), 'tests/sharedmodule/hub-stage-timing-top-summary.spec.ts')),
    ).toBe(false);
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

    const rootIndexPath = path.join(repoRoot, 'sharedmodule/llmswitch-core/src/index.ts');
    const rootIndex = fs.existsSync(rootIndexPath) ? fs.readFileSync(rootIndexPath, 'utf8') : '';
    const indexFindings = collectMatches(rootIndex, [
      { label: 'restores conversion barrel', pattern: /conversion\/index/ },
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
      'src/types/llmswitch-core.d.ts',
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

  it('shared openai message normalize and chat request filter facades must stay deleted', () => {
    const repoRoot = process.cwd();
    const retiredPath = path.join(repoRoot, 'sharedmodule/llmswitch-core/src/conversion/shared/openai-message-normalize.ts');
    expect(fs.existsSync(retiredPath)).toBe(false);
    expect(fs.existsSync(
      path.join(repoRoot, 'sharedmodule/llmswitch-core/src/conversion/shared/chat-request-filters.ts'),
    )).toBe(false);
    expect(fs.existsSync(
      path.join(repoRoot, 'sharedmodule/llmswitch-core/src/conversion/snapshot-utils.ts'),
    )).toBe(false);
  });

  it('HubPipeline runtime ingress hooks must not swallow native lifecycle failures', () => {
    const deletedHubPipelinePath = path.join(
      process.cwd(),
      'sharedmodule/llmswitch-core/src/conversion/hub/pipeline',
      'hub-pipeline' + '.ts',
    );
    const runtimeSetupSource = fs.readFileSync(
      path.join(process.cwd(), 'src/server/runtime/http-server/http-server-runtime-setup.ts'),
      'utf8',
    );
    const bridgeSource = fs.readFileSync(
      path.join(process.cwd(), 'src/modules/llmswitch/bridge/routing-integrations.ts'),
      'utf8',
    );
    const findings = collectMatches(`${runtimeSetupSource}\n${bridgeSource}`, [
      { label: 'swallows native runtime ingress unregister failure', pattern: /catch\s*\([^)]*\)\s*\{[\s\S]*?unregisterProviderRuntimeIngress/ },
      { label: 'keeps deleted provider runtime ingress dispose marker', pattern: /dispose\.provider-runtime-ingress\.unregister/ },
    ]);

    expect(fs.existsSync(deletedHubPipelinePath)).toBe(false);
    expect(runtimeSetupSource).toContain('createHubPipelineNative');
    expect(runtimeSetupSource).toContain('disposeHubPipelineNative');
    expect(bridgeSource).toContain('disposeHubPipelineEngineJson');
    expect(findings).toEqual([]);
  });

  it('routing integrations bridge must not re-export legacy base-dir resolver', () => {
    const repoRoot = process.cwd();
    const deletedBarrels = [
      'src/modules/llmswitch/bridge.ts',
      'src/modules/llmswitch/bridge/index.ts',
    ];
    const bridgeFiles = [
      'src/modules/llmswitch/bridge/routing-integrations.ts',
    ];
    const restoredBarrels = deletedBarrels.filter((relativePath) =>
      fs.existsSync(path.join(repoRoot, relativePath)),
    );
    const findings = bridgeFiles.flatMap((relativePath) => {
      const source = fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
      return collectMatches(source, [
        { label: `${relativePath}: legacy resolveBaseDir export`, pattern: /\bresolveBaseDir\b/ },
      ]);
    });

    expect(restoredBarrels).toEqual([]);
    expect(findings).toEqual([]);
  });

  it('routing integrations bridge must not re-export unused async config wrappers', () => {
    const repoRoot = process.cwd();
    const bridgeFiles = [
      'src/modules/llmswitch/bridge/routing-integrations.ts',
    ];
    const retiredNames = [
      'parseRouteCodexTomlRecord',
      'serializeRouteCodexTomlRecord',
      'updateRouteCodexTomlStringScalarInTable',
      'coerceRouteCodexProviderConfigV2',
    ];
    const findings = bridgeFiles.flatMap((relativePath) => {
      const source = fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
      return retiredNames.flatMap((name) => collectMatches(source, [
        { label: `${relativePath}: legacy async ${name} export`, pattern: new RegExp(`\\b${name}\\b(?!Sync)`) },
      ]));
    });

    expect(findings).toEqual([]);
  });

  it('unused llmswitch bridge dts mirrors must stay deleted', () => {
    const deletedBridgeDeclarations = [
      'src/modules/llmswitch/core-loader.d.ts',
      'src/modules/llmswitch/core-loader.ts',
      'src/modules/llmswitch/bridge.d.ts',
      'src/modules/llmswitch/bridge/index.d.ts',
      'src/modules/llmswitch/bridge/module-loader.ts',
      'src/modules/llmswitch/bridge/module-loader.d.ts',
      'src/modules/llmswitch/bridge/native-exports.d.ts',
      'src/modules/llmswitch/bridge/provider-response-converter-host.d.ts',
      'src/modules/llmswitch/bridge/response-converter.ts',
      'src/modules/llmswitch/bridge/response-converter.d.ts',
      'src/modules/llmswitch/bridge/responses-conversation-store-host.d.ts',
      'src/modules/llmswitch/bridge/responses-request-bridge.d.ts',
      'src/modules/llmswitch/bridge/responses-response-bridge.ts',
      'src/modules/llmswitch/bridge/responses-response-bridge.d.ts',
      'src/modules/llmswitch/bridge/responses-sse-bridge.d.ts',
      'src/modules/llmswitch/bridge/responses-sse-transport.ts',
      'src/modules/llmswitch/bridge/routing-integrations.d.ts',
      'src/modules/llmswitch/bridge/runtime-integrations.d.ts',
      'src/modules/llmswitch/bridge/snapshot-recorder-runtime.ts',
      'src/modules/llmswitch/bridge/snapshot-recorder-runtime.d.ts',
      'src/modules/llmswitch/bridge/snapshot-recorder-tool-failures.d.ts',
      'src/modules/llmswitch/bridge/snapshot-recorder-types.d.ts',
      'src/modules/llmswitch/bridge/snapshot-recorder-types.ts',
      'src/modules/llmswitch/bridge/bridge-types.ts',
      'src/modules/llmswitch/bridge/snapshot-recorder.d.ts',
      'src/modules/llmswitch/bridge/state-integrations.ts',
      'src/modules/llmswitch/bridge/state-integrations.d.ts',
    ];

    const existing = deletedBridgeDeclarations.filter((relativePath) =>
      fs.existsSync(path.join(process.cwd(), relativePath)),
    );

    expect(existing).toEqual([]);
  });

  it('HubPipeline deleted type shell must not be re-exported or restored', () => {
    const deletedHubPipelinePath = path.join(
      process.cwd(),
      'sharedmodule/llmswitch-core/src/conversion/hub/pipeline',
      'hub-pipeline' + '.ts',
    );
    const retiredTypesPath = path.join(
      process.cwd(),
      'sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-types.ts',
    );

    expect(fs.existsSync(deletedHubPipelinePath)).toBe(false);
    expect(fs.existsSync(retiredTypesPath)).toBe(false);
  });

  it('HubPipeline compat types must not restore retired profile/mapping type shells', () => {
    const repoRoot = process.cwd();
    const retiredTypePath = path.join(repoRoot, 'sharedmodule/llmswitch-core/src/conversion/hub/pipeline/compat/compat-types.ts');
    const enginePath = path.join(repoRoot, 'sharedmodule/llmswitch-core/src/conversion/hub/pipeline/compat/compat-engine.ts');

    expect(fs.existsSync(retiredTypePath)).toBe(false);
    expect(fs.existsSync(enginePath)).toBe(false);
  });

  it('ChatEnvelope type surface must stay physically deleted', () => {
    const filePath = path.join(process.cwd(), 'sharedmodule/llmswitch-core/src/conversion/hub/types/chat-envelope.d.ts');

    expect(fs.existsSync(filePath)).toBe(false);
  });

  it('ServerTool type surface must stay physically deleted', () => {
    const filePath = path.join(process.cwd(), 'sharedmodule/llmswitch-core/src/servertool/types.d.ts');

    expect(fs.existsSync(filePath)).toBe(false);
  });

  it('StandardizedRequest type surface must stay physically deleted', () => {
    const filePath = path.join(process.cwd(), 'sharedmodule/llmswitch-core/src/conversion/hub/types/standardized.d.ts');

    expect(fs.existsSync(filePath)).toBe(false);
  });

  it('legacy conversion type surface must stay physically deleted after codec owner split', () => {
    const filePath = path.join(process.cwd(), 'sharedmodule/llmswitch-core/src/conversion/types.ts');

    expect(fs.existsSync(filePath)).toBe(false);
  });

  it('chat process session usage TS shell must stay physically deleted', () => {
    const filePath = path.join(process.cwd(), 'sharedmodule/llmswitch-core/src/conversion/hub/process/chat-process-session-usage.ts');
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it('provider response may only invoke native session usage plan without restoring TS usage semantics', () => {
    const hostPath = path.join(process.cwd(), 'src/modules/llmswitch/bridge/provider-response-converter-host.ts');
    const effectsPath = path.join(process.cwd(), 'src/modules/llmswitch/bridge/provider-response-effects.ts');
    const hostSource = fs.readFileSync(hostPath, 'utf8');
    const effectsSource = fs.readFileSync(effectsPath, 'utf8');
    const findings = collectMatches(`${hostSource}\n${effectsSource}`, [
      { label: 'restores retired session token estimator export', pattern: /estimateSessionBoundTokens/ },
      { label: 'restores retired session delta token estimator', pattern: /estimateDeltaTokens|countRequestTokens/ },
      { label: 'restores retired session usage snapshot reader', pattern: /SessionUsageSnapshot|buildSnapshot/ },
      { label: 'restores TS session usage scope resolver', pattern: /function\s+resolveSessionUsageScope\b/ },
      { label: 'restores TS usage token normalization', pattern: /function\s+normalizeUsage\b|function\s+readRoundedToken\b/ },
      { label: 'restores TS routing state read/write', pattern: /loadRoutingInstructionStateSync|saveRoutingInstructionStateSync|function\s+loadState\b/ },
      { label: 'restores TS empty routing state construction', pattern: /function\s+createEmptyRoutingInstructionState\b/ },
      { label: 'restores TS timestamp ownership', pattern: /Date\.now\s*\(/ },
    ]);

    expect(findings).toEqual([]);
    expect(hostSource).not.toContain('planChatProcessSessionUsage');
    expect(effectsSource).toContain('planChatProcessSessionUsageWithNative');
    expect(`${hostSource}\n${effectsSource}`).not.toContain('saveChatProcessSessionActualUsage');
    expect(`${hostSource}\n${effectsSource}`).not.toContain('../process/chat-process-session-usage.js');
  });

  it('virtual router routing-state persistence predicates must stay Rust-owned', () => {
    const filePath = path.join(
      process.cwd(),
      'sharedmodule/llmswitch-core/src/native/router-hotpath/native-virtual-router-routing-state.ts',
    );
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it('marker lifecycle shared helper must stay physically deleted', () => {
    const filePath = path.join(process.cwd(), 'sharedmodule/llmswitch-core/src/conversion/shared/marker-lifecycle.ts');
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it('chat SSE serializer must have been physically deleted', () => {
    const filePath = path.join(process.cwd(), 'sharedmodule/llmswitch-core/src/sse/shared/chat-serializer.ts');
    // Physically deleted as part of SSE rustification closeout (Phase 4).
    // All wire-serialization logic moved to Rust build_*_sse_stream_frames_json.
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it('SSE shared utils must have been physically deleted', () => {
    const filePath = path.join(process.cwd(), 'sharedmodule/llmswitch-core/src/sse/shared/utils.ts');
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it('servertool MetadataCenter carrier shell must stay physically deleted', () => {
    const filePath = path.join(process.cwd(), 'sharedmodule/llmswitch-core/src/servertool/metadata-center-carrier.ts');
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it('SSE public barrel shell must stay physically deleted', () => {
    const repoRoot = process.cwd();
    const filePath = path.join(repoRoot, 'sharedmodule/llmswitch-core/src/sse/index.ts');
    const nativeWrapperPath = path.join(repoRoot, 'sharedmodule/llmswitch-core/src/native/router-hotpath/native-sse-runtime.ts');
    const findings: string[] = [];
    for (const root of ['sharedmodule/llmswitch-core/src', 'src', 'scripts', 'tests', 'docs/architecture']) {
      const rootPath = path.join(repoRoot, root);
      if (!fs.existsSync(rootPath)) continue;
      for (const candidate of walkFiles(rootPath, ['.ts', '.js', '.mjs', '.md', '.yml', '.json'])) {
        const relativePath = path.relative(repoRoot, candidate);
        if (
          relativePath === 'tests/sharedmodule/hub-pipeline-stage-residue-audit.spec.ts'
          || relativePath === 'docs/architecture/function-map.yml'
          || relativePath === 'docs/architecture/verification-map.yml'
        ) continue;
        if (relativePath === 'tests/sharedmodule/sse-index-public-surface-no-factory.spec.ts') continue;
        if (relativePath === 'scripts/architecture/verify-sse-architecture-boundary.mjs') continue;
        if (relativePath === 'docs/architecture/function-map.yml') continue;
        if (relativePath === 'docs/architecture/verification-map.yml') continue;
        const source = fs.readFileSync(candidate, 'utf8');
        if (
          source.includes('sse/index.ts')
          || source.includes('dist/sse/index.js')
          || source.includes('sse/index.js')
          || source.includes('dist/native/router-hotpath/native-sse-runtime.js')
        ) {
          findings.push(relativePath);
        }
      }
    }

    expect(fs.existsSync(filePath)).toBe(false);
    expect(fs.existsSync(nativeWrapperPath)).toBe(false);
    expect(findings).toEqual([]);
  });

  it('responses reasoning registry TS wrapper must not expose Rust-internal reasoning/meta APIs', () => {
    const repoRoot = process.cwd();
    const files = [
      'sharedmodule/llmswitch-core/src/conversion/shared/responses-reasoning-registry.ts',
      'sharedmodule/llmswitch-core/native-hotpath-required-exports.json',
      'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/lib.rs',
    ];
    const findings: string[] = [];

    for (const relativePath of files) {
      const fullPath = path.join(repoRoot, relativePath);
      if (!fs.existsSync(fullPath)) {
        continue;
      }
      const source = fs.readFileSync(fullPath, 'utf8');
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
    [
      'sharedmodule/llmswitch-core/src/conversion/shared/anthropic-message-utils-openai-response.ts',
      'sharedmodule/llmswitch-core/src/conversion/shared/anthropic-message-utils-openai-request.ts',
      'sharedmodule/llmswitch-core/src/conversion/shared/chat-output-normalizer.ts',
      'sharedmodule/llmswitch-core/src/conversion/shared/output-content-normalizer.ts',
      'sharedmodule/llmswitch-core/src/conversion/shared/reasoning-tool-normalizer.ts',
    ].forEach((relativePath) => {
      expect(fs.existsSync(path.join(repoRoot, relativePath))).toBe(false);
    });
    const files = [
      'sharedmodule/llmswitch-core/src/conversion/shared/anthropic-message-utils-core.ts',
      'sharedmodule/llmswitch-core/src/native/router-hotpath/native-shared-conversion-semantics-tool-definitions.ts',
      'sharedmodule/llmswitch-core/src/native/router-hotpath/native-shared-conversion-semantics-shell-utils.ts',
      'sharedmodule/llmswitch-core/src/native/router-hotpath/native-shared-conversion-semantics.ts',
      'sharedmodule/llmswitch-core/native-hotpath-required-exports.json',
      'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/lib.rs',
      'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/shared_args_mapping.rs',
      'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/shared_tool_mapping.rs',
    ];
    const findings: string[] = [];
    const retiredFiles = [
      'sharedmodule/llmswitch-core/src/conversion/compaction-detect.ts',
      'sharedmodule/llmswitch-core/src/conversion/mcp-injection.ts',
      'sharedmodule/llmswitch-core/src/conversion/shared/tool-mapping.ts',
      'sharedmodule/llmswitch-core/src/conversion/shared/tooling.ts',
      'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/thought_signature_validator.rs',
      'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/thought_signature_validator/tests.rs',
    ].filter((relativePath) => fs.existsSync(path.join(repoRoot, relativePath)));

    for (const relativePath of files) {
      const fullPath = path.join(repoRoot, relativePath);
      if (!fs.existsSync(fullPath)) {
        continue;
      }
      const source = fs.readFileSync(fullPath, 'utf8');
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

  it('conversion.shared.anthropic TS files must remain native shells only', () => {
    const repoRoot = process.cwd();
    const files = [
      'sharedmodule/llmswitch-core/src/conversion/shared/anthropic-message-utils.ts',
      'sharedmodule/llmswitch-core/src/conversion/shared/anthropic-message-utils-core.ts',
      'sharedmodule/llmswitch-core/src/conversion/shared/anthropic-message-utils-tool-schema.ts',
    ].filter((relativePath) => fs.existsSync(path.join(repoRoot, relativePath)));
    const forbidden = [
      { label: 'public TS alias builder', pattern: /buildAnthropicToolAliasMap\b/ },
      { label: 'TS anthropic inbound converter', pattern: /buildOpenAIChatFromAnthropic\s*\(/ },
      { label: 'TS anthropic text flattening', pattern: /flattenAnthropicText\b/ },
      { label: 'TS anthropic tool-result normalization', pattern: /normalizeToolResultContent\b/ },
      { label: 'TS shell-like input normalization', pattern: /normalizeShellLikeToolInput\b/ },
      { label: 'TS tool name normalization', pattern: /normalizeAnthropicToolName\b|denormalizeAnthropicToolName\b/ },
      { label: 'TS builtin schema sanitizer', pattern: /sanitizeAnthropicBuiltinInputSchema\b/ },
      { label: 'TS anthropic stable schema allowlist', pattern: /ANTHROPIC_STABLE_TOOL_SCHEMA_/ },
      { label: 'TS bridge tools-to-chat mapper', pattern: /export\s+function\s+mapAnthropicToolsToChat\b/ },
      { label: 'TS local bridge mapping composition', pattern: /mapChatToolsToBridge\b|mapBridgeToolsToChat\b|flattenChatToolsForFunctionCalling\b/ },
    ];
    const findings: string[] = [];

    for (const relativePath of files) {
      const fullPath = path.join(repoRoot, relativePath);
      if (!fs.existsSync(fullPath)) {
        continue;
      }
      const source = fs.readFileSync(fullPath, 'utf8');
      for (const rule of forbidden) {
        if (rule.pattern.test(source)) {
          findings.push(`${relativePath}: ${rule.label}`);
        }
      }
    }

    expect(findings).toEqual([]);
  });

  it('system tool guidance TS shell must stay physically deleted', () => {
    const guidePath = path.join(process.cwd(), 'sharedmodule/llmswitch-core/src/guidance/index.ts');
    expect(fs.existsSync(guidePath)).toBe(false);
  });

  it('tool args JSON artifact repair must be native-owned', () => {
    const repoRoot = process.cwd();
    const argsJsonPath = path.join(repoRoot, 'sharedmodule/llmswitch-core/src/tools/args-json.ts');
    expect(fs.existsSync(argsJsonPath)).toBe(false);

    const requiredExportsSource = fs.readFileSync(
      path.join(repoRoot, 'sharedmodule/llmswitch-core/native-hotpath-required-exports.json'),
      'utf8'
    );
    expect(requiredExportsSource).toContain('"parseToolArgsJsonWithArtifactRepairJson"');
    const forbiddenPatterns = [
      { label: 'local arg key regex', pattern: /arg_key\\s\*|arg_key\\s\*>|<arg_key/u },
      { label: 'local arg value regex', pattern: /arg_value\\s\*|arg_value\\s\*>|<arg_value/u },
      { label: 'local xml tag stripper', pattern: /stripXmlLikeTags|<\[\^>\]\+>/u },
      { label: 'local primitive coercion', pattern: /coercePrimitive/u },
      { label: 'local injected pair extraction', pattern: /extractInjectedArgPairs/u },
      { label: 'local recursive key repair', pattern: /repairArgKeyArtifactsInKeys/u },
      { label: 'local recursive object repair', pattern: /repairArgKeyArtifactsInObject/u },
      { label: 'local parse fallback warning', pattern: /JSON\.parse failed after repair/u },
    ];
    const helperRoots = [
      'tests/sharedmodule/helpers',
      'scripts/helpers',
    ];
    const findings = helperRoots.flatMap((root) => {
      const rootPath = path.join(repoRoot, root);
      if (!fs.existsSync(rootPath)) return [];
      return walkFiles(rootPath, ['.ts', '.js', '.mjs']).flatMap((filePath) => {
        const relativePath = path.relative(repoRoot, filePath);
        if (relativePath === 'tests/sharedmodule/helpers/resp-semantics-direct-native.ts') {
          return [];
        }
        const source = fs.readFileSync(filePath, 'utf8');
        return forbiddenPatterns
          .filter(({ pattern }) => pattern.test(source))
          .map(({ label }) => `${relativePath}:${label}`);
      });
    });

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
      'sharedmodule/llmswitch-core/src/conversion/shared/openai-message-normalize.ts',
      'sharedmodule/llmswitch-core/src/native/router-hotpath/native-shared-conversion-semantics-tools.js',
      'sharedmodule/llmswitch-core/src/native/router-hotpath/native-shared-conversion-semantics-tools.js.map',
      'sharedmodule/llmswitch-core/src/native/router-hotpath/native-shared-conversion-semantics-tools.d.ts',
      'src/types/llmswitch-local-types.js',
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
      'sharedmodule/llmswitch-core/src/conversion/codecs/anthropic-openai-codec.d.ts',
      'sharedmodule/llmswitch-core/src/conversion/codecs/openai-openai-codec.d.ts',
      'sharedmodule/llmswitch-core/src/conversion/codecs/gemini-openai-codec.d.ts',
      'sharedmodule/llmswitch-core/src/conversion/codecs/responses-openai-codec.d.ts',
      'sharedmodule/llmswitch-core/src/conversion/compaction-detect.d.ts',
      'sharedmodule/llmswitch-core/src/conversion/mcp-injection.d.ts',
      'sharedmodule/llmswitch-core/src/conversion/responses/responses-host-policy.d.ts',
      'sharedmodule/llmswitch-core/src/conversion/responses/responses-host-policy.ts',
      'sharedmodule/llmswitch-core/src/conversion/responses/responses-host-policy.js',
      'sharedmodule/llmswitch-core/src/conversion/responses/responses-host-policy.js.map',
      'sharedmodule/llmswitch-core/src/conversion/responses/responses-openai-bridge.d.ts',
      'sharedmodule/llmswitch-core/src/conversion/responses/responses-openai-bridge/response-payload.ts',
      'sharedmodule/llmswitch-core/src/conversion/responses/responses-openai-bridge/response-payload.js',
      'sharedmodule/llmswitch-core/src/conversion/responses/responses-openai-bridge/response-payload.js.map',
      'sharedmodule/llmswitch-core/src/conversion/responses/responses-openai-bridge/response-payload.d.ts',
      'sharedmodule/llmswitch-core/src/conversion/responses/responses-openai-bridge/types.ts',
      'sharedmodule/llmswitch-core/src/conversion/responses/responses-openai-bridge/types.d.ts',
      'sharedmodule/llmswitch-core/src/conversion/responses/responses-openai-bridge/types.js',
      'sharedmodule/llmswitch-core/src/conversion/runtime-metadata.ts',
      'sharedmodule/llmswitch-core/src/conversion/runtime-metadata.js',
      'sharedmodule/llmswitch-core/src/conversion/runtime-metadata.js.map',
      'sharedmodule/llmswitch-core/src/conversion/runtime-metadata.d.ts',
      'sharedmodule/llmswitch-core/src/conversion/shared/openai-message-normalize-contract.d.ts',
      'sharedmodule/llmswitch-core/src/conversion/shared/openai-message-normalize-contract.js',
      'sharedmodule/llmswitch-core/src/conversion/shared/openai-message-normalize-control-text.d.ts',
      'sharedmodule/llmswitch-core/src/conversion/shared/openai-message-normalize-control-text.js',
      'sharedmodule/llmswitch-core/src/conversion/shared/openai-message-normalize-tool-history.d.ts',
      'sharedmodule/llmswitch-core/src/conversion/shared/openai-message-normalize-tool-history.js',
      'sharedmodule/llmswitch-core/src/conversion/shared/reasoning-tool-normalizer.d.ts',
      'sharedmodule/llmswitch-core/src/conversion/shared/responses-conversation-store-native.d.ts',
      'sharedmodule/llmswitch-core/src/conversion/shared/responses-conversation-store-types.ts',
      'sharedmodule/llmswitch-core/src/conversion/shared/responses-conversation-store-types.d.ts',
      'sharedmodule/llmswitch-core/src/conversion/shared/responses-conversation-store-types.js',
      'sharedmodule/llmswitch-core/src/conversion/shared/responses-conversation-store.d.ts',
      'sharedmodule/llmswitch-core/src/conversion/shared/responses-reasoning-registry.d.ts',
      'sharedmodule/llmswitch-core/src/conversion/shared/responses-response-utils.ts',
      'sharedmodule/llmswitch-core/src/conversion/shared/responses-response-utils.js',
      'sharedmodule/llmswitch-core/src/conversion/shared/responses-response-utils.js.map',
      'sharedmodule/llmswitch-core/src/conversion/shared/responses-response-utils.d.ts',
      'sharedmodule/llmswitch-core/src/conversion/shared/responses-tool-utils.ts',
      'sharedmodule/llmswitch-core/src/conversion/shared/responses-tool-utils.js',
      'sharedmodule/llmswitch-core/src/conversion/shared/responses-tool-utils.js.map',
      'sharedmodule/llmswitch-core/src/conversion/shared/responses-tool-utils.d.ts',
      'sharedmodule/llmswitch-core/src/conversion/shared/tool-mapping.d.ts',
      'sharedmodule/llmswitch-core/src/conversion/types.d.ts',
      'sharedmodule/llmswitch-core/src/conversion/types.js',
      'sharedmodule/llmswitch-core/src/conversion/types/bridge-message-types.ts',
      'sharedmodule/llmswitch-core/src/conversion/types/bridge-message-types.js',
    ];
    const existing = forbiddenArtifacts.filter((relativePath) => fs.existsSync(path.join(repoRoot, relativePath)));

    expect(existing).toEqual([]);
  });

  it('OpenAI OpenAI codec TS shell must stay physically deleted', () => {
    const repoRoot = process.cwd();
    const shellPath = path.join(
      repoRoot,
      'sharedmodule/llmswitch-core/src/conversion/codecs/openai-openai-codec.ts'
    );
    const refRoots = [
      'sharedmodule/llmswitch-core/src',
      'src',
      'scripts',
      'tests',
      'docs/architecture',
    ];
    const findings: string[] = [];
    for (const root of refRoots) {
      const rootPath = path.join(repoRoot, root);
      if (!fs.existsSync(rootPath)) continue;
      for (const filePath of walkFiles(rootPath, ['.ts', '.js', '.mjs', '.md', '.yml', '.json'])) {
        const relativePath = path.relative(repoRoot, filePath);
        if (
          relativePath === 'tests/sharedmodule/hub-pipeline-stage-residue-audit.spec.ts'
          || relativePath === 'docs/architecture/function-map.yml'
          || relativePath === 'docs/architecture/verification-map.yml'
        ) continue;
        const source = fs.readFileSync(filePath, 'utf8');
        if (source.includes('openai-openai-codec')) {
          findings.push(relativePath);
        }
      }
    }

    expect(fs.existsSync(shellPath)).toBe(false);
    expect(findings).toEqual([]);
  });

  it('Anthropic OpenAI codec TS shell must stay physically deleted', () => {
    const repoRoot = process.cwd();
    const shellPath = path.join(
      repoRoot,
      'sharedmodule/llmswitch-core/src/conversion/codecs/anthropic-openai-codec.ts'
    );
    const refRoots = [
      'sharedmodule/llmswitch-core/src',
      'src',
      'scripts',
      'tests',
      'docs/architecture',
    ];
    const findings: string[] = [];
    for (const root of refRoots) {
      const rootPath = path.join(repoRoot, root);
      if (!fs.existsSync(rootPath)) continue;
      for (const filePath of walkFiles(rootPath, ['.ts', '.js', '.mjs', '.md', '.yml', '.json'])) {
        const relativePath = path.relative(repoRoot, filePath);
        if (
          relativePath === 'tests/sharedmodule/hub-pipeline-stage-residue-audit.spec.ts'
          || relativePath === 'docs/architecture/function-map.yml'
          || relativePath === 'docs/architecture/verification-map.yml'
        ) continue;
        const source = fs.readFileSync(filePath, 'utf8');
        if (source.includes('anthropic-openai-codec')) {
          findings.push(relativePath);
        }
      }
    }

    expect(fs.existsSync(shellPath)).toBe(false);
    expect(findings).toEqual([]);
  });

  it('Gemini OpenAI codec TS shell must stay physically deleted', () => {
    const repoRoot = process.cwd();
    const shellPath = path.join(
      repoRoot,
      'sharedmodule/llmswitch-core/src/conversion/codecs/gemini-openai-codec.ts'
    );
    const refRoots = [
      'sharedmodule/llmswitch-core/src',
      'src',
      'scripts',
      'tests',
      'docs/architecture',
    ];
    const findings: string[] = [];
    for (const root of refRoots) {
      const rootPath = path.join(repoRoot, root);
      if (!fs.existsSync(rootPath)) continue;
      for (const filePath of walkFiles(rootPath, ['.ts', '.js', '.mjs', '.md', '.yml', '.json'])) {
        const relativePath = path.relative(repoRoot, filePath);
        if (
          relativePath === 'tests/sharedmodule/hub-pipeline-stage-residue-audit.spec.ts'
          || relativePath === 'docs/architecture/function-map.yml'
          || relativePath === 'docs/architecture/verification-map.yml'
        ) continue;
        const source = fs.readFileSync(filePath, 'utf8');
        if (source.includes('gemini-openai-codec')) {
          findings.push(relativePath);
        }
      }
    }

    expect(fs.existsSync(shellPath)).toBe(false);
    expect(findings).toEqual([]);
  });

  it('Responses OpenAI codec TS shell must stay physically deleted', () => {
    const repoRoot = process.cwd();
    const shellPath = path.join(
      repoRoot,
      'sharedmodule/llmswitch-core/src/conversion/codecs/responses-openai-codec.ts'
    );
    const refRoots = [
      'sharedmodule/llmswitch-core/src',
      'src',
      'scripts',
      'tests',
      'docs/architecture',
    ];
    const findings: string[] = [];
    for (const root of refRoots) {
      const rootPath = path.join(repoRoot, root);
      if (!fs.existsSync(rootPath)) continue;
      for (const filePath of walkFiles(rootPath, ['.ts', '.js', '.mjs', '.md', '.yml', '.json'])) {
        const relativePath = path.relative(repoRoot, filePath);
        if (
          relativePath === 'tests/sharedmodule/hub-pipeline-stage-residue-audit.spec.ts'
          || relativePath === 'docs/architecture/function-map.yml'
          || relativePath === 'docs/architecture/verification-map.yml'
        ) continue;
        const source = fs.readFileSync(filePath, 'utf8');
        if (source.includes('responses-openai-codec')) {
          findings.push(relativePath);
        }
      }
    }

    expect(fs.existsSync(shellPath)).toBe(false);
    expect(findings).toEqual([]);
  });

  it('responses conversation store scope isolation keys must be native-owned', () => {
    const repoRoot = process.cwd();
    const storeSource = fs.readFileSync(
      path.join(repoRoot, 'src/modules/llmswitch/bridge/responses-conversation-store-host.ts'),
      'utf8'
    );

    expect(storeSource).toContain('executeResponsesConversationStoreOperationJson');
    expect(storeSource).toContain('executeStoreOperation');
    expect(storeSource).not.toMatch(/entry:\$\{[^`]+owner:\$\{/u);
    expect(storeSource).not.toMatch(/owner:\$\{[^`]+session:\$\{/u);
    expect(storeSource).not.toMatch(/owner:\$\{[^`]+conversation:\$\{/u);
    expect(storeSource).not.toContain('const owners: Array');
    expect(storeSource).not.toContain('responsesResume');
  });

  it('responses conversation store TS surface must stay a native-plan IO shell', () => {
    const repoRoot = process.cwd();
    const storeSource = fs.readFileSync(
      path.join(repoRoot, 'src/modules/llmswitch/bridge/responses-conversation-store-host.ts'),
      'utf8'
    );
    const storeJsPath = path.join(repoRoot, 'src/modules/llmswitch/bridge/responses-conversation-store-host.js');
    const storeDtsPath = path.join(repoRoot, 'src/modules/llmswitch/bridge/responses-conversation-store-host.d.ts');

    expect(storeSource).toContain('executeResponsesConversationStoreOperationJson');
    expect(storeSource).toContain('executeStoreOperation');
    expect(fs.existsSync(storeDtsPath)).toBe(false);
    expect(storeSource).not.toMatch(/class\s+ResponsesConversationStore\b/u);
    expect(storeSource).not.toContain('__rccResponsesConversationStore');
    expect(storeSource).not.toMatch(/globalThis[\s\S]{0,160}ResponsesConversationStore/u);

    for (const retiredNativePlan of [
      'buildConversationScopePlan',
      'planPersistedEntry',
      'planStoreTokens',
      'planContinuationMeta',
      'planPersistenceEligibility',
      'planRebindRequestId',
      'planConversationPreflight',
      'planCapturePendingCleanup',
      'planCapturedEntry',
      'planRecordScopeEntryMatch',
      'planRecordContinuationFlag',
      'planRecordScopeCleanup',
      'planResumeEntryMatch',
      'planContinuationLookupByResponseId',
      'planStoreSweep',
      'planReleaseRequestPayload',
      'planConversationRetention',
      'planScopeContinuationMatch',
      'planAttachEntryScopes',
    ]) {
      expect(storeSource).not.toContain(retiredNativePlan);
    }

    const forbidden = collectMatches(storeSource, [
      {
        label: 'retired shouldAllow TS facade',
        pattern: /function\s+shouldAllowContinuation\b|shouldAllowResponsesConversationContinuationWithNative/u,
      },
      {
        label: 'retired prepare entry TS facade',
        pattern: /function\s+prepareConversationEntry\b|prepareResponsesConversationEntryWithNative/u,
      },
      {
        label: 'retired persisted field TS facade',
        pattern: /function\s+pickPersistedFields\b|pickResponsesPersistedFieldsWithNative/u,
      },
      {
        label: 'restores zero-consumer scope match type shell',
        pattern: /(?:export\s+)?type\s+ScopeMatchCandidate\b/u,
      },
      {
        label: 'restores zero-consumer resume match type shell',
        pattern: /(?:export\s+)?type\s+ResumeEntryMatchCandidate\b/u,
      },
      {
        label: 'restores zero-consumer capture cleanup type shell',
        pattern: /(?:export\s+)?type\s+CapturePendingCleanupCandidate\b/u,
      },
      {
        label: 'restores zero-consumer record cleanup type shell',
        pattern: /(?:export\s+)?type\s+RecordScopeCleanupCandidate\b/u,
      },
      {
        label: 'manual continuation owner branch',
        pattern: /continuationOwner\s*===|continuationOwner\s*!==/u,
      },
      {
        label: 'manual scope-key string builder',
        pattern: /entry:\$\{[^`]+owner:\$\{|owner:\$\{[^`]+session:\$\{|owner:\$\{[^`]+conversation:\$\{/u,
      },
      {
        label: 'manual continuation allow true branch',
        pattern: /allowContinuation\s*=\s*true|allowContinuation:\s*true/u,
      },
      {
        label: 'manual continuation allow false branch',
        pattern: /allowContinuation\s*=\s*false|allowContinuation:\s*false/u,
      },
      {
        label: 'local response output to input conversion',
        pattern: /function_call_output[\s\S]{0,120}\.map\(|previous_response_id[\s\S]{0,160}input/u,
      },
    ]);

    expect(forbidden).toEqual([]);
    expect(storeSource).not.toMatch(/\brequestMap\b|\bresponseIndex\b|\bscopeIndex\b/u);
    expect(storeSource).not.toContain('export { store as responsesConversationStore }');
    expect(fs.existsSync(storeJsPath)).toBe(false);

    const globalStoreRefs: string[] = [];
    for (const root of ['src', 'scripts', 'tests']) {
      for (const filePath of walkFiles(path.join(repoRoot, root), ['.ts', '.js', '.mjs'])) {
        const relativePath = path.relative(repoRoot, filePath);
        if (relativePath === 'tests/sharedmodule/hub-pipeline-stage-residue-audit.spec.ts') {
          continue;
        }
        const source = fs.readFileSync(filePath, 'utf8');
        if (source.includes('__rccResponsesConversationStore')) {
          globalStoreRefs.push(relativePath);
        }
      }
    }
    expect(globalStoreRefs).toEqual([]);
  });

  it('responses conversation continuation input source selection must be native-owned', () => {
    const repoRoot = process.cwd();
    const retiredNativeStorePath = path.join(
      repoRoot,
      'sharedmodule/llmswitch-core/src/conversion/shared/responses-conversation-store-native.ts',
    );
    const hostStoreSource = fs.readFileSync(
      path.join(repoRoot, 'src/modules/llmswitch/bridge/responses-conversation-store-host.ts'),
      'utf8'
    );

    expect(fs.existsSync(retiredNativeStorePath)).toBe(false);
    expect(hostStoreSource).toContain('getRouterHotpathJsonBindingSync');
    expect(hostStoreSource).toContain('executeResponsesConversationStoreOperationJson');
    expect(hostStoreSource).not.toContain('restoreResponsesContinuationPayloadJson');
    expect(hostStoreSource).not.toContain('materializeResponsesContinuationPayloadJson');
    expect(hostStoreSource).not.toContain('conversion/shared/responses-conversation-store-native');
    expect(hostStoreSource).not.toContain('function restoreContinuationPayload');
    expect(hostStoreSource).not.toContain('function materializeContinuationPayload');
    expect(hostStoreSource).not.toContain('useReleasedPrefixSideChannelOnly');
    expect(hostStoreSource).not.toContain('const continuationInput');
    expect(hostStoreSource).not.toMatch(/continuationOwner\s*===\s*['"]direct['"]/u);
    expect(hostStoreSource).not.toMatch(/Array\.isArray\(entry\.input\)[\s\S]{0,220}releasedInputPrefix/u);
  });

  it('responses provider-owned submit context materialization must be native-owned', () => {
    const repoRoot = process.cwd();
    const bridgeSource = fs.readFileSync(
      path.join(repoRoot, 'src/modules/llmswitch/bridge/responses-request-bridge.ts'),
      'utf8'
    );

    expect(bridgeSource).toContain('materializeProviderOwnedSubmitContext');
    expect(bridgeSource).not.toMatch(/tool_outputs[\s\S]{0,400}\.map\(/u);
    expect(bridgeSource).not.toMatch(/type:\s*['"]function_call_output['"]/u);
    expect(bridgeSource).not.toMatch(/tool_call_id[\s\S]{0,180}call_id/u);
  });

  it('responses request context restore planning must be native-owned', () => {
    const repoRoot = process.cwd();
    const bridgeSource = fs.readFileSync(
      path.join(repoRoot, 'src/modules/llmswitch/bridge/responses-request-bridge.ts'),
      'utf8'
    );

    expect(bridgeSource).toContain('planResponsesRequestContext');
    expect(bridgeSource).not.toContain('relayOwnedSubmitToolOutputsResume');
    expect(bridgeSource).not.toContain('relayOwnedMaterializedSubmitToolOutputsResume');
    expect(bridgeSource).not.toMatch(/resumeMeta\.continuationOwner\s*===\s*['"]relay['"]/u);
    expect(bridgeSource).not.toMatch(/delete\s+\w+\.response_id/u);
    expect(bridgeSource).not.toMatch(/delete\s+\w+\.tool_outputs/u);
    expect(bridgeSource).not.toMatch(/restoredTools[\s\S]{0,220}\?\s*\{\s*tools/u);
  });

  it('responses continuation request action routing must be native-owned', () => {
    const repoRoot = process.cwd();
    const bridgeSource = fs.readFileSync(
      path.join(repoRoot, 'src/modules/llmswitch/bridge/responses-request-bridge.ts'),
      'utf8'
    );

    expect(bridgeSource).toContain('planResponsesContinuationRequestAction');
    expect(bridgeSource).not.toContain("continuation?.continuationOwner === 'direct'");
    expect(bridgeSource).not.toContain("continuation?.continuationOwner === 'relay'");
    expect(bridgeSource).not.toMatch(/plannedEntry\.mode\s*===\s*['"]scope_materialize['"][\s\S]{0,240}continuationOwner/u);
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

  it('llmswitch host bridge source must not keep side-by-side JS emit artifacts', () => {
    const trackedArtifacts = execFileSync(
      'git',
      ['ls-files', 'src/modules/llmswitch/**/*.js', 'src/modules/llmswitch*.js'],
      { cwd: process.cwd(), encoding: 'utf8' }
    )
      .split('\n')
      .filter((relativePath) => relativePath && fs.existsSync(path.join(process.cwd(), relativePath)));

    expect(trackedArtifacts).toEqual([]);
  });

  it('llmswitch-core src must not keep side-by-side TS emit artifacts', () => {
    const generatedArtifacts = walkFiles(
      path.join(process.cwd(), 'sharedmodule/llmswitch-core/src'),
      ['.js', '.d.ts', '.js.map'],
    )
      .map((fullPath) => path.relative(process.cwd(), fullPath).split(path.sep).join('/'));

    expect(generatedArtifacts.sort()).toEqual([]);
  });

  it('Hub and Virtual Router source truth dirs must not keep side-by-side TS emit artifacts', () => {
    const allowedGeneratedDeclarations = new Set<string>();
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
        const relativePath = path.relative(process.cwd(), fullPath).split(path.sep).join('/');
        if (!allowedGeneratedDeclarations.has(relativePath)) {
          generatedArtifacts.push(relativePath);
        }
      }
    }

    expect(generatedArtifacts.sort()).toEqual([]);
  });

  it('servertool source truth dir must not keep side-by-side TS emit artifacts', () => {
    const generatedArtifacts = walkFiles(
      path.join(process.cwd(), 'sharedmodule/llmswitch-core/src/servertool'),
      ['.js', '.d.ts', '.js.map'],
    )
      .map((fullPath) => path.relative(process.cwd(), fullPath).split(path.sep).join('/'));

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
    if (!fs.existsSync(filePath)) {
      expect(fs.existsSync(filePath)).toBe(false);
      return;
    }
    const source = fs.readFileSync(filePath, 'utf8');
    const findings = collectMatches(source, [
      { label: 'imports chat tool-history inspector into TS persistence', pattern: /inspectOpenAiChatToolHistory/ },
      { label: 'imports synthetic tool-call id predicate into TS persistence', pattern: /isSyntheticRouteCodexToolCallId/ },
      { label: 'validates pending injection tool semantics in TS persistence', pattern: /validatePendingInjection/ },
      { label: 'reads tool_call ids for semantic filtering in TS persistence', pattern: /afterToolCallIds[\s\S]{0,240}synthetic|tool_call_id[\s\S]{0,240}message contract/ },
      { label: 'silently swallows pending-session load failures', pattern: /catch\s*\{\s*return null;\s*\}/ },
      { label: 'converts pending-session read failures into no pending session', pattern: /pending injection read failed[\s\S]{0,500}return\s+null\s*;/ },
      { label: 'silently swallows pending-session cleanup failures', pattern: /catch\s*\{[\s\S]{0,180}(?:ignore|no-op|keep original reason visible even if cleanup fails)/ },
      { label: 'uses pending-session drop helper that can hide cleanup failures', pattern: /dropPendingFile\s*\(/ },
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

  it('responses bridge must not run TS tool-history inspectors', () => {
    const repoRoot = process.cwd();
    const files = [
      'sharedmodule/llmswitch-core/src/conversion/responses/responses-openai-bridge.ts',
    ];
    expect(fs.existsSync(path.join(repoRoot, files[0]))).toBe(false);
    const findings: string[] = [];
    for (const relativePath of files) {
      if (!fs.existsSync(path.join(repoRoot, relativePath))) continue;
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

  it('bridge message utils facade must stay physically deleted and responses bridge must call native bridge helpers', () => {
    const repoRoot = process.cwd();
    const retiredPath = path.join(repoRoot, 'sharedmodule/llmswitch-core/src/conversion/bridge-message-utils.ts');
    const historySource = fs.readFileSync(
      path.join(repoRoot, 'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_bridge_actions/history.rs'),
      'utf8',
    );
    const bridgeInputSource = fs.readFileSync(
      path.join(repoRoot, 'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_bridge_actions/bridge_input.rs'),
      'utf8',
    );

    expect(fs.existsSync(retiredPath)).toBe(false);
    expect(fs.existsSync(path.join(repoRoot, 'sharedmodule/llmswitch-core/src/conversion/responses/responses-openai-bridge.ts'))).toBe(false);
    expect(historySource).toContain('build_bridge_history');
    expect(bridgeInputSource).toContain('convert_bridge_input_to_chat_messages');
    expect(historySource).not.toContain('../bridge-message-utils.js');
    expect(bridgeInputSource).not.toContain('../bridge-message-utils.js');
  });

  it('OpenAI message normalize semantic helper shells must stay deleted', () => {
    const repoRoot = process.cwd();
    const forbiddenFiles = [
      'sharedmodule/llmswitch-core/src/conversion/shared/openai-message-normalize-contract.ts',
      'sharedmodule/llmswitch-core/src/conversion/shared/openai-message-normalize-control-text.ts',
      'sharedmodule/llmswitch-core/src/conversion/shared/openai-message-normalize-tool-history.ts',
    ];
    const existing = forbiddenFiles.filter((relativePath) => fs.existsSync(path.join(repoRoot, relativePath)));

    expect(existing).toEqual([]);
  });

  it('responses bridge wrappers must not run TS synthetic control-text inspectors', () => {
    const filePath = path.join(process.cwd(), 'sharedmodule/llmswitch-core/src/conversion/responses/responses-openai-bridge.ts');
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it('servertool orchestration policy must not run TS synthetic control-text recursion', () => {
    const filePath = path.join(process.cwd(), 'sharedmodule/llmswitch-core/src/servertool/orchestration-policy-block.ts');
    if (!fs.existsSync(filePath)) {
      expect(fs.existsSync(filePath)).toBe(false);
      return;
    }
    const source = fs.readFileSync(filePath, 'utf8');
    const findings = collectMatches(source, [
      { label: 'imports TS synthetic control text helper', pattern: /isSyntheticRouteCodexControlText/ },
      { label: 'recurses over Object.values in TS synthetic scan', pattern: /Object\.values\([\s\S]*containsSyntheticRouteCodexControlText/ },
      { label: 'recurses over arrays in TS synthetic scan', pattern: /\.some\(\(entry\) => containsSyntheticRouteCodexControlText\(entry\)\)/ },
    ]);

    expect(findings).toEqual([]);
  });

  it('servertool adapter context module must stay physically removed', () => {
    const filePath = path.join(process.cwd(), 'src/server/runtime/http-server/executor/servertool-adapter-context.ts');
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it('servertool response SSE projection must use post-governance client semantic truth', () => {
    const hostPath = path.join(process.cwd(), 'src/modules/llmswitch/bridge/provider-response-converter-host.ts');
    const nativeCallsPath = path.join(process.cwd(), 'src/modules/llmswitch/bridge/provider-response-native-calls.ts');
    const metadataEffectsPath = path.join(process.cwd(), 'src/modules/llmswitch/bridge/provider-response-metadata-effects.ts');
    const effectsPath = path.join(process.cwd(), 'src/modules/llmswitch/bridge/provider-response-effects.ts');
    const hostSource = fs.readFileSync(hostPath, 'utf8');
    const nativeCallsSource = fs.readFileSync(nativeCallsPath, 'utf8');
    const metadataEffectsSource = fs.readFileSync(metadataEffectsPath, 'utf8');
    const effectsSource = fs.readFileSync(effectsPath, 'utf8');
    const effectPlanRustSource = fs.readFileSync(path.join(
      process.cwd(),
      'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_lib/effect_plan.rs',
    ), 'utf8');
    const splitSources = `${hostSource}\n${nativeCallsSource}\n${metadataEffectsSource}\n${effectsSource}`;
    const findings = collectMatches(splitSources, [
      { label: 'uses stale native streamEffect payload after servertool governance', pattern: /streamEffect\.payload/ },
      { label: 'keeps streamPipe payload as response truth in TS shell', pattern: /payload:\s*streamPayload|streamPayload\s+as\s+JsonObject/ },
      { label: 'scans raw Rust effectPlan kinds in TS shell', pattern: /effectPlan\.effects\.filter\(\(effect\)\s*=>\s*effect\?\.(?:kind|kind\s*===)/ },
      { label: 'ts-post-servertool-responses-endpoint-branch', pattern: /includes\(['"]\/v1\/responses['"]\)/ },
      { label: 'ts-post-servertool-responses-projection-owner', pattern: /buildResponsesPayloadFromChatWithNative/ },
    ]);

    expect(nativeCallsSource).toContain('normalizeProviderResponseEffectPlanWithNative');
    expect(nativeCallsSource).toContain('buildProviderResponseMetadataSnapshotWithNative');
    expect(hostSource).toContain('resolveProviderProtocolWithNative');
    expect(metadataEffectsSource).toContain('projectNativeMetadataWritePlanToRuntimeControlWritePlan');
    expect(effectsSource).toContain('planProviderResponseStoplessRuntimeControlEffectWithNative');
    expect(effectsSource).not.toContain('if (args.runtimeEffects.stoplessMetadataCenterWrite)');
    expect(effectsSource).not.toContain("reason: 'rust response chatprocess runtime control'");
    expect(effectsSource).toContain('planProviderResponseStreamPipeEffectWithNative');
    expect(effectsSource).not.toContain('const codec = readString(streamPipe.codec)');
    expect(effectsSource).not.toContain('const requestId = readString(streamPipe.requestId)');
    expect(effectsSource).not.toContain('const payload = asRecord(streamPipe.payload)');
    expect(effectsSource).not.toContain('Rust HubPipeline response path returned malformed stream pipe effect');
    expect(effectsSource).toContain('recordResponsesResponse(plan.recordArgs)');
    expect(effectsSource).not.toContain("entryKind: 'responses'");
    expect(effectsSource).not.toContain("continuationOwner: 'relay'");
    expect(effectsSource).not.toContain('allowScopeContinuation: true');
    expect(effectsSource).not.toContain('...(plan.recordArgs.sessionId ?');
    expect(hostSource).toContain('const respProcessEffect = await executeProviderResponseNativeServertoolEffects');
    expect(effectPlanRustSource).toContain('server-side tool execution has been removed');
    expect(splitSources).not.toContain('server-side tool execution has been removed');
    expect(splitSources).not.toContain('planProviderResponseServertoolRuntimeActionsWithNative');
    expect(splitSources).not.toContain('resolveProviderResponsePostServertoolEffectWithNative');
    expect(splitSources).not.toContain('projectPostServertoolHubRespOutbound04ClientSemanticWithNative');
    expect(splitSources).not.toContain('if (orchestration.executed)');
    expect(splitSources).not.toContain('actionPlan.executionPlans.some');
    expect(splitSources).not.toContain('runtimeControl.providerProtocol');
    expect(splitSources).not.toContain('Object.keys(runtimeControlProjected)');
    expect(splitSources).not.toContain('return direct;');
    expect(splitSources).not.toContain('return nestedMetadata ? asRecord(nestedMetadata.metadataCenterSnapshot) ?? null : null;');
    expect(hostSource).toContain('buildSseFramesFromJsonWithNative');
    expect(hostSource).toContain('buildReadableFromSseFrames(frameResult.frames)');
    expect(findings).toEqual([]);
  });

  it('metadata write plan runtime-control projection must stay native-owned', () => {
    const filePath = path.join(process.cwd(), 'sharedmodule/llmswitch-core/src/conversion/hub/metadata-center-runtime-control-writer.ts');
    const nativeOwnerPath = path.join(
      process.cwd(),
      'tests/sharedmodule/helpers/hub-pipeline-orchestration-direct-native.ts',
    );
    const nativeOwnerSource = fs.readFileSync(nativeOwnerPath, 'utf8');

    expect(fs.existsSync(filePath)).toBe(false);
    expect(nativeOwnerSource).toContain('projectMetadataWritePlanToRuntimeControlWithNative');
    expect(nativeOwnerSource).toContain('projectMetadataWritePlanToRuntimeControlWritePlanWithNative');
  });

  it('hub pipeline request providerProtocol selection must stay native-owned', () => {
    const deletedHubPipelinePath = path.join(
      process.cwd(),
      'sharedmodule/llmswitch-core/src/conversion/hub/pipeline',
      'hub-pipeline' + '.ts',
    );
    const nativeWrapperSource = fs.readFileSync(
      path.join(
        process.cwd(),
        'tests/sharedmodule/helpers/hub-pipeline-orchestration-direct-native.ts',
      ),
      'utf8',
    );

    expect(fs.existsSync(deletedHubPipelinePath)).toBe(false);
    expect(nativeWrapperSource).toContain('buildHubPipelineMaterializedRequestPlanWithNative');
  });

  it('hub pipeline materialized request control plan must stay native-owned', () => {
    const deletedHubPipelinePath = path.join(
      process.cwd(),
      'sharedmodule/llmswitch-core/src/conversion/hub/pipeline',
      'hub-pipeline' + '.ts',
    );
    const nativeWrapperPath = path.join(
      process.cwd(),
      'tests/sharedmodule/helpers/hub-pipeline-orchestration-direct-native.ts',
    );
    const nativeWrapperSource = fs.readFileSync(nativeWrapperPath, 'utf8');
    const requiredExportsPath = path.join(
      process.cwd(),
      'sharedmodule/llmswitch-core/native-hotpath-required-exports.json',
    );
    const requiredExportsSource = fs.readFileSync(requiredExportsPath, 'utf8');

    expect(fs.existsSync(deletedHubPipelinePath)).toBe(false);
    expect(nativeWrapperSource).toContain('buildHubPipelineMaterializedRequestPlanWithNative');
    expect(requiredExportsSource).toContain('buildHubPipelineMaterializedRequestPlanJson');
  });

  it('provider response orchestration must not grow duplicate V2 owner', () => {
    const duplicateFiles = [
      'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/provider_response_orchestration_v2.rs',
      'sharedmodule/llmswitch-core/src/native/router-hotpath/native-provider-response-orchestration-v2.ts',
      'sharedmodule/llmswitch-core/src/native/router-hotpath/native-provider-response-sse-materialize-fallback.ts',
    ];
    const existingFiles = duplicateFiles.filter((relPath) => fs.existsSync(path.join(process.cwd(), relPath)));
    const functionMap = fs.readFileSync(path.join(process.cwd(), 'docs/architecture/function-map.yml'), 'utf8');
    const verificationMap = fs.readFileSync(path.join(process.cwd(), 'docs/architecture/verification-map.yml'), 'utf8');

    expect(existingFiles).toEqual([]);
    expect(functionMap).not.toContain('hub.resp_chatprocess_orchestration_v2');
    expect(verificationMap).not.toContain('hub.resp_chatprocess_orchestration_v2');
    expect(functionMap).not.toContain('plan_provider_response_orchestration_v2');
    expect(verificationMap).not.toContain('plan_provider_response_orchestration_v2');
  });

  it('virtual router contracts type shell must stay physically deleted', () => {
    const contractsPath = path.join(
      process.cwd(),
      'sharedmodule/llmswitch-core/src/native/router-hotpath/virtual-router-contracts.d.ts',
    );
    const sourceRoots = [
      path.join(process.cwd(), 'sharedmodule/llmswitch-core/src'),
      path.join(process.cwd(), 'src'),
    ];
    const findings: string[] = [];

    for (const root of sourceRoots) {
      for (const fullPath of walkFiles(root, ['.ts', '.tsx', '.js', '.jsx', '.d.ts'])) {
        const relativePath = path.relative(process.cwd(), fullPath).split(path.sep).join('/');
        if (relativePath === 'tests/sharedmodule/hub-pipeline-stage-residue-audit.spec.ts') {
          continue;
        }
        const source = fs.readFileSync(fullPath, 'utf8');
        if (
          /import\s*\{[^}]*\bVirtualRouterError(Code)?\b[^}]*\}\s*from\s*['"][^'"]*virtual-router-contracts\.js['"]/.test(source)
        ) {
          findings.push(`${relativePath}:virtual-router error imported from contracts`);
        }
        if (
          /(?:import|export)\s+(?:type\s+)?(?:[^'"]*?\s+from\s+)?['"][^'"]*virtual-router-contracts\.js['"]/.test(source)
          && !relativePath.startsWith('sharedmodule/llmswitch-core/src/native/router-hotpath/')
        ) {
          findings.push(`${relativePath}:upper layer imports virtual-router contracts directly`);
        }
      }
    }

    expect(fs.existsSync(contractsPath)).toBe(false);
    expect(findings).toEqual([]);
  });

  it('virtual router dry-run metadata envelope must stay Rust-owned', () => {
    const runtimePath = path.join(
      process.cwd(),
      'sharedmodule/llmswitch-core/src/native/router-hotpath/native-virtual-router-runtime.ts',
    );
    expect(fs.existsSync(runtimePath)).toBe(false);
    const helperPath = path.join(
      process.cwd(),
      'tests/sharedmodule/helpers/virtual-router-engine-direct-native.ts',
    );
    const source = fs.readFileSync(helperPath, 'utf8');
    const diagnoseSource = source.slice(
      source.indexOf('  diagnoseRoute('),
      source.indexOf('  resetProviderQuota('),
    );
    const findings = collectMatches(diagnoseSource, [
      { label: 'TS dry-run metadata builder revived', pattern: /buildVirtualRouterDryRunMetadata/ },
      { label: 'TS metadataCenterSnapshot reconstruction revived', pattern: /metadataCenterSnapshot:\s*snapshot/ },
      { label: 'TS diagnostic excludedProviderKeys merge revived', pattern: /excludedProviderKeys['"]/ },
      { label: 'TS diagnostic record guard revived', pattern: /function\s+isPlainRecord/ },
    ]);

    expect(findings).toEqual([]);
  });

  it('virtual router token estimate normalization must stay Rust-owned', () => {
    const runtimePath = path.join(
      process.cwd(),
      'sharedmodule/llmswitch-core/src/native/router-hotpath/native-virtual-router-runtime.ts',
    );
    expect(fs.existsSync(runtimePath)).toBe(false);
    const source = fs.readFileSync(path.join(
      process.cwd(),
      'tests/sharedmodule/helpers/virtual-router-engine-direct-native.ts',
    ), 'utf8');
    const estimatorSource = source.slice(
      source.indexOf('export function countRequestTokens'),
      source.indexOf('export function countRequestTokens'),
    ) + source.slice(
      source.indexOf('export function countRequestTokens'),
      source.indexOf('export function computeRequestTokens'),
    );
    const findings = collectMatches(estimatorSource, [
      { label: 'TS token estimate rounding revived', pattern: /Math\.round/ },
      { label: 'TS token estimate clamp revived', pattern: /Math\.max/ },
      { label: 'TS token estimate fallback revived', pattern: /fallbackText|fallback/i },
    ]);

    expect(findings).toEqual([]);
  });

  it('virtual router stop-message status label must stay Rust-owned', () => {
    const hostEffectsPath = path.join(
      process.cwd(),
      'sharedmodule/llmswitch-core/src/native/router-hotpath/native-virtual-router-runtime.ts',
    );
    expect(fs.existsSync(hostEffectsPath)).toBe(false);
    const source = fs.readFileSync(path.join(
      process.cwd(),
      'tests/sharedmodule/helpers/virtual-router-engine-direct-native.ts',
    ), 'utf8');
    const statusLabelSource = source.slice(
      source.indexOf('export function formatStopMessageStatusLabel'),
      source.indexOf('export function createVirtualRouterRouteHostEffects'),
    );
    const findings = collectMatches(statusLabelSource, [
      { label: 'TS stop status cleared label revived', pattern: /\[stopMessage:scope=\$\{[^}]+}\s+active=no\s+state=cleared\]/ },
      { label: 'TS stop status active label revived', pattern: /\[stopMessage:scope=\$\{[^}]+}\s+text="/ },
      { label: 'TS stop status repeat math revived', pattern: /Math\.(?:max|floor)\(/ },
      { label: 'TS stop status text truncation revived', pattern: /slice\(0,\s*21\)/ },
    ]);

    expect(findings).toEqual([]);
  });

  it('retired native virtual router runtime TS shell must stay absent', () => {
    expect(fs.existsSync(path.join(
      process.cwd(),
      'sharedmodule/llmswitch-core/src/native/router-hotpath/native-virtual-router-runtime.ts',
    ))).toBe(false);
  });

  it('retired virtual router host-effects TS shell must stay absent', () => {
    expect(fs.existsSync(path.join(
      process.cwd(),
      'sharedmodule/llmswitch-core/src/runtime/virtual-router-host-effects.ts',
    ))).toBe(false);
  });

  it('compat profile registry TS parallel implementation must stay deleted', () => {
    const deletedFiles = [
      'sharedmodule/llmswitch-core/src/conversion/compat/profile-registry/header-policies.ts',
      'sharedmodule/llmswitch-core/src/conversion/compat/profile-registry/policy-overrides.ts',
      'sharedmodule/llmswitch-core/src/conversion/compat/profile-registry/provider-resolver.ts',
      'sharedmodule/llmswitch-core/src/conversion/compat/profile-registry/registry.ts',
      'sharedmodule/llmswitch-core/src/conversion/compat/profile-registry/types.ts',
    ];
    const existingFiles = deletedFiles.filter((relPath) => fs.existsSync(path.join(process.cwd(), relPath)));
    const sourceRoots = [
      path.join(process.cwd(), 'sharedmodule/llmswitch-core/src'),
      path.join(process.cwd(), 'src'),
    ];
    const findings = [...existingFiles];

    for (const root of sourceRoots) {
      for (const fullPath of walkFiles(root, ['.ts', '.tsx', '.js', '.jsx', '.d.ts'])) {
        const relativePath = path.relative(process.cwd(), fullPath).split(path.sep).join('/');
        if (relativePath === 'tests/sharedmodule/hub-pipeline-stage-residue-audit.spec.ts') {
          continue;
        }
        const source = fs.readFileSync(fullPath, 'utf8');
        if (
          /applyHeaderPolicies|shouldSkipPolicy|detectProviderTypeFromConfig|resolveOutboundProfileFromConfig|resolveDefaultCompatibilityProfileFromConfig|loadCompatProfileRegistry|CompatProfileRegistry|HeaderPolicyRule|PolicyOverrideConfig/.test(source)
        ) {
          findings.push(relativePath);
        }
      }
    }

    expect(findings).toEqual([]);
  });

  it('stop_message schema budget must be restored from MetadataCenter stopless runtime control only', () => {
    const nativeWrapperPath = path.join(
      process.cwd(),
      'src/modules/llmswitch/bridge/native-exports.ts',
    );
    const stopMessageNativePath = path.join(
      process.cwd(),
      'sharedmodule/llmswitch-core/src/native/router-hotpath/native-stop-message-auto-semantics.ts',
    );
    const rustLookupPath = path.join(
      process.cwd(),
      'sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/persisted_lookup.rs',
    );
    const nativeWrapperSource = fs.readFileSync(nativeWrapperPath, 'utf8');
    const rustLookupSource = fs.readFileSync(rustLookupPath, 'utf8');
    const rustRuntimeStateStart = rustLookupSource.indexOf('pub fn resolve_runtime_stop_message_state(');
    const rustRuntimeStateEnd = rustLookupSource.indexOf(
      'pub fn read_runtime_stop_message_stage_mode',
      rustRuntimeStateStart,
    );
    expect(rustRuntimeStateStart).toBeGreaterThanOrEqual(0);
    expect(rustRuntimeStateEnd).toBeGreaterThan(rustRuntimeStateStart);
    const rustRuntimeStateBlock = rustLookupSource.slice(rustRuntimeStateStart, rustRuntimeStateEnd);

    expect(rustLookupSource).toContain('pub fn resolve_runtime_stop_message_state');
    expect(rustLookupSource).not.toContain('pub fn read_servertool_followup_flow_id');
    expect(rustLookupSource).not.toContain('STOP_MESSAGE_FOLLOWUP_FLOW_ID');
    expect(rustLookupSource).toContain('STOPLESS_FLOW_ID');
    expect(rustRuntimeStateBlock).toContain('runtime_control.get("stopless")');
    expect(rustRuntimeStateBlock).not.toContain('runtime.get("serverToolLoopState")');
    expect(rustRuntimeStateBlock).not.toContain('runtime.get("stopMessageState")');
    expect(rustRuntimeStateBlock).not.toContain('loop_state.get("repeatCount")');
    expect(nativeWrapperSource).not.toContain('resolveRuntimeStopMessageStateWithNative');
    expect(nativeWrapperSource).not.toContain('readRuntimeStopMessageStageModeWithNative');
    expect(nativeWrapperSource).not.toContain('readServertoolFollowupFlowIdWithNative');
    expect(nativeWrapperSource).not.toContain('resolveRuntimeStopMessageStateFromMetadataCenterWithNative');
    expect(fs.existsSync(stopMessageNativePath)).toBe(false);
  });
});
