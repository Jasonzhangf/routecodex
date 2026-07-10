/**
 * Server module help contract red test.
 * Phase Server-A: server runtime modules must be online-queryable with
 * owner/allowed/forbidden/red tests. Locks Phase Server-A.
 */

import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const TYPES_DIR = path.join(ROOT, 'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src');

const REQUIRED_MODULES = [
  'server.req_adapter',
  'server.direct_passthrough',
  'server.response_projection',
  'server.error_projection',
  'server.error_action_queue',
] as const;

const FORBIDDEN_CARRIERS = [
  'metadata', 'metaCarrier', 'runtimeMetadata',
  'errorCarrier', 'classifiedError', '__rt', 'snapshot',
];

function readSrc(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

describe('Server module help contract (Phase Server-A)', () => {
  it('defines server_contracts.rs source with all 4 module descriptors', () => {
    const source = fs.readFileSync(path.join(TYPES_DIR, 'server_contracts.rs'), 'utf8');
    for (const moduleId of REQUIRED_MODULES) {
      expect(source).toContain(`module_id: "${moduleId}"`);
    }
  });

  it('every module forbids internal carriers: metadata/metaCarrier/__rt/snapshot', () => {
    const source = fs.readFileSync(path.join(TYPES_DIR, 'server_contracts.rs'), 'utf8');
    for (const carrier of FORBIDDEN_CARRIERS) {
      const count = (source.match(new RegExp(`"${carrier}"`, 'g')) || []).length;
      expect(count).toBeGreaterThanOrEqual(REQUIRED_MODULES.length);
    }
  });

  it('NAPI bindings register describe_server_contracts_json and describe_server_module_help_json', () => {
    const napi = readSrc('sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_blocks/napi_bindings.rs');
    expect(napi).toContain('describe_server_contracts_json');
    expect(napi).toContain('describe_server_module_help_json');
  });

  it('required-exports allowlist includes new NAPI function names', () => {
    const ex = readSrc('sharedmodule/llmswitch-core/native-hotpath-required-exports.json');
    expect(ex).toContain('describeServerContractsJson');
    expect(ex).toContain('describeServerModuleHelpJson');
  });

  it('TS wrappers expose describeServerContractsWithNative and describeServerModuleHelpWithNative', () => {
    const ts = readSrc('src/modules/llmswitch/bridge/native-exports.ts');
    expect(ts).toContain('describeServerContractsWithNative');
    expect(ts).toContain('describeServerModuleHelpWithNative');
  });

  it('Phase Server-A is read-only: server_contracts.rs has no #[napi_derive::napi] in its own file', () => {
    const source = fs.readFileSync(path.join(TYPES_DIR, 'server_contracts.rs'), 'utf8');
    expect(source).not.toContain('#[napi_derive::napi]');
  });

  it('contract allowed fields stay in sync with handler-utils whitelist (requestSource, experimentFlag, appVersion)', () => {
    const hu = fs.readFileSync('src/server/handlers/handler-utils.ts', 'utf8');
    const src = fs.readFileSync('sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/server_contracts.rs', 'utf8');
    for (const field of ['requestSource', 'experimentFlag', 'appVersion']) {
      expect(hu).toContain("'" + field + "'");
      expect(src).toContain('"' + field + '"');
    }
  });

  it('documents unified error action queue fixed-cycle blocking policy', () => {
    const src = fs.readFileSync('sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/server_contracts.rs', 'utf8');
    const queue = readSrc('src/server/runtime/http-server/executor/request-executor-error-action-queue.ts');
    expect(src).toContain('module_id: "server.error_action_queue"');
    expect(src).toContain('owner_builder: Some("describeErrorActionQueueContract")');
    for (const token of ['1s -> 3s -> 5s -> repeat', 'servertool_followup']) {
      expect(src).toContain(token);
    }
    expect(queue).toContain('feature_id: error.backoff_action_queue');
    expect(queue).toContain('describeErrorActionQueueContract');
    expect(queue).toContain('ERROR_ACTION_DELAY_SEQUENCE_MS = [1_000, 3_000, 5_000]');
  });
});
