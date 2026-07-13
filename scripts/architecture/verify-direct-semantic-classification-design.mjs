import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

// feature_id: hub.direct_semantic_classification
const root = process.cwd();

function read(relPath) {
  return fs.readFileSync(path.join(root, relPath), 'utf8');
}

function requireText(failures, source, expected, label) {
  if (!source.includes(expected)) {
    failures.push(`${label}: missing ${expected}`);
  }
}

export function verifyDirectSemanticClassificationDesign() {
  const failures = [];
  const design = read('docs/design/direct-semantic-classification.md');
  const testDesign = read('docs/goals/direct-semantic-classification-test-design.md');
  const resourceMap = YAML.parse(read('docs/architecture/resource-operation-map.yml'));
  const functionMap = YAML.parse(read('docs/architecture/function-map.yml'));
  const callMap = YAML.parse(read('docs/architecture/mainline-call-map.yml'));

  for (const expected of [
    'ConfigDirect01AuthoringPolicy',
    'ConfigDirect02ValidatedPolicy',
    'VrDirect03ResolvedSemantics',
    'DirectReq04ProjectionPlan',
    'DirectResp05ProjectionPlan',
    'routing',
    'passthrough',
  ]) {
    requireText(failures, design, expected, 'design');
  }

  for (const forbidden of [
    'modelPassthrough = true',
    'thinkingPassthrough = true',
    'restoreResponseModel = false',
  ]) {
    if (!design.includes(forbidden)) {
      failures.push(`design: missing forbidden-combination example ${forbidden}`);
    }
  }

  const resource = resourceMap.resources?.find(
    (entry) => entry?.resource_id === 'direct.semantic_policy',
  );
  if (!resource) {
    failures.push('resource map: missing direct.semantic_policy');
  } else {
    if (resource.owner_node !== 'VrDirect03ResolvedSemantics') {
      failures.push('resource map: direct.semantic_policy owner_node must be VrDirect03ResolvedSemantics');
    }
    if (
      !Array.isArray(resource.allowed_writers)
      || resource.allowed_writers.length !== 1
      || resource.allowed_writers[0] !== 'VrDirect03ResolvedSemantics'
    ) {
      failures.push('resource map: direct.semantic_policy must have one writer: VrDirect03ResolvedSemantics');
    }
    if (resource.may_enter_provider_body !== false || resource.may_enter_client_body !== false) {
      failures.push('resource map: direct.semantic_policy must stay outside provider/client payload');
    }
  }

  const owner = functionMap.owners?.find(
    (entry) => entry?.feature_id === 'hub.direct_semantic_classification',
  );
  if (!owner) {
    failures.push('function map: missing hub.direct_semantic_classification');
  }

  const chain = callMap.chains?.find(
    (entry) => entry?.chain_id === 'direct.semantic_classification.mainline',
  );
  if (!chain) {
    failures.push('mainline map: missing direct.semantic_classification.mainline');
  } else {
    const expectedSteps = ['dsc-01', 'dsc-02', 'dsc-03', 'dsc-04'];
    const steps = new Map((chain.edges ?? []).map((edge) => [edge.step_id, edge]));
    for (const stepId of expectedSteps) {
      const edge = steps.get(stepId);
      if (!edge) {
        failures.push(`mainline map: missing ${stepId}`);
      } else if (
        edge.status !== 'anchored'
        || typeof edge.caller_symbol !== 'string'
        || typeof edge.callee_symbol !== 'string'
      ) {
        failures.push(`mainline map: ${stepId} must be anchored to real caller/callee symbols`);
      }
    }
    const configEdge = steps.get('dsc-01');
    if (
      configEdge?.resource_flow?.produces?.includes('direct.semantic_policy')
      || configEdge?.resource_flow?.side_channel_writes?.includes('direct.semantic_policy')
    ) {
      failures.push('mainline map: config validation must not create request-scoped direct.semantic_policy');
    }
    const resolveEdge = steps.get('dsc-02');
    if (
      !resolveEdge?.resource_flow?.produces?.includes('direct.semantic_policy')
      || !resolveEdge?.resource_flow?.side_channel_writes?.includes('direct.semantic_policy')
    ) {
      failures.push('mainline map: dsc-02 must create direct.semantic_policy after real-target resolution');
    }
  }

  for (const expected of [
    'forwarder',
    'MetadataCenter',
    'request',
    'response',
    'fail-fast',
    'JSON/SSE',
    'response projector 不依赖 request projector',
  ]) {
    requireText(failures, testDesign, expected, 'test design');
  }

  return failures;
}

const failures = verifyDirectSemanticClassificationDesign();
if (failures.length > 0) {
  console.error('[verify:direct-semantic-classification-design] failed');
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log('[verify:direct-semantic-classification-design] ok');
