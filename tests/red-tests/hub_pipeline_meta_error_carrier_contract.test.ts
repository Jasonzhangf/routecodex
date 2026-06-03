import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const TYPES_DIR = path.join(
  ROOT,
  'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_types'
);

function readType(file: string): string {
  return fs.readFileSync(path.join(TYPES_DIR, file), 'utf8');
}

describe('Hub Pipeline Meta/Error carrier contract', () => {
  it('defines Meta* and Error* carrier types outside normal payload wrappers', () => {
    const source = readType('meta_error_carriers.rs');
    for (const token of [
      'MetaReq02RuntimeCarrier',
      'MetaRoute03RouteCarrier',
      'ErrorErr03RuntimeClassified',
      'build_meta_req_02_runtime_carrier',
      'build_meta_route_03_from_metadata',
      'build_error_err_03_runtime_classified',
      'assert_payload_has_no_meta_or_error_carrier',
    ]) {
      expect(source).toContain(token);
    }
  });

  it('defines MetaRoute03 as the only VR routing-control carrier builder', () => {
    const source = readType('meta_error_carriers.rs');
    for (const token of [
      'allowedProviders',
      'excludedProviderKeys',
      'disabledProviderKeyAliases',
      '__shadowCompareForcedProviderKey',
      '__routecodexRetryProviderKey',
      'routeHint',
      'routecodexRoutingPolicyGroup',
    ]) {
      expect(source).toContain(token);
    }
    expect(source).toContain('copy_normalized_string_array');
    expect(source).toContain('copy_non_empty_string');
  });

  it('requires request and pipeline identity for Meta carrier', () => {
    const source = readType('meta_error_carriers.rs');
    expect(source).toContain('request_id.trim().is_empty()');
    expect(source).toContain('pipeline_id.trim().is_empty()');
  });

  it('forbids normal req/resp payload wrappers from embedding Meta/Error carriers', () => {
    const files = [
      'hub_req_outbound_05_provider_semantic.rs',
      'provider_req_outbound_06_wire_payload.rs',
      'hub_resp_outbound_04_client_semantic.rs',
    ];
    for (const file of files) {
      expect(readType(file)).toContain('assert_payload_has_no_meta_or_error_carrier');
    }
  });

  it('forbids response success payloads from carrying errors', () => {
    const files = [
      'hub_resp_inbound_02_parsed.rs',
      'hub_resp_chatprocess_03_governed.rs',
      'hub_resp_outbound_04_client_semantic.rs',
    ];
    for (const file of files) {
      expect(readType(file)).toContain('assert_not_success_error_payload');
    }
  });
});
