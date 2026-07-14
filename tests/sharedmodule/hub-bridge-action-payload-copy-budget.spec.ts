import fs from 'node:fs';
import path from 'node:path';

const pipelinePath = path.join(
  process.cwd(),
  'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_bridge_actions/pipeline.rs'
);

describe('Hub bridge action payload copy budget', () => {
  it('does not clone complete raw request/response state per action', () => {
    const source = fs.readFileSync(pipelinePath, 'utf8');

    expect(source).not.toContain('state.raw_request.clone()');
    expect(source).not.toContain('state.raw_response.clone()');
    expect(source).not.toContain('state.captured_tool_results.clone()');
    expect(source).not.toContain('state.metadata.clone()');
    expect(source).not.toContain('.map(|items| items.clone())');
  });
});
