import fs from 'node:fs';
import path from 'node:path';

const crateRoot = path.join(
  process.cwd(),
  'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src',
);

describe('StreamPipe response payload ownership', () => {
  it('keeps the full client response only in the top-level response node', () => {
    const engineSource = fs.readFileSync(
      path.join(crateRoot, 'hub_pipeline_lib/engine.rs'),
      'utf8',
    );
    const streamBlock = engineSource.match(
      /if stream_decision\.should_stream \{[\s\S]*?let effect_plan = HubPipelineEffectPlan/,
    )?.[0];

    expect(streamBlock).toBeDefined();
    expect(streamBlock).not.toContain('stream_decision.payload.clone()');
    expect(streamBlock).not.toMatch(/"payload":\s*stream_decision\.payload/);
    expect(engineSource).toContain('payload: Some(stream_decision.payload)');
  });

  it('keeps StreamPipe effects metadata-only and reuses the materialized client payload in TS', () => {
    const effectPlanSource = fs.readFileSync(
      path.join(crateRoot, 'hub_pipeline_lib/effect_plan.rs'),
      'utf8',
    );
    const nativeCallsSource = fs.readFileSync(
      path.join(process.cwd(), 'src/modules/llmswitch/bridge/provider-response-native-calls.ts'),
      'utf8',
    );
    const hostSource = fs.readFileSync(
      path.join(process.cwd(), 'src/modules/llmswitch/bridge/provider-response-converter-host.ts'),
      'utf8',
    );
    const plannerStart = effectPlanSource.indexOf(
      '// feature_id: hub.provider_response_stream_pipe_effect_plan',
    );
    const plannerEnd = effectPlanSource.indexOf(
      'pub fn project_metadata_write_plan_to_runtime_control_write_plan_json',
      plannerStart,
    );
    const plannerBlock = plannerStart >= 0 && plannerEnd > plannerStart
      ? effectPlanSource.slice(plannerStart, plannerEnd)
      : undefined;

    expect(plannerBlock).toBeDefined();
    expect(effectPlanSource).toContain('fn ensure_stream_pipe_metadata_only');
    expect(plannerBlock).not.toContain('pipe.get("payload")');
    expect(plannerBlock).not.toMatch(/"payload":\s*payload/);
    expect(nativeCallsSource).not.toContain(
      'pipe: { codec: string; requestId: string; payload: Record<string, unknown> }',
    );
    expect(hostSource).not.toContain('const streamClientSemantic = streamPipe.payload;');
    expect(hostSource).toContain(
      'const streamClientSemantic = hubRespOutbound04ClientSemantic;',
    );
  });
});
