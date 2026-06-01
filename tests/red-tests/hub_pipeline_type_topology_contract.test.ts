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

describe('Hub Pipeline request type topology contract', () => {
  it('defines the Phase 1 request skeleton files', () => {
    const expected = [
      'hub_req_inbound_02_standardized.rs',
      'hub_req_chatprocess_03_governed.rs',
      'hub_req_outbound_05_provider_semantic.rs',
    ];
    for (const file of expected) {
      expect(fs.existsSync(path.join(HUB_TYPES_DIR, file))).toBe(true);
    }
  });

  it('uses the canonical inbound/chatprocess/outbound type names', () => {
    const sources = walk(HUB_TYPES_DIR).map((file) => fs.readFileSync(file, 'utf8')).join('\n');
    for (const token of [
      'HubReqInbound02Standardized',
      'HubReqChatProcess03Governed',
      'HubReqOutbound05ProviderSemantic',
      'build_hub_req_chatprocess_03_from_hub_req_inbound_02',
      'build_hub_req_outbound_05_from_hub_req_chatprocess_03',
    ]) {
      expect(sources).toContain(token);
    }
  });

  it('forbids new generic ReqProc/req_process names in the topology type skeleton', () => {
    const violations: string[] = [];
    for (const file of walk(HUB_TYPES_DIR)) {
      const source = fs.readFileSync(file, 'utf8');
      for (const pattern of [/ReqProc/, /req_process/, /HubReqProcess/]) {
        if (pattern.test(source)) violations.push(`${file}: ${pattern}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('forbids non-adjacent request builders and provider wire shortcut builders', () => {
    const violations: string[] = [];
    for (const file of walk(HUB_TYPES_DIR)) {
      const source = fs.readFileSync(file, 'utf8');
      const forbidden = [
        /build_hub_req_outbound_05_from_hub_req_inbound_02/,
        /build_provider_req_outbound_06_from_hub_req_inbound_02/,
        /build_provider_req_outbound_06_from_hub_req_chatprocess_03/,
      ];
      for (const pattern of forbidden) {
        if (pattern.test(source)) violations.push(`${file}: ${pattern}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('forbids inline metadata as normal request payload in Phase 1 type skeleton', () => {
    const sources = walk(HUB_TYPES_DIR).map((file) => fs.readFileSync(file, 'utf8')).join('\n');
    expect(sources).toContain('assert_no_inline_metadata');
    expect(sources).toContain('Meta* carrier');
    expect(sources).not.toMatch(/metadata:\s*Value/);
    expect(sources).not.toMatch(/pub\(crate\) metadata/);
    expect(sources).not.toMatch(/pub metadata/);
  });

  it('keeps topology docs aligned with Phase naming', () => {
    const topology = read('docs/design/pipeline-type-topology-and-module-boundaries.md');
    expect(topology).toContain('<Module><Phase><NN><Node>');
    expect(topology).toContain('HubReqInbound02Standardized');
    expect(topology).toContain('HubReqChatProcess03Governed');
    expect(topology).toContain('HubReqOutbound05ProviderSemantic');
  });
});
