import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const TYPES_DIR = path.join(
  ROOT,
  'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_types'
);

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function readType(file: string): string {
  return fs.readFileSync(path.join(TYPES_DIR, file), 'utf8');
}

describe('Hub Pipeline VR/provider boundary contract', () => {
  it('defines canonical VR/provider boundary types', () => {
    const sources = ['vr_route_04_selected_target.rs', 'provider_req_outbound_06_wire_payload.rs', 'mod.rs']
      .map(readType)
      .join('\n');
    for (const token of [
      'VrRoute04SelectedTarget',
      'ProviderReqOutbound06WirePayload',
      'build_vr_route_04_from_hub_req_chatprocess_03',
      'build_provider_req_outbound_06_from_hub_req_outbound_05',
      'HubReqOutbound05ProviderSemantic',
    ]) {
      expect(sources).toContain(token);
    }
  });

  it('forbids VR selected target from carrying payload patch or tool governance fields', () => {
    const source = readType('vr_route_04_selected_target.rs');
    expect(source).toContain('assert_no_payload_patch_fields');
    for (const token of ['patchedPayload', 'providerPayload', 'wirePayload', 'tool_calls']) {
      expect(source).toContain(token);
    }
    expect(source).not.toMatch(/apply_tool|govern_tool|tool_governance|build_provider_wire/i);
  });

  it('forbids provider wire payload from carrying metadata or SDK metadata options', () => {
    const source = readType('provider_req_outbound_06_wire_payload.rs');
    expect(source).toContain('assert_no_inline_metadata');
    expect(source).toContain('assert_no_provider_options_metadata');
    expect(source).toContain('assert_payload_has_no_meta_or_error_carrier');
    expect(source).toContain('provider SDK options');
  });

  it('keeps Hub Pipeline and Virtual Router free of provider-specific boundary shortcuts', () => {
    const files = [
      'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_types/vr_route_04_selected_target.rs',
      'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_types/provider_req_outbound_06_wire_payload.rs',
      'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_types/mod.rs',
    ];
    const forbidden = [
      /build_provider_req_outbound_06_from_hub_req_chatprocess_03/,
      /build_provider_req_outbound_06_from_hub_req_inbound_02/,
      /build_vr_route_04_from_hub_req_inbound_02/,
      /metadata\.context/,
      /rawBody\.metadata/,
    ];
    const violations: string[] = [];
    for (const file of files) {
      const source = read(file);
      for (const pattern of forbidden) {
        if (pattern.test(source)) violations.push(`${file}: ${pattern}`);
      }
    }
    expect(violations).toEqual([]);
  });
});
