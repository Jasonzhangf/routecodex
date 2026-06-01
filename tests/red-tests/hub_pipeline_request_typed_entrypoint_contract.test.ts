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

describe('Hub Pipeline request typed entrypoint contract', () => {
  it('defines Phase 6A request typed wrappers', () => {
    const source = readType('request_typed_entrypoints.rs');
    for (const token of [
      'run_hub_req_inbound_02_standardized_entrypoint',
      'run_hub_req_chatprocess_03_governed_entrypoint',
      'run_hub_req_outbound_05_provider_semantic_entrypoint',
    ]) {
      expect(source).toContain(token);
    }
  });

  it('keeps wrappers as type-boundary delegators only', () => {
    const source = readType('request_typed_entrypoints.rs');
    for (const token of [
      'build_hub_req_inbound_02_from_payload',
      'build_hub_req_chatprocess_03_from_hub_req_inbound_02',
      'build_hub_req_outbound_05_from_hub_req_chatprocess_03',
    ]) {
      expect(source).toContain(token);
    }
    for (const forbidden of [
      /run_req_process_pipeline/,
      /apply_req_process_tool_governance/,
      /apply_route_selection/,
      /build_format_request/,
      /provider-specific/i,
      /fallback/i,
    ]) {
      expect(source).not.toMatch(forbidden);
    }
  });

  it('does not wire Phase 6A wrappers into live runtime paths yet', () => {
    const liveFiles = [
      'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline.rs',
      'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_lib/engine.rs',
      'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/lib.rs',
    ];
    const wrapperNames = [
      'run_hub_req_inbound_02_standardized_entrypoint',
      'run_hub_req_chatprocess_03_governed_entrypoint',
      'run_hub_req_outbound_05_provider_semantic_entrypoint',
    ];
    const violations: string[] = [];
    for (const file of liveFiles) {
      const source = read(file);
      for (const name of wrapperNames) {
        if (source.includes(name)) violations.push(`${file}: ${name}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('keeps topology docs aligned with Phase 6A plan', () => {
    const plan = read('docs/goals/hub-pipeline-typed-entrypoint-migration-plan.md');
    expect(plan).toContain('Phase 6A：Request typed entrypoint wrapper');
    expect(plan).toContain('run_hub_req_inbound_02_standardized_entrypoint');
    expect(plan).toContain('不切调用点');
  });
});
