import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const HUB_TYPES_DIR = path.join(
  ROOT,
  'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_types'
);

function read(relativePath: string): string {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function walk(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  const stat = fs.statSync(dir);
  if (stat.isFile()) {
    if (dir.endsWith('.rs') || dir.endsWith('.ts')) out.push(dir);
    return out;
  }
  for (const entry of fs.readdirSync(dir)) {
    walk(path.join(dir, entry), out);
  }
  return out;
}

function responseSources(): string {
  return [
    'hub_resp_inbound_02_parsed.rs',
    'hub_resp_chatprocess_03_governed.rs',
    'hub_resp_outbound_04_client_semantic.rs',
    'response_typed_entrypoints.rs',
    'mod.rs',
  ]
    .map((file) => fs.readFileSync(path.join(HUB_TYPES_DIR, file), 'utf8'))
    .join('\n');
}

describe('Hub Pipeline response type topology contract', () => {
  it('defines the Phase 2 response skeleton files', () => {
    const expected = [
      'hub_resp_inbound_02_parsed.rs',
      'hub_resp_chatprocess_03_governed.rs',
      'hub_resp_outbound_04_client_semantic.rs',
    ];
    for (const file of expected) {
      expect(fs.existsSync(path.join(HUB_TYPES_DIR, file))).toBe(true);
    }
  });

  it('uses the canonical resp_inbound/resp_chatprocess/resp_outbound type names', () => {
    const sources = responseSources();
    for (const token of [
      'HubRespInbound02Parsed',
      'HubRespChatProcess03Governed',
      'HubRespOutbound04ClientSemantic',
      'parse_hub_resp_inbound_02_from_provider_resp_inbound_01',
      'build_hub_resp_chatprocess_03_from_hub_resp_inbound_02',
      'project_hub_resp_outbound_04_from_hub_resp_chatprocess_03',
      'run_hub_resp_inbound_02_parsed_entrypoint',
      'run_hub_resp_chatprocess_03_governed_entrypoint',
      'run_hub_resp_outbound_04_client_semantic_entrypoint',
    ]) {
      expect(sources).toContain(token);
    }
  });

  it('wires Phase 6B-2 wrappers into the Rust live response engine', () => {
    const source = read('sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_lib/engine.rs');
    for (const token of [
      'run_hub_resp_inbound_02_parsed_entrypoint',
      'run_hub_resp_chatprocess_03_governed_entrypoint',
      'run_hub_resp_outbound_04_client_semantic_entrypoint',
    ]) {
      expect(source).toContain(token);
    }
    expect(source).toContain('govern_hub_resp_chatprocess_03_response');
    expect(source).toContain('finalize_chat_response');
    expect(source).toContain('build_client_payload_for_protocol');
  });

  it('forbids new generic RespProc/resp_process names in the topology type skeleton', () => {
    const violations: string[] = [];
    for (const file of walk(HUB_TYPES_DIR)) {
      const source = fs.readFileSync(file, 'utf8');
      for (const pattern of [/RespProc/, /resp_process/, /HubRespProcess/]) {
        if (pattern.test(source)) violations.push(`${file}: ${pattern}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('forbids provider raw to server client frame shortcuts', () => {
    const violations: string[] = [];
    for (const file of walk(HUB_TYPES_DIR)) {
      const source = fs.readFileSync(file, 'utf8');
      const forbidden = [
        /build_server_resp_outbound_05_from_provider_resp_inbound_01/,
        /project_server_resp_outbound_05_from_provider_resp_inbound_01/,
        /ServerRespOutbound05ClientFrame/,
        /ProviderRespInbound01Raw[\s\S]{0,120}ServerRespOutbound05ClientFrame/,
      ];
      for (const pattern of forbidden) {
        if (pattern.test(source)) violations.push(`${file}: ${pattern}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('forbids inline metadata and success-wrapped errors in normal response payload', () => {
    const sources = responseSources();
    expect(sources).toContain('assert_no_inline_metadata');
    expect(sources).toContain('Meta* carrier');
    expect(sources).toContain('assert_not_success_error_payload');
    expect(sources).toContain('Error* condition');
    expect(sources).not.toMatch(/metadata:\s*Value/);
    expect(sources).not.toMatch(/pub\(crate\) metadata/);
    expect(sources).not.toMatch(/pub metadata/);
  });

  it('keeps topology docs aligned with response Phase naming', () => {
    const topology = read('docs/design/pipeline-type-topology-and-module-boundaries.md');
    expect(topology).toContain('<Module><Phase><NN><Node>');
    expect(topology).toContain('HubRespInbound02Parsed');
    expect(topology).toContain('HubRespChatProcess03Governed');
    expect(topology).toContain('HubRespOutbound04ClientSemantic');
  });
});
