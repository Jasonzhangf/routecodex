import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();

function read(relative: string): string {
  return fs.readFileSync(path.join(ROOT, relative), 'utf8');
}

describe('request field semantics no raw/context/metadata backfill', () => {
  it('does not revive removed followup request-field patch DSL', () => {
    const files = [
      'src/server/runtime/http-server/executor/servertool-followup-dispatch.ts',
      'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/servertool_followup_delta.rs',
      'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/chat_servertool_orchestration.rs',
      'sharedmodule/llmswitch-core/src/servertool/handlers/vision.ts',
      'sharedmodule/llmswitch-core/src/servertool/handlers/web-search.ts',
      'sharedmodule/llmswitch-core/src/servertool/types.ts',
    ];
    const forbidden = [
      'restoreFollowupRootToolsIfNeeded',
      'preserve_tools',
      'ensure_standard_tools',
      'replace_tools',
      'force_tool_choice',
      'drop_tool_by_name',
    ];
    const violations: string[] = [];
    for (const file of files) {
      const source = read(file);
      for (const token of forbidden) {
        if (source.includes(token)) violations.push(`${file}: ${token}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('does not merge raw request fields into Vercel provider SDK transport body', () => {
    const file = 'src/providers/core/runtime/vercel-ai-sdk/openai-sdk-transport.ts';
    const source = read(file);
    const forbidden = [
      'mergePreservedOpenAiRequestFields',
      '__raw_request_body',
      'rawBody',
      'contextSnapshot',
      'requestMetadata',
      'responsesContext',
      'toolsRaw',
      'clientToolsRaw',
    ];
    const violations = forbidden.filter((token) => source.includes(token));
    expect(violations).toEqual([]);
  });

  it('keeps ProviderReqOutbound06 as the provider-wire fail-fast boundary', () => {
    const source = read(
      'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_types/provider_req_outbound_06_wire_payload.rs'
    );
    for (const token of [
      'toolsRaw',
      'clientToolsRaw',
      'responsesContext',
      'contextSnapshot',
      'requestMetadata',
      '__raw_request_body',
      'rawBody',
      'namespace tool aggregate',
    ]) {
      expect(source).toContain(token);
    }
  });

  it('documents duplicate request-semantics entrances until Rust equivalence tests delete them', () => {
    const doc = read('docs/goals/request-field-chatprocess-equivalence-audit-plan.md');
    for (const token of [
      'V2 conversion pipeline codecs have been physically deleted',
      'hub_bridge_actions/history.rs',
      'provider-response-utils.ts',
      'responses-handler.ts',
      '等价语义红测缺口',
    ]) {
      expect(doc).toContain(token);
    }
  });

  it('keeps deleted V2 conversion pipeline codecs absent', () => {
    for (const relativePath of [
      'sharedmodule/llmswitch-core/src/conversion/pipeline',
      'sharedmodule/llmswitch-core/dist/conversion/pipeline',
      'tests/sharedmodule/responses-openai-pipeline-request-parameters.spec.ts',
    ]) {
      expect(fs.existsSync(path.join(ROOT, relativePath))).toBe(false);
    }
  });
});
