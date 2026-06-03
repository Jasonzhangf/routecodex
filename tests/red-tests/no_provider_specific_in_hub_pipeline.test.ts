/**
 * 红测试门禁：Hub Pipeline 不得出现 ProviderForwarder 字符串
 *
 * 硬护栏 §3.6 约束：
 * - 不得在 hub_bridge_actions / req_process / resp_process / hub_pipeline 写 forwarder 字符串
 * - 防止 Hub Pipeline 误入 forwarder 逻辑（forwarder 是 Virtual Router 内部抽象）
 *
 * 允许的目录（白名单）：
 * - src/providers/profile/forwarder-*
 * - sharedmodule/llmswitch-core/rust-core/.../virtual_router_engine/forwarder.rs
 * - tests/providers/forwarder-selection.spec.ts
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const HUB_PIPELINE_PATHS = [
  path.join(ROOT, 'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_bridge_actions'),
  path.join(ROOT, 'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/req_process'),
  path.join(ROOT, 'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/resp_process'),
  path.join(ROOT, 'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_blocks'),
  path.join(ROOT, 'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_bridge_policies.rs'),
  path.join(ROOT, 'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline.rs'),
  path.join(ROOT, 'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_chat_envelope_validator.rs'),
];

const FORBIDDEN_TOKENS = [
  'forwarder',
  'fwd.',
  'FORWARDER_',
  'ProviderForwarder',
  'ForwarderRegistry',
];

function walkDir(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  const stat = fs.statSync(dir);
  if (stat.isFile()) {
    if (dir.endsWith('.rs') || dir.endsWith('.ts') || dir.endsWith('.tsx') || dir.endsWith('.js')) {
      out.push(dir);
    }
    return out;
  }
  for (const entry of fs.readdirSync(dir)) {
    walkDir(path.join(dir, entry), out);
  }
  return out;
}

describe('Hub Pipeline must not reference ProviderForwarder', () => {
  const files: string[] = [];
  beforeAll(() => {
    for (const p of HUB_PIPELINE_PATHS) {
      walkDir(p, files);
    }
  });

  it('scans the expected number of files', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('no file contains forbidden forwarder tokens', () => {
    const violations: string[] = [];
    for (const file of files) {
      const content = fs.readFileSync(file, 'utf-8');
      for (const token of FORBIDDEN_TOKENS) {
        if (content.includes(token)) {
          violations.push(`${file}: contains "${token}"`);
        }
      }
    }
    if (violations.length > 0) {
      throw new Error(
        `ProviderForwarder leaked into Hub Pipeline (${violations.length} files):\n  ${violations.slice(0, 10).join('\n  ')}`
      );
    }
    expect(violations).toHaveLength(0);
  });
});
